"""Flask web layer for the to-do app.

This is intentionally thin: routes parse the request, call into todo.py for
all the real work, save, and redirect. State-changing routes follow the
Post/Redirect/Get pattern so a browser refresh never re-submits a form.
"""

import os
import json
import secrets
import signal
import threading
import time
from contextlib import nullcontext
from copy import deepcopy
from datetime import datetime, timedelta
from functools import wraps
from urllib.parse import urlencode

from flask import (Flask, flash, jsonify, redirect, render_template, request,
                   session, url_for, g)

from integrations import google_health
from integrations import health
from integrations import store as integrations
import journal
from integrations import music_history
import places
from integrations import provider_sync
from integrations import rescuetime
from integrations import spotify
import todo
from integrations import usage

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


_mobile_lock = threading.RLock()
_provider_sync_locks = {name: threading.RLock() for name in ('google', 'rescuetime', 'spotify')}


@app.before_request
def _serialize_store_transactions():
    # Old form routes, integrations, and new autosaves must share a transaction
    # boundary. Atomic replacement alone cannot prevent a lost update between
    # concurrent load/modify/save sequences. Binary streams and the independently
    # locked Discord pull do not hold up journal work.
    if request.endpoint in {'static', 'heartbeat', 'quit', 'media_file_web',
                            'media_file_mobile', 'media_map_file', 'mobile_map_file',
                            'discord_pull', 'google_sync_route', 'rescuetime_sync_route', 'spotify_sync_route',
                            'spotify_analytics', 'rescuetime_detail'}:
        return
    _mobile_lock.acquire()
    g.todopup_store_locked = True


@app.teardown_request
def _release_store_transaction(error=None):
    if g.pop('todopup_store_locked', False):
        _mobile_lock.release()



def _mobile_error(code, message, status=400, **extra):
    body = {"ok": False, "error": {"code": code, "message": message}, **extra}
    return jsonify(body), status


def _mobile_authenticated(view):
    """Authenticate a distinct per-device mobile bearer token."""
    @wraps(view)
    def wrapped(*args, **kwargs):
        # Waitress is threaded. Keep each authenticated mobile request's auth,
        # idempotency receipt, and JSON load-modify-save sequence ordered so two
        # WorkManager retries cannot race one another inside this process.
        with _mobile_lock:
            header = request.headers.get("Authorization", "")
            token = header[7:].strip() if header.lower().startswith("bearer ") else ""
            store = integrations.load(integrations_file())
            device = integrations.authenticate_mobile_device(store, token) if token else None
            if device is None:
                return _mobile_error("unauthorized", "A valid mobile device token is required", 401)
            integrations.save(integrations_file(), store)
            return view(device, *args, **kwargs)
    return wrapped


def _mobile_payload():
    payload = request.get_json(silent=True)
    return payload if isinstance(payload, dict) else None


def _mobile_cached(device, payload):
    request_id = payload.get("request_id") if payload else None
    if not isinstance(request_id, str) or not request_id.strip():
        return None, _mobile_error(
            "validation_error", "request_id is required for mobile writes", 400)
    store = integrations.load(integrations_file())
    receipt = integrations.mobile_request_receipt(store, device["id"], request_id)
    if receipt:
        return request_id, (jsonify(receipt["body"]), receipt["status"])
    return request_id, None


def _mobile_remember(device, request_id, status, body):
    store = integrations.load(integrations_file())
    integrations.remember_mobile_request(
        store, device["id"], request_id, status, body)
    integrations.save(integrations_file(), store)


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
    return {"in_journal": endpoint.startswith("journal") or request.path.startswith("/journal/")}


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
        completed=todo.filter_by_tags(data["archive"], selected),
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
    return _task_page_redirect(data)


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
    return _task_page_redirect(data, default="archive", history=True)


def _task_page_redirect(data, default="index", history=False):
    """Allowlisted task destination and known filter values after a form POST."""
    endpoint = "index" if request.form.get("return_to") == "tasks" else default
    selected = [name for name in _selected_tags(request.form.get("tags"))
                if name in data.get("tags", {})]
    values = {"tags": ",".join(selected)} if selected else {}
    if history and endpoint == "index":
        values["_anchor"] = "completed-tasks"
    return redirect(url_for(endpoint, **values))


@app.route("/task/<task_id>/reopen", methods=["POST"])
def reopen_task(task_id):
    data = todo.load(data_file())
    todo.reopen_task(data, task_id)
    todo.save(data_file(), data)
    return _task_page_redirect(data)


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
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or not isinstance(body.get("text"), str):
        return jsonify(error="Text must be a string"), 400
    text = body["text"]
    todo.set_task_notes(data, task_id, text)
    todo.save(data_file(), data)
    return jsonify({"notes": _find_active(data, task_id)["notes"]})


@app.route("/task/<task_id>/subtasks", methods=["POST"])
def task_add_subtask(task_id):
    data = todo.load(data_file())
    if _find_active(data, task_id) is None:
        return jsonify({"error": "unknown task"}), 404
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or not isinstance(body.get("text"), str):
        return jsonify(error="Text must be a string"), 400
    text = body["text"]
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
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or not isinstance(body.get("text"), str):
        return jsonify(error="Text must be a string"), 400
    text = body["text"]
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


@app.route("/task/<task_id>/subtasks/reorder", methods=["POST"])
def task_reorder_subtask(task_id):
    data = todo.load(data_file())
    task = _find_active(data, task_id)
    if task is None:
        return jsonify({"error": "unknown task"}), 404
    body = request.get_json(silent=True)
    n = len(task.get("subtasks") or [])
    if not isinstance(body, dict) or any(type(body.get(field)) is not int for field in ("from", "to")):
        return jsonify({"error": "invalid indices"}), 400
    from_index, to_index = body["from"], body["to"]
    if not (0 <= from_index < n and 0 <= to_index < n):
        return jsonify({"error": "subtask index out of range"}), 404
    todo.reorder_subtask(data, task_id, from_index, to_index)
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
        name: {"section_id": sid, "color": journal.section_color(data, sid),
               "section_name": (journal.section_by_id(data, sid) or {}).get("name", "")}
        for name, sid in journal.tag_section_index(data).items()
    }


def _tag_voice_catalog(data):
    """Flat active tag catalog for offline voice-command matching."""
    out = []
    temporary = journal.temporary_tags(data)
    for section in journal.active_sections(data):
        if section.get("type") != "tag":
            continue
        for name in section.get("tags", []):
            out.append({"name": name, "section_id": section["id"],
                        "section_name": section["name"]})
        for name in temporary.get(section["id"], []):
            out.append({"name": name, "section_id": section["id"],
                        "section_name": section["name"]})
    return out


def _numeric_index(data):
    """{name: {"section_id": ..., "color": ..., "unit": ...}} for client-side
    #numeric capture. Built from journal.numeric_section_index + each section's
    color and unit. Active numeric sections only."""
    out = {}
    for name, sid in journal.numeric_section_index(data).items():
        s = journal.section_by_id(data, sid)
        out[name] = {
            "section_id": sid,
            "color": journal.section_color(data, sid),
            "unit": (s.get("unit") if s else None),
        }
    return out


def _task_ref_index(entry):
    """{id: {done, status, title}} for [task:<id>] tokens in the entry body.

    Looked up across tasks.json active (-> active), archive (-> done), expired
    (-> expired); an id with no matching task is `missing`. Drives the live
    checkbox rendering in journal-richtext.js."""
    ids = journal.linked_task_ids((entry or {}).get("body", ""))
    if not ids:
        return {}
    return todo.task_ref_index(todo.load(data_file()), ids)


def _render_entry(data, date):
    istore = integrations.load(integrations_file())
    entry = journal.get_entry_by_date(data, date)
    return render_template(
        "journal_entry.html", data=data,
        entry=entry,
        entry_edit_revision=journal.edit_revision(data, entry),
        date=date, sections=journal.active_sections(data),
        entry_dates=journal.calendar_dates(data),
        occupied_dates=journal.stored_entry_dates(data),
        mention_index=_mention_index(data),
        tag_voice_catalog=_tag_voice_catalog(data),
        numeric_index=_numeric_index(data),
        task_ref_index=_task_ref_index(entry),
        google_connected=integrations.is_connected(istore, "google"),
        google_last_sync=integrations.last_sync(istore, "google"),
        sleep=(entry or {}).get("sleep"),
        rescuetime_connected=integrations.is_connected(istore, "rescuetime"),
        rescuetime_last_sync=integrations.last_sync(istore, "rescuetime"),
        rescuetime=(entry or {}).get("rescuetime"),
        spotify_connected=integrations.is_connected(istore, "spotify"),
        spotify_last_sync=integrations.last_sync(istore, "spotify"),
        music=(entry or {}).get("music"),
        phone_connected=integrations.is_connected(istore, "phone"),
        usage=(entry or {}).get("usage"),
        health_connected=integrations.is_connected(istore, "health"),
        health=(entry or {}).get("health"),
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
    payload["rescuetime_connected"] = integrations.is_connected(integrations.load(integrations_file()), "rescuetime")
    payload["date_range"] = journal.analytics_date_range(
        payload["date_range"], payload["tasks"]["date_range"],
        places.manifest(os.path.join(os.path.dirname(journal_file()), "tracking"), skip_invalid=True),
    )
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
            if s.get("managed"):
                continue  # API-fed section: preserve its stored value (no form field)
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
        # Inline #numeric capture from the body — fills only sections lacking an
        # explicit field value (the explicit field is the source of truth).
        nidx = journal.numeric_section_index(data)
        body_numbers = journal.extract_numbers(body, nidx)
        for sid, val in body_numbers.items():
            base_numbers.setdefault(sid, val)   # explicit field value wins
        title = title.strip()
        if not title:
            if existing is not None:
                title = existing.get("title") or date
            elif base_tags or base_numbers or mood is not None:
                title = date
            else:
                flash("Could not save entry: a title is required.")
                return redirect(url_for("journal_entry", date=date))
        # Inline [] task spawning: each fresh `[]` line becomes an active task,
        # then its marker is rewritten to a linked [task:<id>] token so it never
        # re-spawns. The line's @mentions tag the task too (unified by name).
        to_spawn = journal.extract_task_lines(body, idx, todo.parse_due_token)
        if to_spawn:
            tdata = todo.load(data_file())
            new_ids = []
            for t in to_spawn:
                try:
                    todo.add_task(tdata, t["title"], due=t["due"], tags=t["tags"])
                    new_ids.append(tdata["active"][-1]["id"])
                except ValueError:
                    # Isolate a bad line (e.g. empty title) so one failure never
                    # aborts the rest; its [] marker is left un-rewritten.
                    new_ids.append(None)
            todo.save(data_file(), tdata)
            # new_ids aligns 1:1 with the non-skipped fresh markers; a None
            # entry (failed spawn) leaves that line's [] marker untouched.
            body = journal.rewrite_task_lines(body, new_ids)
        journal.upsert_entry(data, date, title, body,
                             tags=base_tags, numbers=base_numbers, mood=mood)
        journal.save(journal_file(), data)
    except ValueError:
        flash("Could not save entry: check the date, title, tags, and numbers.")
        return redirect(url_for("journal_entry", date=date) if journal._valid_date(date)
                        else url_for("journal_today"))
    return redirect(url_for("journal_entry", date=date, saved=1))


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
    sections = journal.active_sections(data)
    return render_template("journal_sections.html", data=data,
                           sections=sections,
                           temporary_tags=journal.temporary_tags(data),
                           suggestions=journal.tag_suggestions(data, limit=8),
                           dormant=journal.dormant_tags(data),
                           chart_options={s["id"]: journal.section_chart_options(s)
                                          for s in sections},
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


@app.route("/journal/sections/<section_id>/chart-opts", methods=["POST"])
def journal_section_chart_opts(section_id):
    """The Manage page's Configure popup: which analytics charts include this
    section. `enabled` is a repeated field of checked chart ids."""
    data = journal.load(journal_file())
    journal.set_section_chart_opts(data, section_id, request.form.getlist("enabled"))
    journal.save(journal_file(), data)
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
    return integrations.sync_dates(days, now=now)


def _run_provider_sync(provider, fetch, **kwargs):
    # Sync routes fetch outside the shared store lock. Legacy OAuth callbacks
    # already hold that lock, so they must not acquire locks in reverse order.
    provider_lock = nullcontext() if g.get('todopup_store_locked', False) else _provider_sync_locks[provider]
    with provider_lock:
        with _mobile_lock:
            initial_integrations = integrations.load(integrations_file())
            initial_journal = journal.load(journal_file())
        fetched_integrations = deepcopy(initial_integrations)
        fetched_journal = deepcopy(initial_journal)
        result = fetch(fetched_integrations, fetched_journal, **kwargs)
        if not result['connected']:
            return result
        with _mobile_lock:
            current_integrations = integrations.load(integrations_file())
            if not provider_sync.same_connection(initial_integrations, current_integrations, provider):
                return {'connected': integrations.is_connected(current_integrations, provider),
                        'synced': [], 'errors': ['Connection changed during sync. Run sync again.']}
            current_journal = journal.load(journal_file())
            result = provider_sync.reconcile(provider, initial_integrations, fetched_integrations,
                current_integrations, initial_journal, fetched_journal, current_journal, result, now=kwargs.get('now'))
            journal.save(journal_file(), current_journal)
            integrations.save(integrations_file(), current_integrations)
        return result


def _google_sync(days=7, force=False, focus_date=None, now=None):
    return _run_provider_sync("google", provider_sync.google_sync, days=days, force=force, focus_date=focus_date, now=now)


@app.route("/integrations/google/sync", methods=["POST"])
def google_sync_route():
    days = request.args.get("days", type=int) or 7
    focus = request.args.get("date")
    if focus and not journal._valid_date(focus):
        return jsonify(ok=False, error="Choose a valid sync date"), 400
    result = _google_sync(days=days, focus_date=focus, force=request.args.get("force") == "1")
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
        phone_connected=integrations.is_connected(data, "phone"),
        phone_last_sync=integrations.last_sync(data, "phone"),
        phone_endpoint=_phone_endpoint(),
        phone_apk_url=PHONE_APK_URL,
        health_connected=integrations.is_connected(data, "health"),
        health_last_sync=integrations.last_sync(data, "health"),
        health_endpoint=_health_endpoint(),
        mobile_devices=integrations.mobile_devices(data),
        health_token=session.pop("health_token_once", None),
    )


# Always-latest debug APK, published by .github/workflows/android.yml as a
# GitHub Release asset named phone-usage.apk. Reachable from the phone anywhere.
PHONE_APK_URL = (
    "https://github.com/the-11th/pompom-journal/releases/latest/download/phone-usage.apk"
)


def _phone_endpoint():
    """USB-loopback ingest endpoint configured by the Mac helper."""
    return "http://127.0.0.1:5001" + url_for("phone_ingest")


def _health_endpoint():
    return "http://127.0.0.1:5001" + url_for("health_ingest")


# Android journal/task API ------------------------------------------------- #

@app.route("/integrations/mobile/usb", methods=["POST"])
def mobile_usb_provision():
    # The USB helper shares this local server's trust boundary and transaction
    # lock. Forwarded headers cannot grant access to a remote requester.
    origin = request.headers.get("Origin")
    fetch_site = request.headers.get("Sec-Fetch-Site")
    if (request.remote_addr not in {"127.0.0.1", "::1"}
            or (origin is not None and origin != request.host_url.rstrip("/"))
            or (fetch_site is not None and fetch_site not in {"same-origin", "none"})):
        response = jsonify(ok=False, message="USB setup requires a local request")
        response.status_code = 403
    else:
        payload = request.get_json(silent=True) if request.is_json else None
        if not isinstance(payload, dict):
            response = jsonify(ok=False, message="Expected a JSON object")
            response.status_code = 400
        else:
            data = integrations.load(integrations_file())
            before = deepcopy(data)
            try:
                result = integrations.provision_usb(data, payload.get("token", ""))
            except ValueError as exc:
                response = jsonify(ok=False, message=str(exc))
                response.status_code = 400
            else:
                if data != before:
                    integrations.save(integrations_file(), data)
                response = jsonify(ok=True, **result)
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/integrations/mobile/devices/<device_id>/revoke", methods=["POST"])
def mobile_device_revoke(device_id):
    data = integrations.load(integrations_file())
    integrations.revoke_mobile_device(data, device_id)
    integrations.save(integrations_file(), data)
    return redirect(url_for("journal_sections") + "#sec-integrations")


@app.route("/api/mobile/config")
@_mobile_authenticated
def mobile_config(device):
    jdata = journal.load(journal_file())
    tdata = todo.load(data_file())
    mention_tags = {}
    for name, section_id in journal.tag_section_index(jdata).items():
        mention_tags.setdefault(section_id, []).append(name)
    sections = []
    for section in journal.active_sections(jdata):
        item = {key: section.get(key) for key in (
            "id", "name", "type", "color", "tags", "archived_tags", "unit", "managed", "metric")}
        item["mention_tags"] = mention_tags.get(section.get("id"), [])
        sections.append(item)
    return jsonify({
        "ok": True, "device": device, "mood_scale": {"min": 1, "max": 7},
        "sections": sections, "task_tags": tdata.get("tags", {}),
        "entry_dates": journal.entry_dates(jdata),
        "stored_entry_dates": journal.stored_entry_dates(jdata),
        "empty_edit_revision": journal.edit_revision(jdata, None),
        "calendar_dates": journal.calendar_dates(jdata),
        "capabilities": ["journal", "tags", "numbers", "audio_transcript", "tasks", "journal_tag_archive"],
    })


@app.route("/api/mobile/journal/<date>", methods=["GET", "PUT"])
@_mobile_authenticated
def mobile_journal(device, date):
    if not journal._valid_date(date):
        return _mobile_error("validation_error", "date must be YYYY-MM-DD", 400)
    data = journal.load(journal_file())
    if request.method == "GET":
        return jsonify({"ok": True, "entry": journal.entry_view(data, journal.get_entry_by_date(data, date))})

    payload = _mobile_payload()
    if payload is None:
        return _mobile_error("invalid_json", "A JSON object is required", 400)
    request_id, cached = _mobile_cached(device, payload)
    if cached:
        return cached
    previous = journal.get_entry_by_date(data, date)
    previous_updated = previous.get("updated") if previous else None
    try:
        import journal_commands
        import journal_media
        from pathlib import Path
        media_data = journal_media.load(Path(journal_file()).parent / "media.json")
        if payload.get("autosave"):
            entry = journal.autosave_entry(data, date, payload, media_data)
        else:
            task_data = todo.load(data_file())
            entry = journal_commands.commit(data, task_data, date, payload, media_data)
            todo.save(data_file(), task_data)
        if not payload.get("autosave") or (entry and entry.get("updated") != previous_updated):
            journal.save(journal_file(), data)
    except journal.EntryConflictError as exc:
        body = {"ok": False, "error": {
            "code": "conflict", "message": "Entry changed since it was loaded"},
            "current": journal.entry_view(data, exc.current)}
        _mobile_remember(device, request_id, 409, body)
        return jsonify(body), 409
    except (TypeError, ValueError) as exc:
        return _mobile_error("validation_error", str(exc), 400)
    body = {"ok": True, "entry": journal.entry_view(data, entry)}
    _mobile_remember(device, request_id, 200, body)
    return jsonify(body)


@app.route("/api/mobile/tags", methods=["POST"])
@app.route("/api/mobile/tags/archive", methods=["POST"], defaults={"tag_action": "archive"})
@app.route("/api/mobile/tags/restore-temporary", methods=["POST"], defaults={"tag_action": "restore_temporary"})
@_mobile_authenticated
def mobile_tag_add(device, tag_action=None):
    payload = _mobile_payload()
    if payload is None:
        return _mobile_error("invalid_json", "A JSON object is required", 400)
    request_id, cached = _mobile_cached(device, payload)
    if cached:
        return cached
    try:
        domain = payload.get("domain", "journal")
        action = tag_action or payload.get("action", "add")
        if tag_action and payload.get("action", tag_action) != tag_action:
            raise ValueError("Tag action does not match the requested endpoint")
        if domain not in ("journal", "task"):
            raise ValueError("Choose the journal or task tag domain")
        if domain == "task":
            if action != "add":
                raise ValueError("Only journal tags support archive or temporary restore")
            data = todo.load(data_file())
            todo.set_tag_color(data, payload.get("name"), payload.get("color"))
            todo.save(data_file(), data)
            tag = {"name": payload.get("name", "").strip().lower(),
                   "color": payload.get("color")}
        else:
            data = journal.load(journal_file())
            tag = journal.mutate_mobile_tag(data, payload.get("section_id"), payload.get("name"), action)
            journal.save(journal_file(), data)
    except (TypeError, ValueError) as exc:
        return _mobile_error("validation_error", str(exc), 400)
    body = {"ok": True, "tag": tag}
    status = 201 if action == "add" else 200
    _mobile_remember(device, request_id, status, body)
    return jsonify(body), status


@app.route("/api/mobile/tasks", methods=["GET", "POST"])
@_mobile_authenticated
def mobile_tasks(device):
    data = todo.load(data_file())
    if request.method == "GET":
        return jsonify({"ok": True, "tasks": todo.mobile_tasks(data)})
    payload = _mobile_payload()
    if payload is None:
        return _mobile_error("invalid_json", "A JSON object is required", 400)
    request_id, cached = _mobile_cached(device, payload)
    if cached:
        return cached
    try:
        todo.add_task(data, payload.get("title"), due=payload.get("due"),
                      recurrence=payload.get("recurrence"), tags=payload.get("tags"),
                      task_id=payload.get("client_id"))
        task = data["active"][-1]
        todo.set_task_notes(data, task["id"], payload.get("notes", ""))
        if "subtasks" in payload:
            todo.replace_subtasks(data, task["id"], payload.get("subtasks"))
        if payload.get("done") is True:
            todo.refresh(data, [task["id"]], difficulties={
                task["id"]: payload.get("difficulty")})
        todo.save(data_file(), data)
    except todo.TaskIdConflictError as exc:
        return _mobile_error("id_conflict", str(exc), 409,
                             current=todo.mobile_task_view(data, payload.get("client_id")))
    except (TypeError, ValueError) as exc:
        return _mobile_error("validation_error", str(exc), 400)
    body = {"ok": True, "task": todo.mobile_task_view(data, task["id"])}
    _mobile_remember(device, request_id, 201, body)
    return jsonify(body), 201


@app.route("/api/mobile/tasks/<task_id>", methods=["PATCH", "DELETE"])
@_mobile_authenticated
def mobile_task(device, task_id):
    payload = _mobile_payload()
    if payload is None:
        return _mobile_error("invalid_json", "A JSON object is required", 400)
    request_id, cached = _mobile_cached(device, payload)
    if cached:
        return cached
    data = todo.load(data_file())
    current, status = todo.task_by_id(data, task_id)
    try:
        if "base" in payload:
            todo.validate_mobile_task_base(data, task_id, payload["base"],
                                           None if request.method == "DELETE" else payload)
        if current is None:
            return _mobile_error("not_found", "Task was not found", 404)
        if request.method == "DELETE":
            todo.delete_task(data, task_id)
            task_view = None
        else:
            if payload.get("done") is False and status == "completed":
                todo.reopen_task(data, task_id)
                current, status = todo.task_by_id(data, task_id)
            editable = any(key in payload for key in (
                "title", "due", "recurrence", "tags"))
            if editable:
                if status != "active":
                    return _mobile_error("conflict", "Only active tasks can be edited", 409,
                                         current=todo.mobile_task_view(data, task_id))
                todo.edit_task(
                    data, task_id, payload.get("title", current.get("title")),
                    due=payload.get("due", current.get("due")),
                    recurrence=payload.get("recurrence", current.get("recurrence")),
                    tags=payload.get("tags", current.get("tags")))
            if "notes" in payload:
                if status != "active":
                    return _mobile_error("conflict", "Only active tasks can be edited", 409,
                                         current=todo.mobile_task_view(data, task_id))
                todo.set_task_notes(data, task_id, payload.get("notes"))
            if "subtasks" in payload:
                if status != "active":
                    return _mobile_error("conflict", "Only active tasks can be edited", 409,
                                         current=todo.mobile_task_view(data, task_id))
                todo.replace_subtasks(data, task_id, payload.get("subtasks"))
            if payload.get("done") is True and status == "active":
                todo.refresh(data, [task_id], difficulties={
                    task_id: payload.get("difficulty")})
            task_view = todo.mobile_task_view(data, task_id)
        todo.save(data_file(), data)
    except todo.TaskConflictError as exc:
        body = {"ok": False, "error": {"code": "conflict", "message": str(exc)},
                "current": exc.current}
        _mobile_remember(device, request_id, 409, body)
        return jsonify(body), 409
    except (TypeError, ValueError) as exc:
        return _mobile_error("validation_error", str(exc), 400)
    body = {"ok": True, "task": task_view}
    _mobile_remember(device, request_id, 200, body)
    return jsonify(body)


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
    return _run_provider_sync("spotify", provider_sync.spotify_sync, force=force, focus_date=focus_date, now=now)


@app.route("/integrations/spotify/sync", methods=["POST"])
def spotify_sync_route():
    focus = request.args.get("date")
    if focus and not journal._valid_date(focus):
        return jsonify(ok=False, error="Choose a valid sync date"), 400
    result = _spotify_sync(focus_date=focus, force=request.args.get("force") == "1")
    music = {}
    if focus and result["connected"]:
        entry = journal.get_entry_by_date(journal.load(journal_file()), focus)
        music = {focus: (entry or {}).get("music")}
    return jsonify({"ok": True, **result, "music": music})


@app.route("/integrations/spotify/analytics", methods=["GET", "POST"])
def spotify_analytics():
    with _provider_sync_locks['spotify']:
        with _mobile_lock:
            initial = integrations.load(integrations_file())
        fetched = deepcopy(initial)
        result = provider_sync.spotify_analytics(fetched)
        if not result['connected']:
            return jsonify({key: value for key, value in result.items() if key != 'updated'})
        with _mobile_lock:
            current = integrations.load(integrations_file())
            if not provider_sync.same_connection(initial, current, 'spotify'):
                return jsonify(ok=False, connected=integrations.is_connected(current, 'spotify'),
                    analytics=integrations.get_analytics(current, 'spotify'),
                    errors=['Connection changed during sync. Run sync again.'])
            before = deepcopy(current)
            result = provider_sync.reconcile_spotify_analytics(initial, fetched, current, result)
            if current != before:
                integrations.save(integrations_file(), current)
        return jsonify(result)


@app.route("/integrations/spotify/history/import", methods=["POST"])
def spotify_history_import():
    uploaded = request.files.get("history")
    if not uploaded:
        flash("Choose a Spotify history JSON file to import.")
        return redirect(url_for("integrations_page"))
    try:
        content = uploaded.read()
        if content.startswith(b"PK") or (uploaded.filename or "").lower().endswith(".zip"):
            raise ValueError("Extract the ZIP and choose a Spotify history JSON file")
        raw = json.loads(content.decode("utf-8-sig"))
        plays = spotify.parse_streaming_history(raw)
        data = journal.load(journal_file())
        result = music_history.import_plays(data, plays)
        if result["days"]:
            journal.save(journal_file(), data)
    except Exception as exc:  # noqa: BLE001 - surface as validation feedback
        flash(f"Spotify history import failed: {exc}")
        return redirect(url_for("integrations_page"))

    count = len(result["days"])
    flash(f"Imported Spotify history for {count} day{'s' if count != 1 else ''}." if count else "This Spotify history is already imported.")
    return redirect(url_for("integrations_page"))


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
    return _run_provider_sync("rescuetime", provider_sync.rescuetime_sync, force=force, focus_date=focus_date, now=now)


@app.route("/integrations/rescuetime/sync", methods=["POST"])
def rescuetime_sync_route():
    focus = request.args.get("date")
    if focus and not journal._valid_date(focus):
        return jsonify(ok=False, error="Choose a valid sync date"), 400
    result = _rescuetime_sync(focus_date=focus, force=request.args.get("force") == "1")
    data = {}
    if focus and result["connected"]:
        entry = journal.get_entry_by_date(journal.load(journal_file()), focus)
        data = {focus: (entry or {}).get("rescuetime")}
    return jsonify({"ok": True, **result, "data": data})


@app.route("/integrations/rescuetime/detail", methods=["POST"])
def rescuetime_detail():
    date = request.args.get("date")
    if not journal._valid_date(date):
        return jsonify(ok=False, error="Choose a valid report date"), 400
    with _provider_sync_locks["rescuetime"]:
        with _mobile_lock:
            initial = integrations.load(integrations_file())
        fetched = deepcopy(initial)
        result = provider_sync.rescuetime_detail(fetched, date, force=request.args.get("force") == "1")
        if not result["connected"]:
            return jsonify(result)
        with _mobile_lock:
            current = integrations.load(integrations_file())
            if not provider_sync.same_connection(initial, current, "rescuetime"):
                return jsonify(ok=False, connected=integrations.is_connected(current, "rescuetime"),
                               error="Connection changed during sync. Load the day again.")
            details = integrations.get_analytics(fetched, "rescuetime")
            if details != integrations.get_analytics(current, "rescuetime"):
                integrations.set_analytics(current, "rescuetime", details)
                integrations.save(integrations_file(), current)
        return jsonify(result)


# --------------------------------------------------------------------------- #
# Phone usage (Android push, RescueTime-style shared bearer token; no OAuth).
# The phone POSTs usage stats to /integrations/phone/ingest; there is nothing to
# pull, so there is no "Sync now" and no auto-sync.
# --------------------------------------------------------------------------- #

@app.route("/integrations/phone/ingest", methods=["POST"])
def phone_ingest():
    istore = integrations.load(integrations_file())
    stored = integrations.get_token(istore, "phone")
    header = request.headers.get("Authorization", "")
    supplied = header[7:] if header.startswith("Bearer ") else ""
    if not stored or not supplied or not secrets.compare_digest(supplied, stored):
        return jsonify({"ok": False, "error": "unauthorized"}), 401
    days = usage.parse_push(request.get_json(silent=True))
    if not days:
        return jsonify(ok=False, error="Include at least one valid YYYY-MM-DD day"), 400
    jdata = journal.load(journal_file())
    written = []
    for day in days:
        previous = journal.get_entry_by_date(jdata, day["date"])
        value = usage.merge_day((previous or {}).get("usage"), day)
        if value != (previous or {}).get("usage"):
            journal.set_entry_usage(jdata, day["date"], value)
        written.append(day["date"])
    journal.save(journal_file(), jdata)
    integrations.set_last_sync(istore, "phone",
                               datetime.now().replace(microsecond=0).isoformat())
    integrations.save(integrations_file(), istore)
    return jsonify({"ok": True, "dates": written})


@app.route("/integrations/phone/disconnect", methods=["POST"])
def phone_disconnect():
    data = integrations.load(integrations_file())
    integrations.clear_provider(data, "phone")
    integrations.save(integrations_file(), data)
    flash("Phone usage disconnected.")
    return redirect(url_for("integrations_page"))


# --------------------------------------------------------------------------- #
# Health data (Xiaomi / Health Connect push, shared bearer token; no OAuth).
# A bridge POSTs daily steps and heart-rate samples to /integrations/health/ingest.
# --------------------------------------------------------------------------- #

@app.route("/integrations/health/ingest", methods=["POST"])
def health_ingest():
    istore = integrations.load(integrations_file())
    stored = integrations.get_token(istore, "health")
    header = request.headers.get("Authorization", "")
    supplied = header[7:] if header.startswith("Bearer ") else ""
    if not stored or not supplied or not secrets.compare_digest(supplied, stored):
        return jsonify({"ok": False, "error": "unauthorized"}), 401
    days = health.parse_push(request.get_json(silent=True))
    if not days:
        return jsonify(ok=False, error="Include at least one valid YYYY-MM-DD day"), 400
    jdata = journal.load(journal_file())
    written = []
    for day in days:
        journal.set_entry_health(jdata, day["date"], day)
        written.append(day["date"])
    journal.save(journal_file(), jdata)
    integrations.set_last_sync(istore, "health",
                               datetime.now().replace(microsecond=0).isoformat())
    integrations.save(integrations_file(), istore)
    return jsonify({"ok": True, "dates": written})


@app.route("/integrations/health/token", methods=["POST"])
def health_token():
    data = integrations.load(integrations_file())
    token = secrets.token_urlsafe(24)
    integrations.set_token(data, "health", token)
    integrations.save(integrations_file(), data)
    session["health_token_once"] = token
    flash("Health-data token generated — copy it into the Xiaomi/Health bridge now; "
          "it won't be shown again.")
    return redirect(url_for("integrations_page"))


@app.route("/integrations/health/disconnect", methods=["POST"])
def health_disconnect():
    data = integrations.load(integrations_file())
    integrations.clear_provider(data, "health")
    integrations.save(integrations_file(), data)
    flash("Health data disconnected.")
    return redirect(url_for("integrations_page"))


import media_routes
media_routes.register(app, journal_file, _mobile_authenticated, _mobile_lock, data_file)


if __name__ == "__main__":
    app.run(debug=True)
