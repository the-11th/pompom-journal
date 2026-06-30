"""Flask web layer for the to-do app.

This is intentionally thin: routes parse the request, call into todo.py for
all the real work, save, and redirect. State-changing routes follow the
Post/Redirect/Get pattern so a browser refresh never re-submits a form.
"""

import os
import secrets
import signal
import threading
import time
from datetime import datetime, timedelta

from flask import Flask, flash, jsonify, redirect, render_template, request, url_for

import google_health
import integrations
import journal
import rescuetime
import spotify
import todo

app = Flask(__name__)

# Needed so flask.flash() can sign the session cookie that carries flashed
# messages. A constant is fine for this small local single-user app; a real
# deployment would load a random secret from config/an environment variable
# (e.g. os.environ["SECRET_KEY"]) and never hard-code it.
app.secret_key = "local-dev-todo-pup-not-secret"

# Default data file lives in data/tasks.json, but tests override this via
# app.config["DATA_FILE"] so they can use a temp file.
app.config["DATA_FILE"] = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "data", "tasks.json"
)


def data_file():
    return app.config["DATA_FILE"]


# Journal store lives alongside tasks; tests override via JOURNAL_FILE.
app.config["JOURNAL_FILE"] = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "data", "journal.json"
)


def journal_file():
    return app.config["JOURNAL_FILE"]


# Integrations store lives alongside tasks/journal; tests override via INTEGRATIONS_FILE.
app.config["INTEGRATIONS_FILE"] = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "data", "integrations.json"
)


def integrations_file():
    return app.config["INTEGRATIONS_FILE"]


# Local single-user dev app: pick up template edits without restarting the
# server (Flask otherwise caches compiled templates when not run with --debug).
app.config["TEMPLATES_AUTO_RELOAD"] = True

# Don't let the browser cache static assets (CSS/JS): Flask defaults to a 12h
# max-age on /static, which makes style/script edits appear to "not take effect"
# until a hard refresh. Zero keeps this single-user dev app always current.
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

# Auto-quit watchdog: when AUTO_QUIT=1, the server stays alive as long as at
# least one browser tab is open and shuts down shortly after the last tab
# closes. Each tab gets a unique id and:
#   • pings GET /heartbeat?tab=<id> every 10 s. The ping runs inside a Web
#     Worker (see base.html) whose timer is NOT subject to the ~1/min throttle
#     browsers impose on hidden tabs' main-thread timers — so a backgrounded
#     (but still open) tab keeps the server alive.
#   • fires a POST /quit?tab=<id> beacon on `pagehide` so closing the tab shuts
#     the server down promptly instead of waiting for a heartbeat timeout.
#
# Because this is a server-rendered app, `pagehide` also fires on ordinary
# page-to-page navigation. To avoid quitting mid-navigation we wait a short
# grace window after the last tab leaves: the next page re-registers within that
# window and cancels the shutdown. A crashed/force-quit browser never sends a
# beacon, so a tab whose heartbeat goes stale is evicted as a fallback.
_QUIT_GRACE = 2.0     # seconds to wait after the last tab leaves before quitting
_STALE_AFTER = 60.0   # a tab silent this long is treated as gone (crash fallback)

_tab_lock = threading.Lock()
_tabs: dict[str, float] = {}        # tab_id -> last heartbeat (monotonic seconds)
_armed = False                      # True once any tab has ever registered
_empty_since: float | None = None   # monotonic time the last tab left, or None


def _now(now):
    return time.monotonic() if now is None else now


def _register_tab(tab_id, now=None):
    """Record a heartbeat from a tab (also its initial registration)."""
    global _armed, _empty_since
    now = _now(now)
    with _tab_lock:
        _tabs[tab_id] = now
        _armed = True
        _empty_since = None


def _unregister_tab(tab_id, now=None):
    """Drop a tab that fired its close beacon; start the grace clock if last."""
    global _empty_since
    now = _now(now)
    with _tab_lock:
        _tabs.pop(tab_id, None)
        if _armed and not _tabs and _empty_since is None:
            _empty_since = now


def _should_quit(now=None):
    """Decide whether the watchdog should shut the server down now.

    Evicts stale tabs (crash fallback), then returns True only when the app is
    armed, no live tabs remain, and the grace window has elapsed. Mutates the
    grace bookkeeping, so it is called from a single place (the watchdog) or
    from single-threaded tests.
    """
    global _empty_since
    now = _now(now)
    stale = [tid for tid, seen in _tabs.items() if now - seen > _STALE_AFTER]
    for tid in stale:
        del _tabs[tid]
    if not _armed:
        return False
    if _tabs:
        _empty_since = None
        return False
    if _empty_since is None:
        _empty_since = now
    return now - _empty_since >= _QUIT_GRACE


def _reset_watchdog():
    """Test helper: clear all watchdog state."""
    global _armed, _empty_since
    with _tab_lock:
        _tabs.clear()
        _armed = False
        _empty_since = None


def _watchdog():
    while True:
        time.sleep(0.5)
        with _tab_lock:
            quit_now = _should_quit()
        if quit_now:
            os.kill(os.getpid(), signal.SIGTERM)
            return


if os.environ.get("AUTO_QUIT") == "1":
    threading.Thread(target=_watchdog, daemon=True).start()


def _recurrence_from_form(form):
    """Turn the recurrence dropdown (+ custom N) into a stored value.

    The form sends `recurrence` as one of "", "daily", "weekly", "monthly",
    or "custom". For "custom" we read the `custom_n` number and build
    "every:N". Anything empty/None means non-recurring.
    """
    choice = form.get("recurrence") or ""
    if choice == "custom":
        n = (form.get("custom_n") or "").strip()
        return f"every:{n}" if n else "every:"   # invalid -> let core reject
    return choice or None


def _selected_tags(arg):
    """Parse a comma-separated tags query string into a clean list of names.

    Used for the `?tags=` filter; blanks are dropped and order preserved.
    """
    return [t.strip().lower() for t in (arg or "").split(",") if t.strip()]


def _tags_with_new(form, data):
    """Collect the task's tags from the add/edit form and register any new tag.

    Reads the `tags` checkboxes (existing tags) plus an optional `new_tag`
    name + `new_tag_color`. If a new tag name is given, its color is
    registered via set_tag_color (which validates and may raise ValueError),
    and the name is appended to the list. Returns the combined tag-name list.
    """
    tags = list(form.getlist("tags"))
    new_name = (form.get("new_tag") or "").strip()
    if new_name:
        # Validate + register the color first; this raises on a bad color or
        # name so the whole add/edit is rejected (consistent with title/due
        # handling). set_tag_color normalizes (strip+lower) the key it stores,
        # so append the SAME normalized form here -- otherwise the task could
        # carry "Urgent" while the registry key is "urgent".
        color = (form.get("new_tag_color") or "").strip()
        todo.set_tag_color(data, new_name, color)
        tags.append(new_name.lower())
    return tags


# Make the display helpers available directly inside templates.
app.jinja_env.globals["time_remaining"] = todo.time_remaining
app.jinja_env.globals["is_overdue"] = todo.is_overdue
app.jinja_env.globals["tag_color"] = todo.tag_color
app.jinja_env.globals["text_color_for"] = todo.text_color_for
app.jinja_env.globals["section_color"] = journal.section_color
app.jinja_env.globals["is_registered_tag"] = journal.is_registered_tag


@app.context_processor
def inject_section_context():
    endpoint = request.endpoint or ""
    return {"in_journal": endpoint.startswith("journal")}


@app.route("/heartbeat")
def heartbeat():
    """Keeps the auto-quit watchdog alive while a browser tab has the app open."""
    tab_id = request.args.get("tab")
    if tab_id:
        _register_tab(tab_id)
    return "", 204


@app.route("/quit", methods=["POST"])
def quit_tab():
    """Close beacon: a tab fired `pagehide`, so deregister it. When the last
    tab leaves, the watchdog shuts the server down after a short grace window."""
    tab_id = request.args.get("tab")
    if tab_id:
        _unregister_tab(tab_id)
    return "", 204


@app.route("/tag/<name>/overview")
def tag_overview(name):
    """Unified per-tag overview merging both domains (Post/Redirect/Get N/A —
    read-only JSON). Mirrors journal_analytics_data: each domain computes its
    own side, the route merges. Optional ?from=&to= inclusive date bounds are
    passed through. An unknown tag returns 200 with an empty-ish payload."""
    start = request.args.get("from") or None
    end = request.args.get("to") or None
    return jsonify({
        "name": (name or "").strip().lower(),
        "task": todo.tag_overview(todo.load(data_file()), name, start, end),
        "journal": journal.tag_overview(journal.load(journal_file()), name,
                                        start, end),
    })


@app.route("/")
def index():
    data = todo.load(data_file())
    # Optional ?tags=a,b filter (OR/union semantics via filter_by_tags).
    selected = _selected_tags(request.args.get("tags"))
    # Drop any selected tag that isn't a known registry tag. A stale/unknown
    # tag in the URL (e.g. ?tags=deleted) should behave like "no filter for
    # that tag" rather than silently filtering everything out to an empty list.
    known = data.get("tags", {})
    selected = [name for name in selected if name in known]
    tasks = todo.sort_active(data["active"])
    tasks = todo.filter_by_tags(tasks, selected)
    # Expired stays unfiltered -- it's a small "missed" log, simpler to leave
    # it always visible regardless of the active filter.
    return render_template(
        "active.html",
        tasks=tasks,
        expired=data.get("expired", []),
        all_tags=data.get("tags", {}),
        selected_tags=selected,
        data=data,
    )


@app.route("/add", methods=["POST"])
def add():
    title = request.form.get("title", "")
    due = request.form.get("due") or None
    recurrence = _recurrence_from_form(request.form)
    data = todo.load(data_file())
    try:
        # Register any new tag color first; a bad color raises and aborts.
        tags = _tags_with_new(request.form, data)
        todo.add_task(data, title, due=due, recurrence=recurrence, tags=tags)
        todo.save(data_file(), data)
    except ValueError:
        # Empty title, malformed due date, bad recurrence, or bad tag
        # name/color -> nothing is saved; tell the user why via a flash.
        flash("Could not add task: check the title, due date, and tags.")
    return redirect(url_for("index"))


@app.route("/edit/<task_id>", methods=["GET"])
def edit(task_id):
    data = todo.load(data_file())
    task = next((t for t in data["active"] if t["id"] == task_id), None)
    if task is None:
        return redirect(url_for("index"))
    return render_template(
        "edit.html", task=task, all_tags=data.get("tags", {}), data=data
    )


@app.route("/edit/<task_id>", methods=["POST"])
def edit_post(task_id):
    title = request.form.get("title", "")
    due = request.form.get("due") or None
    recurrence = _recurrence_from_form(request.form)
    data = todo.load(data_file())
    try:
        tags = _tags_with_new(request.form, data)
        todo.edit_task(data, task_id, title, due=due,
                       recurrence=recurrence, tags=tags)
        todo.save(data_file(), data)
    except ValueError:
        # Validation error (incl. bad tag name/color) -> nothing saved.
        flash("Could not save changes: check the title, due date, and tags.")
    return redirect(url_for("index"))


@app.route("/refresh", methods=["POST"])
def refresh():
    completed_ids = request.form.getlist("completed")
    # Optional per-task difficulty radios: difficulty:<id> = easy|medium|hard.
    difficulties = {tid: request.form.get("difficulty:" + tid)
                    for tid in completed_ids}
    data = todo.load(data_file())
    todo.refresh(data, completed_ids, difficulties=difficulties)
    todo.save(data_file(), data)
    return redirect(url_for("index"))


@app.route("/delete/<task_id>", methods=["POST"])
def delete(task_id):
    data = todo.load(data_file())
    todo.delete_task(data, task_id)
    todo.save(data_file(), data)
    # Send the user back where they came from (Active or Archive).
    return redirect(request.referrer or url_for("index"))


@app.route("/archive")
def archive():
    data = todo.load(data_file())
    # Optional ?tags=a,b filter, parsed + normalized exactly like the index
    # route. Unknown/stale tags are dropped so they behave like "no filter".
    selected = _selected_tags(request.args.get("tags"))
    known = data.get("tags", {})
    selected = [name for name in selected if name in known]
    tasks = todo.filter_by_tags(data["archive"], selected)
    return render_template(
        "archive.html",
        tasks=tasks,
        all_tags=data.get("tags", {}),
        selected_tags=selected,
        data=data,
    )


@app.route("/archive/<task_id>/difficulty", methods=["POST"])
def set_task_difficulty(task_id):
    data = todo.load(data_file())
    todo.set_difficulty(data, task_id, request.form.get("difficulty", ""))
    todo.save(data_file(), data)
    return redirect(url_for("archive"))


# --------------------------------------------------------------------------- #
# Task notes + subtasks (AJAX/JSON endpoints; not Post/Redirect/Get).
# Each mutating route loads, calls the pure function, saves, and returns the
# updated slice as JSON so the client can re-render in place.
# --------------------------------------------------------------------------- #

def _find_active(data, task_id):
    return next((t for t in data["active"] if t["id"] == task_id), None)


@app.route("/task/<task_id>/notes", methods=["POST"])
def task_notes(task_id):
    data = todo.load(data_file())
    if _find_active(data, task_id) is None:
        return jsonify({"error": "unknown task"}), 404
    text = (request.get_json(silent=True) or {}).get("text", "")
    todo.set_task_notes(data, task_id, text)
    todo.save(data_file(), data)
    return jsonify({"notes": _find_active(data, task_id)["notes"]})


@app.route("/task/<task_id>/subtasks", methods=["POST"])
def task_add_subtask(task_id):
    data = todo.load(data_file())
    if _find_active(data, task_id) is None:
        return jsonify({"error": "unknown task"}), 404
    text = (request.get_json(silent=True) or {}).get("text", "")
    try:
        todo.add_subtask(data, task_id, text)
    except ValueError:
        return jsonify({"error": "subtask text must not be empty"}), 400
    todo.save(data_file(), data)
    return jsonify({"subtasks": _find_active(data, task_id)["subtasks"]})


@app.route("/task/<task_id>/subtasks/<int:index>/toggle", methods=["POST"])
def task_toggle_subtask(task_id, index):
    data = todo.load(data_file())
    task = _find_active(data, task_id)
    if task is None:
        return jsonify({"error": "unknown task"}), 404
    if not (0 <= index < len(task.get("subtasks") or [])):
        return jsonify({"error": "subtask index out of range"}), 404
    todo.toggle_subtask(data, task_id, index)
    todo.save(data_file(), data)
    return jsonify({"subtasks": _find_active(data, task_id)["subtasks"]})


@app.route("/task/<task_id>/subtasks/<int:index>", methods=["POST"])
def task_edit_subtask(task_id, index):
    data = todo.load(data_file())
    task = _find_active(data, task_id)
    if task is None:
        return jsonify({"error": "unknown task"}), 404
    if not (0 <= index < len(task.get("subtasks") or [])):
        return jsonify({"error": "subtask index out of range"}), 404
    text = (request.get_json(silent=True) or {}).get("text", "")
    try:
        todo.edit_subtask(data, task_id, index, text)
    except ValueError:
        return jsonify({"error": "subtask text must not be empty"}), 400
    todo.save(data_file(), data)
    return jsonify({"subtasks": _find_active(data, task_id)["subtasks"]})


@app.route("/task/<task_id>/subtasks/<int:index>/delete", methods=["POST"])
def task_delete_subtask(task_id, index):
    data = todo.load(data_file())
    task = _find_active(data, task_id)
    if task is None:
        return jsonify({"error": "unknown task"}), 404
    if not (0 <= index < len(task.get("subtasks") or [])):
        return jsonify({"error": "subtask index out of range"}), 404
    todo.delete_subtask(data, task_id, index)
    todo.save(data_file(), data)
    return jsonify({"subtasks": _find_active(data, task_id)["subtasks"]})


@app.route("/tags", methods=["GET"])
def tags():
    data = todo.load(data_file())
    return render_template("tags.html", all_tags=data.get("tags", {}))


@app.route("/tags", methods=["POST"])
def tags_post():
    name = request.form.get("name", "")
    color = (request.form.get("color") or "").strip()
    data = todo.load(data_file())
    # This page only EDITS colors of tags that already exist. Tags are created
    # via the add/edit task forms, never here -- so refuse a name that isn't
    # already a registry key (prevents spurious entries from a crafted POST).
    normalized = (name or "").strip().lower()
    if normalized not in data.get("tags", {}):
        flash("Unknown tag -- colors can only be changed for existing tags.")
        return redirect(url_for("tags"))
    try:
        todo.set_tag_color(data, name, color)
        todo.save(data_file(), data)
    except ValueError:
        # Invalid color/name -> redirect back without changing anything.
        flash("Could not update tag color: please pick a valid color.")
    return redirect(url_for("tags"))


@app.route("/tags/<name>/delete", methods=["POST"])
def tag_delete(name):
    data = todo.load(data_file())
    todo.delete_tag(data, name)
    todo.save(data_file(), data)
    flash("Tag deleted.")
    return redirect(url_for("tags"))


def _mention_index(data):
    """{name: {"section_id": ..., "color": ...}} for client-side mention
    coloring. Built from journal.tag_section_index + each section's color."""
    return {
        name: {"section_id": sid, "color": journal.section_color(data, sid)}
        for name, sid in journal.tag_section_index(data).items()
    }


def _render_entry(data, date):
    istore = integrations.load(integrations_file())
    entry = journal.get_entry_by_date(data, date)
    return render_template(
        "journal_entry.html", data=data,
        entry=entry,
        date=date, sections=journal.active_sections(data),
        entry_dates=journal.entry_dates(data),
        mention_index=_mention_index(data),
        google_connected=integrations.is_connected(istore, "google"),
        google_last_sync=integrations.last_sync(istore, "google"),
        sleep=(entry or {}).get("sleep"),
        rescuetime_connected=integrations.is_connected(istore, "rescuetime"),
        rescuetime_last_sync=integrations.last_sync(istore, "rescuetime"),
        rescuetime=(entry or {}).get("rescuetime"),
        spotify_connected=integrations.is_connected(istore, "spotify"),
        spotify_last_sync=integrations.last_sync(istore, "spotify"),
        music=(entry or {}).get("music"),
    )


@app.route("/journal")
def journal_today():
    data = journal.load(journal_file())
    today = journal.today_iso()
    return _render_entry(data, today)


@app.route("/journal/<date>")
def journal_entry(date):
    data = journal.load(journal_file())
    if not journal._valid_date(date):
        return redirect(url_for("journal_today"))
    return _render_entry(data, date)


@app.route("/journal/analytics")
def journal_analytics():
    """The analytics dashboard shell. Data is fetched client-side from
    /journal/analytics/data, so no data is passed to the template."""
    return render_template("journal_analytics.html")


@app.route("/journal/analytics/data")
def journal_analytics_data():
    """JSON feed for the analytics charts (journal + tasks). Fetched on load and
    on window focus; the client filters by date and renders."""
    payload = journal.analytics_payload(journal.load(journal_file()))
    payload["tasks"] = todo.task_payload(todo.load(data_file()))
    # Widen the shared date range so the date filter spans both domains.
    jr, tr = payload["date_range"], payload["tasks"]["date_range"]
    mins = [d for d in (jr.get("min"), tr.get("min")) if d]
    maxs = [d for d in (jr.get("max"), tr.get("max")) if d]
    payload["date_range"] = {"min": min(mins) if mins else None,
                             "max": max(maxs) if maxs else None}
    return jsonify(payload)


@app.route("/journal/suggestions/<word>")
def journal_suggestion_detail(word):
    """Feed the apply popup: active tag sections + windowed occurrences of a
    suggested word. Returns 200 with empty lists for an unknown/known word."""
    data = journal.load(journal_file())
    sections = [
        {"id": s["id"], "name": s["name"], "color": s["color"]}
        for s in journal.active_sections(data) if s.get("type") == "tag"
    ]
    return jsonify({
        "word": (word or "").strip().lower(),
        "sections": sections,
        "occurrences": journal.suggestion_occurrences(data, word),
    })


@app.route("/journal/suggestions/<word>/apply", methods=["POST"])
def journal_suggestion_apply(word):
    """Apply a suggested tag to selected days. JSON-driven (no PRG)."""
    section_id = (request.form.get("section_id") or "").strip()
    kind = (request.form.get("kind") or "").strip()
    dates = request.form.getlist("dates")
    if len(dates) == 1 and "," in dates[0]:
        dates = [d.strip() for d in dates[0].split(",") if d.strip()]
    dates = [d for d in (d.strip() for d in dates) if d]
    if not section_id or journal.section_by_id(
            journal.load(journal_file()), section_id) is None:
        return jsonify({"ok": False, "error": "unknown section"}), 400
    if not dates:
        return jsonify({"ok": False, "error": "no dates selected"}), 400
    data = journal.load(journal_file())
    try:
        journal.apply_tag_suggestion(
            data, word, section_id, dates, permanent=(kind == "permanent"))
        journal.save(journal_file(), data)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    return jsonify({"ok": True})


@app.route("/journal/suggestions/<word>/dismiss", methods=["POST"])
def journal_suggestion_dismiss(word):
    """Suppress a suggested word for the 30-day cooldown."""
    data = journal.load(journal_file())
    journal.dismiss_suggestion(data, word)
    journal.save(journal_file(), data)
    return jsonify({"ok": True})


def _collect_entry_fields(form, data):
    """Build {section_id: [tags]} and {section_id: value} from the form.

    As a side effect, registers any new 'permanent' tags on their section in
    the data store (mirroring how _tags_with_new works for tasks). Only active
    sections are read here."""
    tags, numbers = {}, {}
    for s in journal.active_sections(data):
        sid = s["id"]
        if s["type"] == "tag":
            selected = list(form.getlist(f"tag:{sid}"))
            new_name = (form.get(f"newtag-name:{sid}") or "").strip()
            if new_name:
                if form.get(f"newtag-kind:{sid}") == "permanent":
                    journal.add_section_tag(data, sid, new_name)  # may raise
                selected.append(new_name)
            if selected:
                tags[sid] = selected
        else:
            raw = (form.get(f"num:{sid}") or "").strip()
            if raw != "":
                numbers[sid] = raw
    return tags, numbers


@app.route("/journal/save", methods=["POST"])
def journal_save():
    date = (request.form.get("date") or "").strip()
    title = request.form.get("title", "")
    body = request.form.get("body", "")
    if not journal._valid_date(date):
        flash("Could not save entry: please pick a valid date.")
        return redirect(url_for("journal_today"))
    if not title.strip():
        flash("Could not save entry: a title is required.")
        return redirect(url_for("journal_entry", date=date))
    mood_raw = request.form.get("mood", "").strip()
    mood = mood_raw or None   # "" -> None; otherwise let upsert_entry validate
    data = journal.load(journal_file())
    # Preserve any data on archived sections (not shown on the form).
    existing = journal.get_entry_by_date(data, date)
    base_tags = dict(existing["tags"]) if existing else {}
    base_numbers = dict(existing["numbers"]) if existing else {}
    try:
        parsed_tags, parsed_numbers = _collect_entry_fields(request.form, data)
        for s in journal.active_sections(data):
            sid = s["id"]
            if s["type"] == "tag":
                base_tags.pop(sid, None)
                if sid in parsed_tags:
                    base_tags[sid] = parsed_tags[sid]
            else:
                base_numbers.pop(sid, None)
                if sid in parsed_numbers:
                    base_numbers[sid] = parsed_numbers[sid]
        # Union in @mentions from the body (purely additive, non-destructive).
        idx = journal.tag_section_index(data)
        mentions = journal.extract_mentions(body, idx)
        base_tags = journal.merge_entry_tags(base_tags, mentions)
        journal.upsert_entry(data, date, title, body,
                             tags=base_tags, numbers=base_numbers, mood=mood)
        journal.save(journal_file(), data)
    except ValueError:
        flash("Could not save entry: check the date, title, tags, and numbers.")
        return redirect(url_for("journal_entry", date=date) if journal._valid_date(date)
                        else url_for("journal_today"))
    return redirect(url_for("journal_entry", date=date))


@app.route("/journal/entry/<entry_id>/move", methods=["POST"])
def journal_entry_move(entry_id):
    new_date = (request.form.get("date") or "").strip()
    data = journal.load(journal_file())
    # Look up the entry's current date for the fallback redirect.
    existing = next((e for e in data.get("entries", []) if e.get("id") == entry_id), None)
    current_date = existing["date"] if existing else None
    try:
        journal.move_entry(data, entry_id, new_date)
        journal.save(journal_file(), data)
        return redirect(url_for("journal_entry", date=new_date))
    except ValueError:
        flash("Could not move entry: that day already has an entry.")
        fallback = current_date or journal.today_iso()
        return redirect(url_for("journal_entry", date=fallback))


@app.route("/journal/search")
def journal_search():
    data = journal.load(journal_file())
    return render_template(
        "journal_search.html", data=data,
        entries=journal.search_index(data),
        tag_sections=[s for s in journal.active_sections(data) if s["type"] == "tag"],
        num_sections=[s for s in journal.active_sections(data) if s["type"] == "numeric"],
        bounds=journal.numeric_bounds(data),
    )


@app.route("/journal/entry/<entry_id>/delete", methods=["POST"])
def journal_entry_delete(entry_id):
    data = journal.load(journal_file())
    journal.delete_entry(data, entry_id)
    journal.save(journal_file(), data)
    flash("Entry deleted.")
    return redirect(url_for("journal_search"))


@app.route("/journal/sections")
def journal_sections():
    data = journal.load(journal_file())
    return render_template("journal_sections.html", data=data,
                           sections=journal.active_sections(data),
                           temporary_tags=journal.temporary_tags(data),
                           suggestions=journal.tag_suggestions(data, limit=8),
                           dormant=journal.dormant_tags(data),
                           **_integrations_context())


@app.route("/journal/sections/archive")
def journal_sections_archive():
    data = journal.load(journal_file())
    archived = journal.archived_sections(data)
    sections_with_archived_tags = [
        s for s in journal.active_sections(data)
        if s.get("archived_tags")
    ]
    return render_template(
        "journal_sections_archive.html",
        archived_sections=archived,
        sections_with_archived_tags=sections_with_archived_tags,
    )


@app.route("/journal/sections/<section_id>/restore", methods=["POST"])
def journal_section_restore(section_id):
    data = journal.load(journal_file())
    try:
        journal.restore_section(data, section_id)
        journal.save(journal_file(), data)
    except ValueError:
        flash("Could not restore section: an active section with that name already exists.")
    return redirect(url_for("journal_sections_archive"))


@app.route("/journal/sections/<section_id>/tags/<tag>/restore", methods=["POST"])
def journal_section_tag_restore(section_id, tag):
    data = journal.load(journal_file())
    journal.restore_section_tag(data, section_id, tag)
    journal.save(journal_file(), data)
    return redirect(url_for("journal_sections_archive"))


@app.route("/journal/sections/add", methods=["POST"])
def journal_sections_add():
    data = journal.load(journal_file())
    try:
        journal.add_section(
            data,
            request.form.get("name", ""),
            request.form.get("type", "tag"),
            (request.form.get("color") or "").strip(),
            unit=request.form.get("unit", ""),
        )
        journal.save(journal_file(), data)
    except ValueError:
        flash("Could not add section: check the name, type, and color.")
    return redirect(url_for("journal_sections"))


@app.route("/journal/sections/<section_id>/edit", methods=["POST"])
def journal_section_edit(section_id):
    data = journal.load(journal_file())
    try:
        journal.rename_section(data, section_id, request.form.get("name", ""))
        journal.set_section_color(data, section_id, (request.form.get("color") or "").strip())
        if journal.section_by_id(data, section_id) and \
                journal.section_by_id(data, section_id).get("type") == "numeric":
            journal.set_section_unit(data, section_id, request.form.get("unit", ""))
        journal.save(journal_file(), data)
    except ValueError:
        flash("Could not update section: check the name and color.")
    return redirect(url_for("journal_sections"))


@app.route("/journal/sections/<section_id>/delete", methods=["POST"])
def journal_section_delete(section_id):
    data = journal.load(journal_file())
    journal.archive_section(data, section_id)
    journal.save(journal_file(), data)
    flash("Section archived.")
    return redirect(url_for("journal_sections"))


@app.route("/journal/sections/<section_id>/tags", methods=["POST"])
def journal_section_tag_add(section_id):
    data = journal.load(journal_file())
    try:
        journal.add_section_tag(data, section_id, request.form.get("tag", ""))
        journal.save(journal_file(), data)
    except ValueError:
        flash("Could not add tag: check the name.")
    return redirect(url_for("journal_sections"))


@app.route("/journal/sections/<section_id>/tags/<tag>/delete", methods=["POST"])
def journal_section_tag_remove(section_id, tag):
    data = journal.load(journal_file())
    journal.remove_section_tag(data, section_id, tag)
    journal.save(journal_file(), data)
    return redirect(url_for("journal_sections"))


@app.route("/journal/sections/<section_id>/tags/<tag>/promote", methods=["POST"])
def journal_section_tag_promote(section_id, tag):
    """Promote a temporary (entry-only) tag into the section's permanent list."""
    data = journal.load(journal_file())
    try:
        journal.add_section_tag(data, section_id, tag)
        journal.save(journal_file(), data)
    except ValueError:
        flash("Could not promote tag: check the name.")
    return redirect(url_for("journal_sections"))


@app.route("/journal/sections/<section_id>/tags/<tag>/demote", methods=["POST"])
def journal_section_tag_demote(section_id, tag):
    """Demote a permanent tag (drop into the Temporary zone). Removes it from the
    master list; re-derived as temporary if still on entries, else archived."""
    data = journal.load(journal_file())
    journal.demote_section_tag(data, section_id, tag)
    journal.save(journal_file(), data)
    return redirect(url_for("journal_sections"))


@app.route("/journal/sections/<section_id>/tags/<tag>/archive-temp", methods=["POST"])
def journal_section_tag_archive_temp(section_id, tag):
    """Archive a temporary (entry-only) tag so it stops being derived as one."""
    data = journal.load(journal_file())
    journal.archive_temporary_tag(data, section_id, tag)
    journal.save(journal_file(), data)
    return redirect(url_for("journal_sections"))


def _recent_dates(days, now=None):
    today = (now or datetime.now()).date()
    return [(today - timedelta(days=i)).isoformat() for i in range(days)]


def _google_sync(days=7, force=False, focus_date=None, now=None):
    istore = integrations.load(integrations_file())
    if not integrations.is_connected(istore, "google"):
        return {"connected": False, "synced": [], "errors": []}
    gh = integrations.get_provider(istore, "google")
    tokens = gh["tokens"]
    cid, csecret = gh.get("client_id"), gh.get("client_secret")

    if google_health.token_expired(tokens) and tokens.get("refresh_token") and cid:
        try:
            tokens = google_health.refresh_tokens(cid, csecret, tokens["refresh_token"], prev=tokens)
            integrations.set_tokens(istore, "google", tokens)
        except Exception:  # noqa: BLE001
            pass

    jdata = journal.load(journal_file())
    synced, errors = [], []
    for date in _recent_dates(days, now=now):
        existing = journal.get_entry_by_date(jdata, date)
        if not force and existing is not None and existing.get("sleep"):
            continue
        try:
            try:
                raw = google_health.fetch_sleep(tokens["access_token"], date)
            except PermissionError:
                if cid and tokens.get("refresh_token"):
                    tokens = google_health.refresh_tokens(cid, csecret, tokens["refresh_token"], prev=tokens)
                    integrations.set_tokens(istore, "google", tokens)
                    raw = google_health.fetch_sleep(tokens["access_token"], date)
                else:
                    raise
            sleep = google_health.parse_sleep(raw)
            if sleep:
                journal.set_entry_sleep(jdata, date, sleep)
                synced.append(date)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{date}: {exc}")

    journal.save(journal_file(), jdata)
    integrations.set_last_sync(istore, "google",
                               (now or datetime.now()).replace(microsecond=0).isoformat())
    integrations.save(integrations_file(), istore)
    return {"connected": True, "synced": synced, "errors": errors}


@app.route("/integrations/google/sync", methods=["POST"])
def google_sync_route():
    days = request.args.get("days", type=int) or 7
    focus = request.args.get("date")
    result = _google_sync(days=days, focus_date=focus)
    sleep = {}
    if focus and result["connected"]:
        entry = journal.get_entry_by_date(journal.load(journal_file()), focus)
        sleep = {focus: (entry or {}).get("sleep")}
    return jsonify({"ok": True, **result, "sleep": sleep})


def _google_redirect_uri():
    return url_for("google_callback", _external=True)


def _integrations_context():
    """Template vars for the integration provider cards (rendered as the
    Integrations section on the journal Manage page)."""
    data = integrations.load(integrations_file())
    gh = integrations.get_provider(data, "google")
    sp = integrations.get_provider(data, "spotify")
    return dict(
        google_connected=integrations.is_connected(data, "google"),
        google_has_creds=bool(gh.get("client_id") and gh.get("client_secret")),
        google_client_id=gh.get("client_id", ""),
        google_last_sync=integrations.last_sync(data, "google"),
        google_redirect_uri=_google_redirect_uri(),
        rescuetime_connected=integrations.is_connected(data, "rescuetime"),
        rescuetime_last_sync=integrations.last_sync(data, "rescuetime"),
        spotify_connected=integrations.is_connected(data, "spotify"),
        spotify_has_creds=bool(sp.get("client_id") and sp.get("client_secret")),
        spotify_client_id=sp.get("client_id", ""),
        spotify_last_sync=integrations.last_sync(data, "spotify"),
        spotify_redirect_uri=_spotify_redirect_uri(),
    )


@app.route("/integrations")
def integrations_page():
    # The integrations UI now lives as a section on the journal Manage page;
    # keep this route as a redirect so existing links/bookmarks still work.
    return redirect(url_for("journal_sections") + "#sec-integrations")


@app.route("/integrations/google/credentials", methods=["POST"])
def google_credentials():
    data = integrations.load(integrations_file())
    integrations.set_credentials(
        data, "google",
        request.form.get("client_id", "").strip(),
        request.form.get("client_secret", "").strip())
    integrations.save(integrations_file(), data)
    flash("Google Health credentials saved.")
    return redirect(url_for("integrations_page"))


@app.route("/integrations/google/connect")
def google_connect():
    data = integrations.load(integrations_file())
    gh = integrations.get_provider(data, "google")
    if not (gh.get("client_id") and gh.get("client_secret")):
        flash("Enter your Google Client ID and Secret first.")
        return redirect(url_for("integrations_page"))
    state = secrets.token_urlsafe(16)
    gh["oauth_state"] = state
    integrations.save(integrations_file(), data)
    url = google_health.build_authorize_url(
        gh["client_id"], _google_redirect_uri(), state)
    return redirect(url)


@app.route("/integrations/google/callback")
def google_callback():
    data = integrations.load(integrations_file())
    gh = integrations.get_provider(data, "google")
    if request.args.get("error"):
        flash(f"Google authorization failed: {request.args.get('error')}")
        return redirect(url_for("integrations_page"))
    if not request.args.get("state") or request.args.get("state") != gh.get("oauth_state"):
        flash("Google authorization state mismatch; please try again.")
        return redirect(url_for("integrations_page"))
    try:
        tokens = google_health.exchange_code(
            gh["client_id"], gh["client_secret"],
            request.args.get("code"), _google_redirect_uri())
    except Exception as exc:  # noqa: BLE001 - surface as a flash, never 500
        flash(f"Google Health connection failed: {exc}")
        return redirect(url_for("integrations_page"))
    integrations.set_tokens(data, "google", tokens)
    gh.pop("oauth_state", None)
    integrations.save(integrations_file(), data)
    _google_sync(days=30)  # one-time backfill
    flash("Google Health connected. Sleep data backfilled.")
    return redirect(url_for("integrations_page"))


@app.route("/integrations/google/disconnect", methods=["POST"])
def google_disconnect():
    data = integrations.load(integrations_file())
    integrations.clear_provider(data, "google")
    integrations.save(integrations_file(), data)
    flash("Google Health disconnected.")
    return redirect(url_for("integrations_page"))


def _spotify_sync(force=False, focus_date=None, now=None):
    istore = integrations.load(integrations_file())
    if not integrations.is_connected(istore, "spotify"):
        return {"connected": False, "synced": [], "errors": []}
    sp = integrations.get_provider(istore, "spotify")
    tokens = sp["tokens"]
    cid, csecret = sp.get("client_id"), sp.get("client_secret")
    errors = []

    if spotify.token_expired(tokens) and tokens.get("refresh_token") and cid:
        try:
            tokens = spotify.refresh_tokens(cid, csecret, tokens["refresh_token"])
            integrations.set_tokens(istore, "spotify", tokens)
        except Exception:  # noqa: BLE001
            pass

    def _recent():
        try:
            return spotify.fetch_recently_played(tokens["access_token"])
        except PermissionError:
            if cid and tokens.get("refresh_token"):
                new = spotify.refresh_tokens(cid, csecret, tokens["refresh_token"])
                tokens.update(new)
                integrations.set_tokens(istore, "spotify", tokens)
                return spotify.fetch_recently_played(tokens["access_token"])
            raise

    jdata = journal.load(journal_file())
    synced = []
    try:
        plays = spotify.parse_recently_played(_recent())
        buffer = spotify.merge_plays(
            integrations.get_plays_buffer(istore, "spotify"), plays, now=now)
        integrations.set_plays_buffer(istore, "spotify", buffer)
        for date, by_ts in buffer.items():
            day_plays = list(by_ts.values())
            ids = [p["track_id"] for p in day_plays if p.get("track_id")]
            try:
                feats = spotify.fetch_audio_features(tokens["access_token"], ids)
            except Exception as exc:  # noqa: BLE001
                feats, _ = None, errors.append(f"features {date}: {exc}")
            journal.set_entry_music(jdata, date, spotify.summarize_day(day_plays, feats, now=now))
            synced.append(date)
        journal.save(journal_file(), jdata)
    except Exception as exc:  # noqa: BLE001
        errors.append(str(exc))

    # Taste snapshot (best-effort).
    try:
        terms = ("short_term", "medium_term", "long_term")
        tops = {"tracks": {}, "artists": {}}
        for kind in ("tracks", "artists"):
            for term in terms:
                tops[kind][term] = spotify.fetch_top(tokens["access_token"], kind, term)
        integrations.set_taste(istore, "spotify", spotify.build_taste(tops, now=now))
    except Exception as exc:  # noqa: BLE001
        errors.append(f"taste: {exc}")

    integrations.set_last_sync(istore, "spotify",
                               (now or datetime.now()).replace(microsecond=0).isoformat())
    integrations.save(integrations_file(), istore)
    return {"connected": True, "synced": synced, "errors": errors}


@app.route("/integrations/spotify/sync", methods=["POST"])
def spotify_sync_route():
    focus = request.args.get("date")
    result = _spotify_sync(focus_date=focus)
    music = {}
    if focus and result["connected"]:
        entry = journal.get_entry_by_date(journal.load(journal_file()), focus)
        music = {focus: (entry or {}).get("music")}
    return jsonify({"ok": True, **result, "music": music})


def _spotify_redirect_uri():
    return url_for("spotify_callback", _external=True)


@app.route("/integrations/spotify/credentials", methods=["POST"])
def spotify_credentials():
    data = integrations.load(integrations_file())
    integrations.set_credentials(
        data, "spotify",
        request.form.get("client_id", "").strip(),
        request.form.get("client_secret", "").strip())
    integrations.save(integrations_file(), data)
    flash("Spotify credentials saved.")
    return redirect(url_for("integrations_page"))


@app.route("/integrations/spotify/connect")
def spotify_connect():
    data = integrations.load(integrations_file())
    sp = integrations.get_provider(data, "spotify")
    if not (sp.get("client_id") and sp.get("client_secret")):
        flash("Enter your Spotify Client ID and Secret first.")
        return redirect(url_for("integrations_page"))
    state = secrets.token_urlsafe(16)
    sp["oauth_state"] = state
    integrations.save(integrations_file(), data)
    return redirect(spotify.build_authorize_url(sp["client_id"], _spotify_redirect_uri(), state))


@app.route("/integrations/spotify/callback")
def spotify_callback():
    data = integrations.load(integrations_file())
    sp = integrations.get_provider(data, "spotify")
    if request.args.get("error"):
        flash(f"Spotify authorization failed: {request.args.get('error')}")
        return redirect(url_for("integrations_page"))
    if not request.args.get("state") or request.args.get("state") != sp.get("oauth_state"):
        flash("Spotify authorization state mismatch; please try again.")
        return redirect(url_for("integrations_page"))
    try:
        tokens = spotify.exchange_code(
            sp["client_id"], sp["client_secret"],
            request.args.get("code"), _spotify_redirect_uri())
    except Exception as exc:  # noqa: BLE001
        flash(f"Spotify connection failed: {exc}")
        return redirect(url_for("integrations_page"))
    integrations.set_tokens(data, "spotify", tokens)
    sp.pop("oauth_state", None)
    integrations.save(integrations_file(), data)
    _spotify_sync()
    flash("Spotify connected.")
    return redirect(url_for("integrations_page"))


@app.route("/integrations/spotify/disconnect", methods=["POST"])
def spotify_disconnect():
    data = integrations.load(integrations_file())
    integrations.clear_provider(data, "spotify")
    integrations.save(integrations_file(), data)
    flash("Spotify disconnected.")
    return redirect(url_for("integrations_page"))


@app.route("/integrations/spotify/taste")
def spotify_taste():
    data = integrations.load(integrations_file())
    return jsonify(integrations.get_taste(data, "spotify") or {})


@app.route("/integrations/rescuetime/key", methods=["POST"])
def rescuetime_key():
    data = integrations.load(integrations_file())
    integrations.set_api_key(data, "rescuetime", request.form.get("api_key", "").strip())
    integrations.save(integrations_file(), data)
    flash("RescueTime API key saved.")
    return redirect(url_for("integrations_page"))


@app.route("/integrations/rescuetime/disconnect", methods=["POST"])
def rescuetime_disconnect():
    data = integrations.load(integrations_file())
    integrations.clear_provider(data, "rescuetime")
    integrations.save(integrations_file(), data)
    flash("RescueTime disconnected.")
    return redirect(url_for("integrations_page"))


def _rescuetime_sync(force=False, focus_date=None, now=None):
    istore = integrations.load(integrations_file())
    if not integrations.is_connected(istore, "rescuetime"):
        return {"connected": False, "synced": [], "errors": []}
    key = integrations.get_provider(istore, "rescuetime").get("api_key")
    jdata = journal.load(journal_file())
    synced, errors = [], []
    try:
        rows = rescuetime.fetch_daily_summary(key)
    except Exception as exc:  # noqa: BLE001
        return {"connected": True, "synced": [], "errors": [str(exc)]}
    for row in rows:
        try:
            day = rescuetime.parse_day(row, now=now)
            date = day.get("date")
            if not date:
                continue
            existing = journal.get_entry_by_date(jdata, date)
            if not force and existing is not None and existing.get("rescuetime"):
                continue
            journal.set_entry_rescuetime(jdata, date, day)
            synced.append(date)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{row.get('date')}: {exc}")
    journal.save(journal_file(), jdata)
    integrations.set_last_sync(istore, "rescuetime",
                               (now or datetime.now()).replace(microsecond=0).isoformat())
    integrations.save(integrations_file(), istore)
    return {"connected": True, "synced": synced, "errors": errors}


@app.route("/integrations/rescuetime/sync", methods=["POST"])
def rescuetime_sync_route():
    focus = request.args.get("date")
    result = _rescuetime_sync(focus_date=focus)
    data = {}
    if focus and result["connected"]:
        entry = journal.get_entry_by_date(journal.load(journal_file()), focus)
        data = {focus: (entry or {}).get("rescuetime")}
    return jsonify({"ok": True, **result, "data": data})


if __name__ == "__main__":
    app.run(debug=True)
