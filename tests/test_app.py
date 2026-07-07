"""Tests for the Flask HTTP layer in app.py.

Each test uses Flask's test_client() and points the app at a temporary
data file (via app config) so we never touch the real data/tasks.json.
"""

import pytest

import app as app_module
import todo


@pytest.fixture
def client(tmp_path):
    """A Flask test client backed by a fresh temp data file."""
    data_file = tmp_path / "tasks.json"
    flask_app = app_module.app
    flask_app.config["TESTING"] = True
    flask_app.config["DATA_FILE"] = str(data_file)
    flask_app.config["JOURNAL_FILE"] = str(tmp_path / "journal.json")
    # Start each test from a clean, fully-initialized store (includes the
    # "tags" key) rather than the migration path.
    todo.save(str(data_file), todo._empty())
    with flask_app.test_client() as c:
        yield c


def _data_path(client):
    return app_module.app.config["DATA_FILE"]


def test_get_index_ok(client):
    resp = client.get("/")
    assert resp.status_code == 200


def test_get_index_shows_active_tasks(client):
    data = todo.load(_data_path(client))
    todo.add_task(data, "Visible task")
    todo.save(_data_path(client), data)

    resp = client.get("/")
    assert b"Visible task" in resp.data


def test_post_add_redirects_and_adds(client):
    resp = client.post("/add", data={"title": "New task"})
    assert resp.status_code == 302

    data = todo.load(_data_path(client))
    titles = [t["title"] for t in data["active"]]
    assert "New task" in titles


def test_post_add_empty_title_not_added(client):
    resp = client.post("/add", data={"title": "   "})
    assert resp.status_code == 302   # still redirects gracefully

    data = todo.load(_data_path(client))
    assert data["active"] == []


def test_post_add_with_due(client):
    client.post("/add", data={"title": "Has due", "due": "2026-07-01T09:00"})
    data = todo.load(_data_path(client))
    assert data["active"][0]["due"] == "2026-07-01T09:00"


def test_post_add_bad_due_not_added(client):
    resp = client.post("/add", data={"title": "Bad due", "due": "not-a-date"})
    assert resp.status_code == 302   # still redirects gracefully

    data = todo.load(_data_path(client))
    assert data["active"] == []   # nothing added


def test_post_refresh_moves_to_archive(client):
    data = todo.load(_data_path(client))
    todo.add_task(data, "Finish me")
    todo.save(_data_path(client), data)
    task_id = data["active"][0]["id"]

    resp = client.post("/refresh", data={"completed": task_id})
    assert resp.status_code == 302

    data = todo.load(_data_path(client))
    assert data["active"] == []
    assert len(data["archive"]) == 1
    assert data["archive"][0]["title"] == "Finish me"


def test_post_delete_removes_task(client):
    data = todo.load(_data_path(client))
    todo.add_task(data, "Delete me")
    todo.save(_data_path(client), data)
    task_id = data["active"][0]["id"]

    resp = client.post(f"/delete/{task_id}")
    assert resp.status_code == 302

    data = todo.load(_data_path(client))
    assert data["active"] == []


def test_get_archive_shows_completed_only(client):
    data = todo.load(_data_path(client))
    todo.add_task(data, "Active one")
    todo.add_task(data, "Will archive")
    todo.save(_data_path(client), data)
    archive_id = data["active"][1]["id"]
    client.post("/refresh", data={"completed": archive_id})

    resp = client.get("/archive")
    assert resp.status_code == 200
    assert b"Will archive" in resp.data
    assert b"Active one" not in resp.data


def test_empty_state_pages_render(client):
    assert client.get("/").status_code == 200
    assert client.get("/archive").status_code == 200


# --------------------------------------------------------------------------- #
# Recurring tasks via the add form
# --------------------------------------------------------------------------- #

def test_post_add_recurring_daily(client):
    client.post("/add", data={
        "title": "Daily standup",
        "due": "2026-07-01T09:00",
        "recurrence": "daily",
    })
    data = todo.load(_data_path(client))
    assert data["active"][0]["recurrence"] == "daily"


def test_post_add_custom_recurrence(client):
    client.post("/add", data={
        "title": "Every 3 days",
        "due": "2026-07-01T09:00",
        "recurrence": "custom",
        "custom_n": "3",
    })
    data = todo.load(_data_path(client))
    assert data["active"][0]["recurrence"] == "every:3"


def test_post_add_recurrence_without_due_defaults(client):
    resp = client.post("/add", data={
        "title": "No due recurring",
        "recurrence": "daily",
    })
    assert resp.status_code == 302
    data = todo.load(_data_path(client))
    assert len(data["active"]) == 1          # added with a defaulted due date
    t = data["active"][0]
    assert t["recurrence"] == "daily"
    assert t["due"] and t["due"].endswith("T23:59:00")


# --------------------------------------------------------------------------- #
# Edit routes
# --------------------------------------------------------------------------- #

def test_get_edit_returns_200_and_prefills(client):
    data = todo.load(_data_path(client))
    todo.add_task(data, "Original title", due="2026-07-01T09:00")
    todo.save(_data_path(client), data)
    task_id = data["active"][0]["id"]

    resp = client.get(f"/edit/{task_id}")
    assert resp.status_code == 200
    assert b"Original title" in resp.data


def test_get_edit_unknown_id_redirects(client):
    resp = client.get("/edit/does-not-exist")
    assert resp.status_code == 302


def test_post_edit_updates_task(client):
    data = todo.load(_data_path(client))
    todo.add_task(data, "Before")
    todo.save(_data_path(client), data)
    task_id = data["active"][0]["id"]

    resp = client.post(f"/edit/{task_id}", data={
        "title": "After",
        "due": "2026-08-01T10:00",
        "recurrence": "weekly",
    })
    assert resp.status_code == 302

    data = todo.load(_data_path(client))
    task = data["active"][0]
    assert task["title"] == "After"
    assert task["due"] == "2026-08-01T10:00"
    assert task["recurrence"] == "weekly"


def test_post_edit_validation_failure_does_not_save(client):
    data = todo.load(_data_path(client))
    todo.add_task(data, "Keep me")
    todo.save(_data_path(client), data)
    task_id = data["active"][0]["id"]

    # Empty title -> validation error -> no change.
    resp = client.post(f"/edit/{task_id}", data={"title": "   "})
    assert resp.status_code == 302

    data = todo.load(_data_path(client))
    assert data["active"][0]["title"] == "Keep me"


# --------------------------------------------------------------------------- #
# Expired section rendering
# --------------------------------------------------------------------------- #

def test_index_renders_expired_section(client):
    # Seed a store with an expired entry directly.
    data = {
        "active": [],
        "archive": [],
        "expired": [{
            "id": "exp1",
            "title": "Missed timesheet",
            "due": "2026-06-14T17:00:00",
            "recurrence": "daily",
            "created": "x",
            "expired_at": "2026-06-15T12:00:00",
        }],
    }
    todo.save(_data_path(client), data)

    resp = client.get("/")
    assert resp.status_code == 200
    assert b"Expired" in resp.data
    assert b"Missed timesheet" in resp.data


# --------------------------------------------------------------------------- #
# Tags -- filtering on the index
# --------------------------------------------------------------------------- #

def test_get_index_filters_by_tags(client):
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "work", "#e0a955")
    todo.set_tag_color(data, "home", "#3fae5a")
    todo.add_task(data, "Work thing", tags=["work"])
    todo.add_task(data, "Home thing", tags=["home"])
    todo.save(_data_path(client), data)

    # Filtering to ?tags=work shows only the work task.
    resp = client.get("/?tags=work")
    assert resp.status_code == 200
    assert b"Work thing" in resp.data
    assert b"Home thing" not in resp.data


def test_get_index_no_filter_shows_all(client):
    data = todo.load(_data_path(client))
    todo.add_task(data, "Work thing", tags=["work"])
    todo.add_task(data, "Untagged thing", tags=[])
    todo.save(_data_path(client), data)

    resp = client.get("/")
    assert resp.status_code == 200
    assert b"Work thing" in resp.data
    assert b"Untagged thing" in resp.data


def test_get_index_unknown_tag_shows_all(client):
    # A stale/unknown tag in ?tags= should be dropped (behaves like no filter)
    # rather than silently showing an empty list.
    data = todo.load(_data_path(client))
    todo.add_task(data, "Work thing", tags=["work"])
    todo.add_task(data, "Untagged thing", tags=[])
    todo.save(_data_path(client), data)

    resp = client.get("/?tags=nonexistent")
    assert resp.status_code == 200
    assert b"Work thing" in resp.data
    assert b"Untagged thing" in resp.data


def test_filter_chip_link_url_encodes_tag_with_space(client):
    # A tag name containing a space must produce a properly percent-encoded
    # filter link (space -> %20), and filtering by the encoded query must work.
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "work item", "#e0a955")
    todo.add_task(data, "Spaced thing", tags=["work item"])
    todo.add_task(data, "Other thing", tags=[])
    todo.save(_data_path(client), data)

    resp = client.get("/")
    assert resp.status_code == 200
    # The chip link encodes the space (Werkzeug uses "+" for spaces in a query)
    # rather than embedding it raw, which would break the URL.
    assert b"tags=work+item" in resp.data
    assert b"tags=work item" not in resp.data

    # Filtering via the encoded query works and narrows the list. Both "+"
    # and "%20" decode to a space, so either form filters correctly.
    for encoded in ("/?tags=work+item", "/?tags=work%20item"):
        resp = client.get(encoded)
        assert resp.status_code == 200
        assert b"Spaced thing" in resp.data
        assert b"Other thing" not in resp.data


def test_get_index_filter_union(client):
    data = todo.load(_data_path(client))
    # Register the tags so they survive the index's registry intersection.
    todo.set_tag_color(data, "work", "#e0a955")
    todo.set_tag_color(data, "home", "#3fae5a")
    todo.set_tag_color(data, "errand", "#2b5cb8")
    todo.add_task(data, "Aaa", tags=["work"])
    todo.add_task(data, "Bbb", tags=["home"])
    todo.add_task(data, "Ccc", tags=["errand"])
    todo.save(_data_path(client), data)

    resp = client.get("/?tags=work,home")
    assert resp.status_code == 200
    assert b"Aaa" in resp.data
    assert b"Bbb" in resp.data
    assert b"Ccc" not in resp.data


# --------------------------------------------------------------------------- #
# Tags -- filtering on the archive page
# --------------------------------------------------------------------------- #

def _archive_task(client, title, tags):
    """Helper: add a tagged active task then refresh it into the archive."""
    data = todo.load(_data_path(client))
    todo.add_task(data, title, tags=tags)
    todo.save(_data_path(client), data)
    task_id = next(t["id"] for t in data["active"] if t["title"] == title)
    client.post("/refresh", data={"completed": task_id})


def test_get_archive_filters_by_tags(client):
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "work", "#e0a955")
    todo.set_tag_color(data, "home", "#3fae5a")
    todo.save(_data_path(client), data)
    _archive_task(client, "Work thing", ["work"])
    _archive_task(client, "Home thing", ["home"])

    # Filtering to ?tags=work shows only the archived work task.
    resp = client.get("/archive?tags=work")
    assert resp.status_code == 200
    assert b"Work thing" in resp.data
    assert b"Home thing" not in resp.data


def test_get_archive_renders_tags(client):
    # A tagged archived task should render its tag name (highlight + chips),
    # not just the bare title.
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "work", "#e0a955")
    todo.save(_data_path(client), data)
    _archive_task(client, "Tagged archived", ["work"])

    resp = client.get("/archive")
    assert resp.status_code == 200
    assert b"Tagged archived" in resp.data
    # The tag name appears (filter chip row and/or extra-tag chips).
    assert b"work" in resp.data


def test_get_archive_unknown_tag_shows_all(client):
    # A stale/unknown tag in ?tags= should be dropped (behaves like no filter).
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "work", "#e0a955")
    todo.save(_data_path(client), data)
    _archive_task(client, "Work thing", ["work"])
    _archive_task(client, "Untagged thing", [])

    resp = client.get("/archive?tags=nonexistent")
    assert resp.status_code == 200
    assert b"Work thing" in resp.data
    assert b"Untagged thing" in resp.data


def test_get_archive_empty_filter_renders_empty_state(client):
    # Filtering down to nothing still renders the page (friendly empty state).
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "work", "#e0a955")
    todo.set_tag_color(data, "home", "#3fae5a")
    todo.save(_data_path(client), data)
    _archive_task(client, "Work thing", ["work"])

    # Filter by a known tag that no archived task carries -> empty result.
    resp = client.get("/archive?tags=home")
    assert resp.status_code == 200
    assert b"Work thing" not in resp.data


# --------------------------------------------------------------------------- #
# Tags -- add / edit with tags + new-tag color registration
# --------------------------------------------------------------------------- #

def test_post_add_with_existing_and_new_tag(client):
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "work", "#e0a955")
    todo.save(_data_path(client), data)

    client.post("/add", data={
        "title": "Tagged task",
        "tags": ["work"],                 # existing tag (checkbox)
        "new_tag": "Urgent",              # brand-new tag
        "new_tag_color": "#e0524d",
    })

    data = todo.load(_data_path(client))
    task = data["active"][0]
    # Both tags attached, normalized.
    assert task["tags"] == ["work", "urgent"]
    # The new tag's color was registered.
    assert data["tags"]["urgent"] == "#e0524d"


def test_post_add_invalid_new_tag_color_not_saved(client):
    resp = client.post("/add", data={
        "title": "Bad tag",
        "new_tag": "weird",
        "new_tag_color": "notacolor",
    })
    assert resp.status_code == 302   # graceful redirect
    data = todo.load(_data_path(client))
    # Nothing saved -- task not added and tag not registered.
    assert data["active"] == []
    assert "weird" not in data["tags"]


def test_post_edit_updates_tags(client):
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "home", "#3fae5a")
    todo.add_task(data, "Task", tags=["home"])
    todo.save(_data_path(client), data)
    task_id = data["active"][0]["id"]

    client.post(f"/edit/{task_id}", data={
        "title": "Task",
        "tags": ["home"],
        "new_tag": "weekend",
        "new_tag_color": "#abc",
    })

    data = todo.load(_data_path(client))
    task = data["active"][0]
    assert task["tags"] == ["home", "weekend"]
    assert data["tags"]["weekend"] == "#abc"


# --------------------------------------------------------------------------- #
# Tags -- manage tags page
# --------------------------------------------------------------------------- #

def test_get_tags_page_renders(client):
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "work", "#e0a955")
    todo.save(_data_path(client), data)

    resp = client.get("/tags")
    assert resp.status_code == 200
    assert b"work" in resp.data


def test_get_tags_page_empty_state(client):
    resp = client.get("/tags")
    assert resp.status_code == 200   # friendly empty state, no tags yet


def test_post_tags_updates_color(client):
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "work", "#e0a955")
    todo.save(_data_path(client), data)

    resp = client.post("/tags", data={"name": "work", "color": "#123456"})
    assert resp.status_code == 302

    data = todo.load(_data_path(client))
    assert data["tags"]["work"] == "#123456"


def test_post_tags_invalid_color_rejected(client):
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "work", "#e0a955")
    todo.save(_data_path(client), data)

    resp = client.post("/tags", data={"name": "work", "color": "nope"})
    assert resp.status_code == 302   # graceful redirect

    data = todo.load(_data_path(client))
    # Color unchanged -- registry not corrupted.
    assert data["tags"]["work"] == "#e0a955"


def test_post_tags_unregistered_name_not_created(client):
    # The manage page may only recolor EXISTING tags; a POST naming an unknown
    # tag must not create a spurious registry entry.
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "work", "#e0a955")
    todo.save(_data_path(client), data)

    resp = client.post("/tags", data={"name": "ghost", "color": "#123456"})
    assert resp.status_code == 302

    data = todo.load(_data_path(client))
    assert "ghost" not in data["tags"]
    assert data["tags"] == {"work": "#e0a955"}   # registry unchanged


def test_post_tag_delete_removes_tag_and_redirects(client):
    # Deleting a tag via the route removes it from the registry AND from a
    # task that carried it, then redirects back to the tags page.
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "work", "#e0a955")
    todo.add_task(data, "Work thing", tags=["work"])
    todo.save(_data_path(client), data)

    resp = client.post("/tags/work/delete")
    assert resp.status_code == 302

    data = todo.load(_data_path(client))
    assert "work" not in data["tags"]
    assert data["active"][0]["tags"] == []


# --------------------------------------------------------------------------- #
# Flashed validation messages
# --------------------------------------------------------------------------- #

def test_add_empty_title_flashes_and_not_added(client):
    # A bad submission surfaces a flash message (visible after the redirect)
    # and adds nothing.
    resp = client.post("/add", data={"title": "   "}, follow_redirects=True)
    assert resp.status_code == 200
    assert b"Could not add task" in resp.data

    data = todo.load(_data_path(client))
    assert data["active"] == []


def test_post_tags_invalid_color_flashes(client):
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "work", "#e0a955")
    todo.save(_data_path(client), data)

    resp = client.post(
        "/tags", data={"name": "work", "color": "nope"}, follow_redirects=True
    )
    assert resp.status_code == 200
    assert b"Could not update tag color" in resp.data


def test_heartbeat_returns_204(client):
    resp = client.get("/heartbeat")
    assert resp.status_code == 204


def test_heartbeat_with_tab_returns_204(client):
    resp = client.get("/heartbeat?tab=abc123")
    assert resp.status_code == 204


def test_quit_beacon_returns_204(client):
    resp = client.post("/quit?tab=abc123")
    assert resp.status_code == 204


# ── Auto-quit watchdog: tab-counting + grace window ─────────────────────────
# These exercise the pure decision helpers with an injected monotonic clock,
# so no real threads/timers are involved.


@pytest.fixture
def fresh_watchdog():
    """Reset the module-level watchdog state before and after each test."""
    app_module._reset_watchdog()
    yield
    app_module._reset_watchdog()


def test_watchdog_does_not_quit_before_any_tab(fresh_watchdog):
    # Never armed → never quits, even far in the future.
    assert app_module._should_quit(now=1000.0) is False


def test_watchdog_stays_alive_while_a_tab_is_registered(fresh_watchdog):
    app_module._register_tab("t1", now=0.0)
    # Long after, with the tab still heartbeating, it must stay alive.
    app_module._register_tab("t1", now=100.0)
    assert app_module._should_quit(now=100.0) is False


def test_watchdog_quits_after_grace_when_last_tab_closes(fresh_watchdog):
    app_module._register_tab("t1", now=0.0)
    app_module._unregister_tab("t1", now=0.0)
    # Within the grace window: still alive.
    assert app_module._should_quit(now=1.0) is False
    # After the grace window: quit.
    assert app_module._should_quit(now=app_module._QUIT_GRACE + 0.1) is True


def test_watchdog_navigation_does_not_quit(fresh_watchdog):
    # Simulate a full-page navigation: the closing page fires a quit beacon,
    # then the new page registers again within the grace window.
    app_module._register_tab("t1", now=0.0)
    app_module._unregister_tab("t1", now=0.0)
    app_module._register_tab("t1", now=0.5)  # new page loaded
    assert app_module._should_quit(now=app_module._QUIT_GRACE + 1.0) is False


def test_watchdog_other_tab_keeps_server_alive(fresh_watchdog):
    app_module._register_tab("t1", now=0.0)
    app_module._register_tab("t2", now=0.0)
    app_module._unregister_tab("t1", now=0.0)  # close one tab
    assert app_module._should_quit(now=app_module._QUIT_GRACE + 5.0) is False


def test_watchdog_evicts_stale_tab_then_quits(fresh_watchdog):
    # A crashed/force-quit browser never sends a quit beacon; its heartbeat
    # simply goes stale and the tab is evicted, then the server quits.
    app_module._register_tab("t1", now=0.0)
    stale = app_module._STALE_AFTER
    assert app_module._should_quit(now=stale - 1) is False
    # Past the stale window: tab evicted, grace starts, then quits.
    assert app_module._should_quit(now=stale + 1) is False
    assert app_module._should_quit(now=stale + 1 + app_module._QUIT_GRACE + 0.1) is True


def test_refresh_saves_difficulty(client):
    client.post("/add", data={"title": "rate me"})
    data = todo.load(_data_path(client))
    tid = data["active"][0]["id"]
    resp = client.post("/refresh", data={"completed": tid, f"difficulty:{tid}": "hard"})
    assert resp.status_code == 302
    data = todo.load(_data_path(client))
    assert data["archive"][0]["difficulty"] == "hard"


def test_active_page_has_difficulty_picker(client):
    client.post("/add", data={"title": "task one"})
    html = client.get("/").get_data(as_text=True)
    assert 'class="difficulty-picker"' in html
    data = todo.load(_data_path(client))
    tid = data["active"][0]["id"]
    assert f'name="difficulty:{tid}"' in html


def _archive_one(client, title="done"):
    client.post("/add", data={"title": title})
    data = todo.load(_data_path(client))
    tid = data["active"][0]["id"]
    client.post("/refresh", data={"completed": tid})
    return tid


def test_archive_difficulty_edit_sets_value(client):
    tid = _archive_one(client)
    resp = client.post(f"/archive/{tid}/difficulty", data={"difficulty": "medium"})
    assert resp.status_code == 302
    data = todo.load(_data_path(client))
    assert data["archive"][0]["difficulty"] == "medium"


def test_archive_difficulty_edit_clears_value(client):
    tid = _archive_one(client)
    client.post(f"/archive/{tid}/difficulty", data={"difficulty": "hard"})
    client.post(f"/archive/{tid}/difficulty", data={"difficulty": ""})
    data = todo.load(_data_path(client))
    assert "difficulty" not in data["archive"][0]


def test_archive_page_shows_difficulty_control(client):
    _archive_one(client)
    html = client.get("/archive").get_data(as_text=True)
    assert "difficulty-select" in html


def test_analytics_data_includes_tasks_block(client):
    client.post("/add", data={"title": "open task"})
    resp = client.get("/journal/analytics/data")
    assert resp.status_code == 200
    payload = resp.get_json()
    assert "tasks" in payload
    assert "archive" in payload["tasks"] and "active" in payload["tasks"]


# --------------------------------------------------------------------------- #
# Task notes + subtasks routes
# --------------------------------------------------------------------------- #

def _add_active(client, title="task one"):
    client.post("/add", data={"title": title})
    data = todo.load(_data_path(client))
    return data["active"][0]["id"]


def test_post_task_notes_persists_and_returns_json(client):
    tid = _add_active(client)
    resp = client.post(f"/task/{tid}/notes", json={"text": "  hello  "})
    assert resp.status_code == 200
    assert resp.get_json() == {"notes": "hello"}
    data = todo.load(_data_path(client))
    assert data["active"][0]["notes"] == "hello"


def test_post_task_notes_can_clear(client):
    tid = _add_active(client)
    client.post(f"/task/{tid}/notes", json={"text": "x"})
    resp = client.post(f"/task/{tid}/notes", json={"text": ""})
    assert resp.status_code == 200
    assert resp.get_json() == {"notes": ""}


def test_post_task_notes_unknown_id_404(client):
    resp = client.post("/task/ghost/notes", json={"text": "x"})
    assert resp.status_code == 404


def test_post_add_subtask_returns_list(client):
    tid = _add_active(client)
    resp = client.post(f"/task/{tid}/subtasks", json={"text": "step one"})
    assert resp.status_code == 200
    assert resp.get_json() == {"subtasks": [{"text": "step one", "done": False}]}
    data = todo.load(_data_path(client))
    assert data["active"][0]["subtasks"][0]["text"] == "step one"


def test_post_add_subtask_empty_400(client):
    tid = _add_active(client)
    resp = client.post(f"/task/{tid}/subtasks", json={"text": "   "})
    assert resp.status_code == 400


def test_post_add_subtask_unknown_id_404(client):
    resp = client.post("/task/ghost/subtasks", json={"text": "x"})
    assert resp.status_code == 404


def test_post_toggle_subtask(client):
    tid = _add_active(client)
    client.post(f"/task/{tid}/subtasks", json={"text": "a"})
    resp = client.post(f"/task/{tid}/subtasks/0/toggle")
    assert resp.status_code == 200
    assert resp.get_json()["subtasks"][0]["done"] is True


def test_post_toggle_subtask_bad_index_404(client):
    tid = _add_active(client)
    client.post(f"/task/{tid}/subtasks", json={"text": "a"})
    resp = client.post(f"/task/{tid}/subtasks/9/toggle")
    assert resp.status_code == 404


def test_post_edit_subtask(client):
    tid = _add_active(client)
    client.post(f"/task/{tid}/subtasks", json={"text": "old"})
    resp = client.post(f"/task/{tid}/subtasks/0", json={"text": "new"})
    assert resp.status_code == 200
    assert resp.get_json()["subtasks"][0]["text"] == "new"


def test_post_edit_subtask_empty_400(client):
    tid = _add_active(client)
    client.post(f"/task/{tid}/subtasks", json={"text": "old"})
    resp = client.post(f"/task/{tid}/subtasks/0", json={"text": "  "})
    assert resp.status_code == 400


def test_post_edit_subtask_bad_index_404(client):
    tid = _add_active(client)
    client.post(f"/task/{tid}/subtasks", json={"text": "old"})
    resp = client.post(f"/task/{tid}/subtasks/9", json={"text": "new"})
    assert resp.status_code == 404


def test_post_delete_subtask(client):
    tid = _add_active(client)
    client.post(f"/task/{tid}/subtasks", json={"text": "a"})
    client.post(f"/task/{tid}/subtasks", json={"text": "b"})
    resp = client.post(f"/task/{tid}/subtasks/0/delete")
    assert resp.status_code == 200
    assert [s["text"] for s in resp.get_json()["subtasks"]] == ["b"]


def test_post_delete_subtask_bad_index_404(client):
    tid = _add_active(client)
    client.post(f"/task/{tid}/subtasks", json={"text": "a"})
    resp = client.post(f"/task/{tid}/subtasks/9/delete")
    assert resp.status_code == 404


def test_post_reorder_subtask_persists_and_returns_list(client):
    tid = _add_active(client)
    client.post(f"/task/{tid}/subtasks", json={"text": "a"})
    client.post(f"/task/{tid}/subtasks", json={"text": "b"})
    client.post(f"/task/{tid}/subtasks", json={"text": "c"})
    resp = client.post(f"/task/{tid}/subtasks/reorder", json={"from": 0, "to": 2})
    assert resp.status_code == 200
    assert [s["text"] for s in resp.get_json()["subtasks"]] == ["b", "c", "a"]
    data = todo.load(_data_path(client))
    assert [s["text"] for s in data["active"][0]["subtasks"]] == ["b", "c", "a"]


def test_post_reorder_subtask_bad_index_404(client):
    tid = _add_active(client)
    client.post(f"/task/{tid}/subtasks", json={"text": "a"})
    client.post(f"/task/{tid}/subtasks", json={"text": "b"})
    resp = client.post(f"/task/{tid}/subtasks/reorder", json={"from": 0, "to": 9})
    assert resp.status_code == 404
    resp = client.post(f"/task/{tid}/subtasks/reorder", json={"from": 9, "to": 0})
    assert resp.status_code == 404


def test_post_reorder_subtask_unknown_id_404(client):
    resp = client.post("/task/ghost/subtasks/reorder", json={"from": 0, "to": 1})
    assert resp.status_code == 404


def test_active_page_renders_title_toggle_and_hint(client):
    tid = _add_active(client)
    todo_data = todo.load(_data_path(client))
    todo.set_task_notes(todo_data, tid, "has notes")
    todo.add_subtask(todo_data, tid, "a")
    todo.save(_data_path(client), todo_data)
    html = client.get("/").get_data(as_text=True)
    assert "task-title-toggle" in html
    assert "task-details" in html
    assert "detail-hint" in html
    assert "subtask-progress" in html


def test_archive_page_renders_readonly_details(client):
    tid = _add_active(client)
    todo_data = todo.load(_data_path(client))
    todo.set_task_notes(todo_data, tid, "archived notes")
    todo.add_subtask(todo_data, tid, "a")
    todo.save(_data_path(client), todo_data)
    client.post("/refresh", data={"completed": tid})
    html = client.get("/archive").get_data(as_text=True)
    assert "task-details" in html
    assert "data-readonly" in html
    assert "archived notes" in html


# --------------------------------------------------------------------------- #
# Tag pages / backlinks: GET /tag/<name>/overview
# --------------------------------------------------------------------------- #

def test_tag_overview_route_merges_task_and_journal(client):
    import journal
    # Seed a task tagged 'work'.
    data = todo.load(_data_path(client))
    todo.set_tag_color(data, "work", "#5b8dd6")
    data["active"].append({
        "id": "t1", "title": "Plan", "due": None,
        "created": "2026-06-20T09:00:00", "recurrence": None, "tags": ["work"]})
    todo.save(_data_path(client), data)
    # Seed a journal entry tagged 'work'.
    jpath = app_module.app.config["JOURNAL_FILE"]
    jdata = journal._empty()
    sec = journal.add_section(jdata, "work", "tag", "#5b8dd6")
    journal.upsert_entry(jdata, "2026-06-10", "standup", "body",
                         tags={sec["id"]: ["work"]})
    journal.save(jpath, jdata)

    resp = client.get("/tag/work/overview")
    assert resp.status_code == 200
    payload = resp.get_json()
    assert payload["name"] == "work"
    assert "task" in payload and "journal" in payload
    assert payload["task"]["active"] == 1
    assert payload["journal"]["entries"] == 1


def test_tag_overview_route_honors_date_range(client):
    import journal
    jpath = app_module.app.config["JOURNAL_FILE"]
    jdata = journal._empty()
    sec = journal.add_section(jdata, "work", "tag", "#5b8dd6")
    journal.upsert_entry(jdata, "2026-06-01", "old", "body", tags={sec["id"]: ["work"]})
    journal.upsert_entry(jdata, "2026-06-20", "new", "body", tags={sec["id"]: ["work"]})
    journal.save(jpath, jdata)

    resp = client.get("/tag/work/overview?from=2026-06-15&to=2026-06-30")
    payload = resp.get_json()
    assert payload["journal"]["entries"] == 1


def test_tag_overview_route_unknown_tag_is_empty_200(client):
    resp = client.get("/tag/ghost/overview")
    assert resp.status_code == 200
    payload = resp.get_json()
    assert payload["name"] == "ghost"
    assert payload["task"]["active"] == 0
    assert payload["journal"]["entries"] == 0
