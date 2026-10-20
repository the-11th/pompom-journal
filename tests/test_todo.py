"""Tests for the pure core logic in todo.py.

We use a fixed `now` everywhere so date math is deterministic, and pytest's
`tmp_path` fixture for anything that touches the filesystem.
"""

import json
from datetime import datetime, timedelta

import pytest

import todo


def test_task_reference_index_covers_every_state_without_mutating_data():
    data = todo._empty()
    data['active'] = [{'id': 'a', 'title': 'Active review'}]
    data['archive'] = [{'id': 'b', 'title': 'Done review'}]
    data['expired'] = [{'id': 'c', 'title': 'Missed review'}]
    assert todo.task_ref_index(data, {'a', 'b', 'c', 'missing'}) == {
        'a': {'done': False, 'status': 'active', 'title': 'Active review'},
        'b': {'done': True, 'status': 'done', 'title': 'Done review'},
        'c': {'done': False, 'status': 'expired', 'title': 'Missed review'},
        'missing': {'done': False, 'status': 'missing', 'title': ''},
    }
    assert todo.task_ref_index(data, set()) == {}
    assert data['active'] == [{'id': 'a', 'title': 'Active review'}]


# A fixed "current time" used as the reference point in all date tests.
NOW = datetime(2026, 6, 15, 12, 0, 0)


# --------------------------------------------------------------------------- #
# time_remaining
# --------------------------------------------------------------------------- #

def test_time_remaining_no_due():
    assert todo.time_remaining(None, now=NOW) == ""
    assert todo.time_remaining("", now=NOW) == ""


def test_time_remaining_more_than_one_day():
    due = (NOW + timedelta(days=3, hours=2)).isoformat()
    assert todo.time_remaining(due, now=NOW) == "3 day(s) left"


@pytest.mark.parametrize("seconds, expected", [
    (172800, "2 day(s) left"),
    (172799, "47 hour(s) left"),
    (129600, "36 hour(s) left"),
    (86400, "24 hour(s) left"),
])
def test_time_remaining_hours_below_two_days(seconds, expected):
    due = (NOW + timedelta(seconds=seconds)).isoformat()
    assert todo.time_remaining(due, now=NOW) == expected


def test_time_remaining_less_than_day_more_than_hour():
    due = (NOW + timedelta(hours=5)).isoformat()
    assert todo.time_remaining(due, now=NOW) == "5 hour(s) left"


def test_time_remaining_less_than_hour():
    due = (NOW + timedelta(minutes=30)).isoformat()
    assert todo.time_remaining(due, now=NOW) == "due soon"


def test_time_remaining_overdue_days():
    due = (NOW - timedelta(days=2, hours=1)).isoformat()
    assert todo.time_remaining(due, now=NOW) == "overdue by 2 day(s)"


def test_time_remaining_overdue_hours():
    due = (NOW - timedelta(hours=5)).isoformat()
    assert todo.time_remaining(due, now=NOW) == "overdue by 5 hour(s)"


def test_time_remaining_overdue_minutes_says_overdue():
    # Less than an hour past due should NOT say "overdue by 0 hour(s)".
    due = (NOW - timedelta(minutes=30)).isoformat()
    assert todo.time_remaining(due, now=NOW) == "overdue"


def test_time_remaining_exactly_due_is_overdue():
    # The instant it passes (delta == 0) we treat it as overdue, with the
    # bare word "overdue" (under-an-hour tier), never "overdue by 0 hour(s)".
    due = NOW.isoformat()
    assert todo.time_remaining(due, now=NOW) == "overdue"


def test_time_remaining_one_hour_boundary_forward():
    # Exactly 3600 seconds in the future -> "1 hour(s) left".
    due = (NOW + timedelta(hours=1)).isoformat()
    assert todo.time_remaining(due, now=NOW) == "1 hour(s) left"


# --------------------------------------------------------------------------- #
# is_overdue
# --------------------------------------------------------------------------- #

def test_is_overdue_true():
    due = (NOW - timedelta(hours=1)).isoformat()
    assert todo.is_overdue(due, now=NOW) is True


def test_is_overdue_false_future():
    due = (NOW + timedelta(hours=1)).isoformat()
    assert todo.is_overdue(due, now=NOW) is False


def test_is_overdue_false_no_due():
    assert todo.is_overdue(None, now=NOW) is False
    assert todo.is_overdue("", now=NOW) is False


# --------------------------------------------------------------------------- #
# add_task
# --------------------------------------------------------------------------- #

def test_add_task_appends_and_generates_id():
    data = {"active": [], "archive": []}
    todo.add_task(data, "Buy milk")
    assert len(data["active"]) == 1
    task = data["active"][0]
    assert task["title"] == "Buy milk"
    assert task["id"]          # non-empty id generated
    assert len(task["id"]) == 32   # uuid4 hex
    assert task["due"] is None
    assert task["created"]     # created timestamp stored


def test_add_task_stores_due():
    data = {"active": [], "archive": []}
    todo.add_task(data, "Pay rent", due="2026-07-01T00:00:00")
    assert data["active"][0]["due"] == "2026-07-01T00:00:00"


def test_add_task_uses_injected_now_for_created():
    data = {"active": [], "archive": []}
    todo.add_task(data, "Stamped", now=NOW)
    assert data["active"][0]["created"] == NOW.isoformat()


def test_add_task_bad_due_rejected():
    data = {"active": [], "archive": []}
    with pytest.raises(ValueError):
        todo.add_task(data, "Bad date", due="not-a-date")
    assert data["active"] == []   # nothing added


def test_add_task_empty_title_rejected():
    data = {"active": [], "archive": []}
    with pytest.raises(ValueError):
        todo.add_task(data, "")
    with pytest.raises(ValueError):
        todo.add_task(data, "   ")
    assert data["active"] == []   # nothing added


def test_add_task_accepts_safe_client_id_and_rejects_collision():
    data = todo._empty()
    client_id = "12345678-1234-4abc-9def-1234567890ab"
    todo.add_task(data, "offline", task_id=client_id)
    assert data["active"][0]["id"] == client_id
    with pytest.raises(ValueError):
        todo.add_task(data, "duplicate", task_id=client_id)
    with pytest.raises(ValueError):
        todo.add_task(data, "unsafe", task_id="../bad")


# --------------------------------------------------------------------------- #
# delete_task
# --------------------------------------------------------------------------- #

def test_delete_task_removes_from_active():
    data = {"active": [], "archive": []}
    todo.add_task(data, "Task A")
    task_id = data["active"][0]["id"]
    todo.delete_task(data, task_id)
    assert data["active"] == []


def test_delete_task_removes_from_archive():
    data = {
        "active": [],
        "archive": [{"id": "abc", "title": "Old", "due": None,
                     "created": "x", "completed": "y"}],
    }
    todo.delete_task(data, "abc")
    assert data["archive"] == []


def test_delete_task_unknown_id_noop():
    data = {"active": [], "archive": []}
    todo.add_task(data, "Keep me")
    todo.delete_task(data, "does-not-exist")
    assert len(data["active"]) == 1


# --------------------------------------------------------------------------- #
# refresh
# --------------------------------------------------------------------------- #

def test_refresh_moves_checked_to_archive():
    data = {"active": [], "archive": []}
    todo.add_task(data, "Done one")
    todo.add_task(data, "Still active")
    done_id = data["active"][0]["id"]

    todo.refresh(data, [done_id], now=NOW)

    assert len(data["active"]) == 1
    assert data["active"][0]["title"] == "Still active"
    assert len(data["archive"]) == 1
    archived = data["archive"][0]
    assert archived["title"] == "Done one"
    assert archived["completed"] == NOW.isoformat()


def test_refresh_sorts_remaining_active():
    data = {"active": [], "archive": []}
    # soonest due
    todo.add_task(data, "Soon", due=(NOW + timedelta(hours=2)).isoformat())
    # later due
    todo.add_task(data, "Later", due=(NOW + timedelta(days=5)).isoformat())
    todo.refresh(data, [], now=NOW)
    titles = [t["title"] for t in data["active"]]
    assert titles == ["Soon", "Later"]


# --------------------------------------------------------------------------- #
# sort_active
# --------------------------------------------------------------------------- #

def test_sort_active_ordering():
    tasks = [
        {"id": "1", "title": "no_due", "due": None, "created": "x"},
        {"id": "2", "title": "soon",
         "due": (NOW + timedelta(hours=2)).isoformat(), "created": "x"},
        {"id": "3", "title": "very_overdue",
         "due": (NOW - timedelta(days=3)).isoformat(), "created": "x"},
        {"id": "4", "title": "later",
         "due": (NOW + timedelta(days=10)).isoformat(), "created": "x"},
        {"id": "5", "title": "slightly_overdue",
         "due": (NOW - timedelta(hours=1)).isoformat(), "created": "x"},
    ]
    result = todo.sort_active(tasks, now=NOW)
    titles = [t["title"] for t in result]
    # Overdue first (most overdue at top), then soonest-due, no-due last.
    assert titles == ["very_overdue", "slightly_overdue", "soon", "later", "no_due"]


# --------------------------------------------------------------------------- #
# load / save
# --------------------------------------------------------------------------- #

def test_save_and_load_roundtrip(tmp_path):
    path = tmp_path / "tasks.json"
    data = {"active": [], "archive": []}
    todo.add_task(data, "Persist me")
    todo.save(str(path), data)

    loaded = todo.load(str(path))
    assert loaded["active"][0]["title"] == "Persist me"


def test_load_missing_file_returns_default(tmp_path):
    path = tmp_path / "nope.json"
    loaded = todo.load(str(path))
    assert loaded == {"active": [], "archive": [], "expired": [], "tags": {}}


def test_load_corrupt_file_returns_default_and_backs_up(tmp_path):
    path = tmp_path / "tasks.json"
    path.write_text("{not valid json", encoding="utf-8")

    loaded = todo.load(str(path))
    assert loaded == {"active": [], "archive": [], "expired": [], "tags": {}}
    # The corrupt file should have been backed up.
    bak = tmp_path / "tasks.json.bak"
    assert bak.exists()
    assert bak.read_text(encoding="utf-8") == "{not valid json"


def test_load_wrong_shape_returns_default_and_backs_up(tmp_path):
    # Valid JSON, but not our {"active": [...], "archive": [...]} shape.
    path = tmp_path / "tasks.json"
    path.write_text('{"active": []}', encoding="utf-8")   # missing "archive"

    loaded = todo.load(str(path))
    assert loaded == {"active": [], "archive": [], "expired": [], "tags": {}}
    bak = tmp_path / "tasks.json.bak"
    assert bak.exists()
    assert bak.read_text(encoding="utf-8") == '{"active": []}'


def test_load_json_list_returns_default_and_backs_up(tmp_path):
    # Valid JSON of an entirely wrong type (a list, not a dict).
    path = tmp_path / "tasks.json"
    path.write_text("[]", encoding="utf-8")

    loaded = todo.load(str(path))
    assert loaded == {"active": [], "archive": [], "expired": [], "tags": {}}
    bak = tmp_path / "tasks.json.bak"
    assert bak.exists()


def test_save_writes_valid_json(tmp_path):
    path = tmp_path / "tasks.json"
    data = {"active": [], "archive": []}
    todo.save(str(path), data)
    # Readable as JSON directly.
    raw = json.loads(path.read_text(encoding="utf-8"))
    assert raw == {"active": [], "archive": []}


def test_load_missing_expired_key_migrates_not_corrupt(tmp_path):
    # Old-format store: has active + archive but NO "expired" key. This must
    # be migrated gracefully (expired -> []) and NOT treated as corrupt.
    path = tmp_path / "tasks.json"
    path.write_text(
        '{"active": [{"id": "a", "title": "Old", "due": null, '
        '"created": "x"}], "archive": []}',
        encoding="utf-8",
    )
    loaded = todo.load(str(path))
    assert loaded["expired"] == []                 # defaulted in
    assert loaded["active"][0]["title"] == "Old"   # original data preserved
    # No backup should have been made -- this was a valid (older) store.
    assert not (tmp_path / "tasks.json.bak").exists()


def test_load_expired_wrong_type_migrates(tmp_path):
    # "expired" present but not a list -> treated as missing, defaulted to [].
    path = tmp_path / "tasks.json"
    path.write_text(
        '{"active": [], "archive": [], "expired": "oops"}', encoding="utf-8"
    )
    loaded = todo.load(str(path))
    assert loaded["expired"] == []
    assert not (tmp_path / "tasks.json.bak").exists()


# --------------------------------------------------------------------------- #
# add_task -- recurrence
# --------------------------------------------------------------------------- #

def test_add_task_stores_recurrence():
    data = todo._empty()
    todo.add_task(data, "Daily standup",
                  due="2026-07-01T09:00:00", recurrence="daily")
    assert data["active"][0]["recurrence"] == "daily"


def test_add_task_default_recurrence_is_none():
    data = todo._empty()
    todo.add_task(data, "One-off", due="2026-07-01T09:00:00")
    assert data["active"][0]["recurrence"] is None


def test_add_task_recurrence_without_due_defaults_to_2359():
    # A recurring task with no entered due date defaults to 23:59 local,
    # one interval out: daily -> same day.
    data = todo._empty()
    now = datetime(2026, 6, 17, 10, 0, 0)
    todo.add_task(data, "Daily", recurrence="daily", now=now)
    t = data["active"][0]
    assert t["due"] == "2026-06-17T23:59:00"
    assert t["recurrence"] == "daily"


def test_add_task_weekly_without_due_defaults_one_week():
    data = todo._empty()
    now = datetime(2026, 6, 17, 10, 0, 0)
    todo.add_task(data, "Weekly", recurrence="weekly", now=now)
    assert data["active"][0]["due"] == "2026-06-24T23:59:00"


def test_add_task_monthly_without_due_defaults_one_month():
    data = todo._empty()
    now = datetime(2026, 6, 17, 10, 0, 0)
    todo.add_task(data, "Monthly", recurrence="monthly", now=now)
    assert data["active"][0]["due"] == "2026-07-17T23:59:00"


def test_add_task_every_n_without_due_defaults_n_days():
    data = todo._empty()
    now = datetime(2026, 6, 17, 10, 0, 0)
    todo.add_task(data, "Every 3", recurrence="every:3", now=now)
    assert data["active"][0]["due"] == "2026-06-20T23:59:00"


def test_add_task_recurrence_with_due_uses_entered_value():
    # An explicit due date is always honored, even with a recurrence.
    data = todo._empty()
    now = datetime(2026, 6, 17, 10, 0, 0)
    todo.add_task(data, "Has due", due="2026-09-01T09:00:00",
                  recurrence="daily", now=now)
    assert data["active"][0]["due"] == "2026-09-01T09:00:00"


def test_add_task_bad_recurrence_rejected():
    data = todo._empty()
    with pytest.raises(ValueError):
        todo.add_task(data, "Bad", due="2026-07-01T09:00:00",
                      recurrence="hourly")
    with pytest.raises(ValueError):
        todo.add_task(data, "Bad N", due="2026-07-01T09:00:00",
                      recurrence="every:0")
    assert data["active"] == []


def test_add_task_custom_interval_ok():
    data = todo._empty()
    todo.add_task(data, "Every 3 days",
                  due="2026-07-01T09:00:00", recurrence="every:3")
    assert data["active"][0]["recurrence"] == "every:3"


# --------------------------------------------------------------------------- #
# edit_task
# --------------------------------------------------------------------------- #

def test_edit_task_updates_title_and_due():
    data = todo._empty()
    todo.add_task(data, "Old title")
    tid = data["active"][0]["id"]
    todo.edit_task(data, tid, "New title", due="2026-08-01T10:00:00")
    task = data["active"][0]
    assert task["title"] == "New title"
    assert task["due"] == "2026-08-01T10:00:00"


def test_edit_task_can_set_recurrence():
    data = todo._empty()
    todo.add_task(data, "Task", due="2026-08-01T10:00:00")
    tid = data["active"][0]["id"]
    todo.edit_task(data, tid, "Task", due="2026-08-01T10:00:00",
                   recurrence="weekly")
    assert data["active"][0]["recurrence"] == "weekly"


def test_edit_task_can_clear_due_and_recurrence():
    data = todo._empty()
    todo.add_task(data, "Task", due="2026-08-01T10:00:00", recurrence="daily")
    tid = data["active"][0]["id"]
    todo.edit_task(data, tid, "Task")   # no due, no recurrence
    assert data["active"][0]["due"] is None
    assert data["active"][0]["recurrence"] is None


def test_edit_task_empty_title_rejected():
    data = todo._empty()
    todo.add_task(data, "Keep")
    tid = data["active"][0]["id"]
    with pytest.raises(ValueError):
        todo.edit_task(data, tid, "   ")
    assert data["active"][0]["title"] == "Keep"   # unchanged


def test_edit_task_bad_due_rejected():
    data = todo._empty()
    todo.add_task(data, "Keep")
    tid = data["active"][0]["id"]
    with pytest.raises(ValueError):
        todo.edit_task(data, tid, "Keep", due="nope")


def test_edit_task_recurrence_without_due_defaults():
    data = todo._empty()
    todo.add_task(data, "Keep")
    tid = data["active"][0]["id"]
    now = datetime(2026, 6, 17, 10, 0, 0)
    todo.edit_task(data, tid, "Keep", recurrence="weekly", now=now)
    assert data["active"][0]["due"] == "2026-06-24T23:59:00"
    assert data["active"][0]["recurrence"] == "weekly"


def test_edit_task_unknown_id_is_noop():
    data = todo._empty()
    todo.add_task(data, "Keep")
    # Should not raise and should not change anything.
    todo.edit_task(data, "does-not-exist", "Whatever")
    assert data["active"][0]["title"] == "Keep"


# --------------------------------------------------------------------------- #
# next_occurrence
# --------------------------------------------------------------------------- #

def test_next_occurrence_daily():
    nxt = todo.next_occurrence("2026-06-15T09:00:00", "daily")
    assert nxt == "2026-06-16T09:00:00"


def test_next_occurrence_weekly():
    nxt = todo.next_occurrence("2026-06-15T09:00:00", "weekly")
    assert nxt == "2026-06-22T09:00:00"


def test_next_occurrence_monthly():
    nxt = todo.next_occurrence("2026-06-15T09:00:00", "monthly")
    assert nxt == "2026-07-15T09:00:00"


def test_next_occurrence_monthly_month_end_clamp():
    # Jan 31 + 1 month -> Feb 28 (2026 is not a leap year).
    nxt = todo.next_occurrence("2026-01-31T09:00:00", "monthly")
    assert nxt == "2026-02-28T09:00:00"


def test_next_occurrence_monthly_leap_year_clamp():
    # Jan 31, 2028 + 1 month -> Feb 29 (2028 is a leap year).
    nxt = todo.next_occurrence("2028-01-31T09:00:00", "monthly")
    assert nxt == "2028-02-29T09:00:00"


def test_next_occurrence_monthly_year_rollover():
    nxt = todo.next_occurrence("2026-12-10T09:00:00", "monthly")
    assert nxt == "2027-01-10T09:00:00"


def test_next_occurrence_custom_interval():
    nxt = todo.next_occurrence("2026-06-15T09:00:00", "every:3")
    assert nxt == "2026-06-18T09:00:00"


def test_next_occurrence_none_recurrence():
    assert todo.next_occurrence("2026-06-15T09:00:00", None) is None


def test_next_occurrence_bad_due():
    assert todo.next_occurrence("not-a-date", "daily") is None


# --------------------------------------------------------------------------- #
# refresh -- recurring expiry / spawn flow
# --------------------------------------------------------------------------- #

def test_refresh_completed_recurring_archives_and_spawns_next():
    data = todo._empty()
    todo.add_task(data, "Daily report",
                  due=(NOW + timedelta(hours=2)).isoformat(),
                  recurrence="daily")
    tid = data["active"][0]["id"]

    todo.refresh(data, [tid], now=NOW)

    # Original archived with completed stamp.
    assert len(data["archive"]) == 1
    assert data["archive"][0]["completed"] == NOW.isoformat()
    # A fresh occurrence spawned into active, one day later, new id.
    assert len(data["active"]) == 1
    spawned = data["active"][0]
    assert spawned["id"] != tid
    assert spawned["title"] == "Daily report"
    assert spawned["recurrence"] == "daily"
    assert todo._parse(spawned["due"]) == NOW + timedelta(days=1, hours=2)


def test_refresh_completed_non_recurring_just_archives():
    data = todo._empty()
    todo.add_task(data, "One off", due=(NOW + timedelta(hours=2)).isoformat())
    tid = data["active"][0]["id"]
    todo.refresh(data, [tid], now=NOW)
    assert len(data["archive"]) == 1
    assert data["active"] == []   # nothing spawned


def test_refresh_missed_recurring_moves_to_expired_and_spawns():
    data = todo._empty()
    # A daily task that was due yesterday and NOT completed.
    missed_due = (NOW - timedelta(days=1)).isoformat()
    todo.add_task(data, "Timesheet", due=missed_due, recurrence="daily")
    tid = data["active"][0]["id"]

    todo.refresh(data, [], now=NOW)

    # Missed occurrence moved to expired (with expired_at stamp).
    assert len(data["expired"]) == 1
    expired = data["expired"][0]
    assert expired["id"] == tid
    assert expired["due"] == missed_due
    assert expired["expired_at"] == NOW.isoformat()
    # Next future occurrence spawned into active.
    assert len(data["active"]) == 1
    spawned = data["active"][0]
    assert spawned["id"] != tid
    assert spawned["title"] == "Timesheet"
    # Must be strictly in the future relative to now.
    assert todo._parse(spawned["due"]) > NOW
    # First future daily occurrence after (NOW - 1 day) is NOW + ... actually
    # yesterday's due + 1 day = today's due, which here equals NOW exactly,
    # so it advances once more to be strictly future.
    assert todo._parse(spawned["due"]) == NOW + timedelta(days=1)


def test_refresh_missed_recurring_skips_multiple_intervals():
    data = todo._empty()
    # Due 5 days ago, daily -> next future occurrence is tomorrow's stamp.
    missed_due = (NOW - timedelta(days=5)).isoformat()
    todo.add_task(data, "Old daily", due=missed_due, recurrence="daily")
    todo.refresh(data, [], now=NOW)
    spawned = data["active"][0]
    # Advances past now: (NOW - 5d) + 6 days = NOW + 1 day.
    assert todo._parse(spawned["due"]) == NOW + timedelta(days=1)


def test_refresh_non_recurring_overdue_stays_active():
    data = todo._empty()
    todo.add_task(data, "Overdue chore",
                  due=(NOW - timedelta(days=2)).isoformat())
    todo.refresh(data, [], now=NOW)
    assert len(data["active"]) == 1
    assert data["active"][0]["title"] == "Overdue chore"
    assert data["expired"] == []


def test_refresh_future_recurring_left_alone():
    data = todo._empty()
    todo.add_task(data, "Future weekly",
                  due=(NOW + timedelta(days=3)).isoformat(),
                  recurrence="weekly")
    tid = data["active"][0]["id"]
    todo.refresh(data, [], now=NOW)
    # Not overdue -> untouched, same id, nothing expired.
    assert len(data["active"]) == 1
    assert data["active"][0]["id"] == tid
    assert data["expired"] == []


# --------------------------------------------------------------------------- #
# Tags -- registry / colors (set_tag_color, tag_color)
# --------------------------------------------------------------------------- #

def test_set_tag_color_creates_entry():
    data = todo._empty()
    todo.set_tag_color(data, "work", "#e0a955")
    assert data["tags"]["work"] == "#e0a955"


def test_set_tag_color_updates_existing():
    data = todo._empty()
    todo.set_tag_color(data, "work", "#e0a955")
    todo.set_tag_color(data, "work", "#123456")
    assert data["tags"]["work"] == "#123456"


def test_set_tag_color_normalizes_name():
    # Names are stripped and lowercased for consistency.
    data = todo._empty()
    todo.set_tag_color(data, "  WORK ", "#e0a955")
    assert "work" in data["tags"]
    assert "  WORK " not in data["tags"]


def test_set_tag_color_accepts_short_hex():
    data = todo._empty()
    todo.set_tag_color(data, "tag", "#abc")
    assert data["tags"]["tag"] == "#abc"


def test_set_tag_color_empty_name_rejected():
    data = todo._empty()
    with pytest.raises(ValueError):
        todo.set_tag_color(data, "   ", "#e0a955")
    assert data["tags"] == {}


def test_set_tag_color_bad_color_rejected():
    data = todo._empty()
    with pytest.raises(ValueError):
        todo.set_tag_color(data, "work", "red")
    with pytest.raises(ValueError):
        todo.set_tag_color(data, "work", "#xyz")
    with pytest.raises(ValueError):
        todo.set_tag_color(data, "work", "#12")     # wrong length
    assert data["tags"] == {}


def test_set_tag_color_accepts_allowed_names():
    # Names made of Unicode letters/numbers, spaces, underscores, hyphens,
    # and periods are allowed.
    data = todo._empty()
    for name in ["work", "work item", "high-priority", "q1_2026", "a1 b2",
                 "id.me office", "naïve", "中文"]:
        todo.set_tag_color(data, name, "#abc")
        assert name in data["tags"]


def test_set_tag_color_normalizes_name_with_period():
    data = todo._empty()
    todo.set_tag_color(data, "ID.me Office", "#abcdef")
    assert data["tags"] == {"id.me office": "#abcdef"}


def test_set_tag_color_rejects_injection_chars():
    # Anything outside the allowlist (e.g. HTML/JS/CSS metacharacters) is
    # rejected so the no-injection invariant is explicit, not just relying
    # on Jinja escaping.
    data = todo._empty()
    for bad in ["<script>", "a;b", "a{b}", 'a"b', "a'b", "a&b", "tag<"]:
        with pytest.raises(ValueError):
            todo.set_tag_color(data, bad, "#abc")
    assert data["tags"] == {}


def test_tag_color_registered():
    data = todo._empty()
    todo.set_tag_color(data, "work", "#e0a955")
    assert todo.tag_color(data, "work") == "#e0a955"


def test_tag_color_unregistered_returns_default():
    data = todo._empty()
    # Some sensible neutral grey default for an unknown tag.
    assert todo.tag_color(data, "ghost") == todo.DEFAULT_TAG_COLOR


# --------------------------------------------------------------------------- #
# Tags -- delete_tag
# --------------------------------------------------------------------------- #

def test_delete_tag_removes_from_registry():
    data = todo._empty()
    todo.set_tag_color(data, "work", "#e0a955")
    todo.delete_tag(data, "work")
    assert "work" not in data["tags"]


def test_delete_tag_removes_from_tasks_across_all_lists():
    # A tag attached to tasks in active, archive AND expired is scrubbed from
    # every one of them when the tag is deleted.
    data = todo._empty()
    todo.set_tag_color(data, "work", "#e0a955")
    data["active"].append({"id": "a", "title": "A", "due": None,
                           "created": "x", "tags": ["work"]})
    data["archive"].append({"id": "b", "title": "B", "due": None,
                            "created": "x", "tags": ["work"]})
    data["expired"].append({"id": "c", "title": "C", "due": None,
                            "created": "x", "tags": ["work"]})

    todo.delete_tag(data, "work")

    assert data["active"][0]["tags"] == []
    assert data["archive"][0]["tags"] == []
    assert data["expired"][0]["tags"] == []


def test_delete_tag_unknown_name_is_noop():
    data = todo._empty()
    todo.set_tag_color(data, "work", "#e0a955")
    todo.delete_tag(data, "ghost")   # not in registry
    assert data["tags"] == {"work": "#e0a955"}


def test_delete_tag_preserves_other_tags_on_task():
    # Deleting one tag must leave a task's OTHER tags intact.
    data = todo._empty()
    todo.set_tag_color(data, "work", "#e0a955")
    todo.set_tag_color(data, "home", "#3fae5a")
    data["active"].append({"id": "a", "title": "A", "due": None,
                           "created": "x", "tags": ["work", "home"]})

    todo.delete_tag(data, "work")

    assert data["active"][0]["tags"] == ["home"]


def test_delete_tag_normalizes_name():
    # The name is stripped + lowercased like elsewhere.
    data = todo._empty()
    todo.set_tag_color(data, "work", "#e0a955")
    data["active"].append({"id": "a", "title": "A", "due": None,
                           "created": "x", "tags": ["work"]})
    todo.delete_tag(data, "  WORK ")
    assert "work" not in data["tags"]
    assert data["active"][0]["tags"] == []


def test_delete_tag_returns_data():
    data = todo._empty()
    todo.set_tag_color(data, "work", "#e0a955")
    assert todo.delete_tag(data, "work") is data


# --------------------------------------------------------------------------- #
# Tags -- add_task / edit_task normalization
# --------------------------------------------------------------------------- #

def test_add_task_default_tags_empty():
    data = todo._empty()
    todo.add_task(data, "No tags")
    assert data["active"][0]["tags"] == []


def test_add_task_stores_tags_normalized():
    data = todo._empty()
    todo.add_task(data, "Tagged", tags=["  Work ", "URGENT"])
    assert data["active"][0]["tags"] == ["work", "urgent"]


def test_add_task_tags_dedup_and_drop_blanks():
    data = todo._empty()
    todo.add_task(data, "Tagged", tags=["work", "", "  ", "Work", "urgent", "work"])
    # Blanks dropped, de-duplicated, order preserved.
    assert data["active"][0]["tags"] == ["work", "urgent"]


def test_edit_task_updates_tags():
    data = todo._empty()
    todo.add_task(data, "Task", tags=["old"])
    tid = data["active"][0]["id"]
    todo.edit_task(data, tid, "Task", tags=["New", "new", "  shiny  "])
    assert data["active"][0]["tags"] == ["new", "shiny"]


def test_edit_task_default_tags_empty():
    data = todo._empty()
    todo.add_task(data, "Task", tags=["old"])
    tid = data["active"][0]["id"]
    todo.edit_task(data, tid, "Task")   # no tags -> cleared to []
    assert data["active"][0]["tags"] == []


def test_normalize_tags_skips_non_string_elements():
    # A hand-edited JSON file might leave non-strings in a tags list
    # (e.g. "tags": [1, null]); we skip them instead of crashing.
    assert todo._normalize_tags(["work", 1, None, "home", True]) == ["work", "home"]
    assert todo._normalize_tags([1, None]) == []


# --------------------------------------------------------------------------- #
# Tags -- filter_by_tags (OR / union semantics)
# --------------------------------------------------------------------------- #

def _tagged(title, tags):
    return {"id": title, "title": title, "due": None, "created": "x", "tags": tags}


def test_filter_by_tags_empty_selection_returns_all():
    tasks = [_tagged("a", ["work"]), _tagged("b", [])]
    assert todo.filter_by_tags(tasks, []) == tasks


def test_filter_by_tags_single_tag():
    tasks = [_tagged("a", ["work"]), _tagged("b", ["home"])]
    result = todo.filter_by_tags(tasks, ["work"])
    assert [t["title"] for t in result] == ["a"]


def test_filter_by_tags_union_multiple():
    tasks = [
        _tagged("a", ["work"]),
        _tagged("b", ["home"]),
        _tagged("c", ["errand"]),
    ]
    # OR semantics: a task matches if it has ANY of the selected tags.
    result = todo.filter_by_tags(tasks, ["work", "home"])
    assert [t["title"] for t in result] == ["a", "b"]


def test_filter_by_tags_no_tag_task_excluded_under_filter():
    tasks = [_tagged("a", ["work"]), _tagged("b", [])]
    result = todo.filter_by_tags(tasks, ["work"])
    assert [t["title"] for t in result] == ["a"]


def test_filter_by_tags_handles_missing_tags_field():
    # A task without a "tags" key is treated as having no tags.
    tasks = [{"id": "x", "title": "x", "due": None, "created": "x"}]
    assert todo.filter_by_tags(tasks, ["work"]) == []


# --------------------------------------------------------------------------- #
# Tags -- text_color_for (readable text over a colored background)
# --------------------------------------------------------------------------- #

def test_text_color_for_light_bg_is_black():
    assert todo.text_color_for("#ffffff") == "#000000"
    assert todo.text_color_for("#e0a955") == "#000000"   # default amber
    assert todo.text_color_for("#3fae5a") == "#000000"   # mid green


def test_text_color_for_dark_bg_is_white():
    assert todo.text_color_for("#000000") == "#ffffff"
    assert todo.text_color_for("#14161a") == "#ffffff"   # near-black panel
    assert todo.text_color_for("#2b5cb8") == "#ffffff"   # deep blue


def test_text_color_for_short_hex():
    assert todo.text_color_for("#fff") == "#000000"
    assert todo.text_color_for("#000") == "#ffffff"


# --------------------------------------------------------------------------- #
# Tags -- load backward compatibility
# --------------------------------------------------------------------------- #

def test_empty_includes_tags_registry():
    assert todo._empty()["tags"] == {}


def test_load_missing_tags_registry_migrates_not_corrupt(tmp_path):
    # A store with active/archive/expired but NO "tags" key must migrate to {}
    # and NOT be treated as corrupt (no backup).
    path = tmp_path / "tasks.json"
    path.write_text(
        '{"active": [{"id": "a", "title": "Old", "due": null, '
        '"created": "x"}], "archive": [], "expired": []}',
        encoding="utf-8",
    )
    loaded = todo.load(str(path))
    assert loaded["tags"] == {}                    # defaulted in
    # Task missing its own "tags" field is defaulted to [].
    assert loaded["active"][0]["tags"] == []
    assert not (tmp_path / "tasks.json.bak").exists()


def test_load_tags_wrong_type_migrates(tmp_path):
    # "tags" present but not a dict -> treated as missing, defaulted to {}.
    path = tmp_path / "tasks.json"
    path.write_text(
        '{"active": [], "archive": [], "tags": "oops"}', encoding="utf-8"
    )
    loaded = todo.load(str(path))
    assert loaded["tags"] == {}
    assert not (tmp_path / "tasks.json.bak").exists()


# --------------------------------------------------------------------------- #
# Difficulty
# --------------------------------------------------------------------------- #

def test_norm_difficulty():
    assert todo._norm_difficulty(" Hard ") == "hard"
    assert todo._norm_difficulty("MEDIUM") == "medium"
    assert todo._norm_difficulty("bogus") is None
    assert todo._norm_difficulty("") is None
    assert todo._norm_difficulty(None) is None


def test_refresh_stamps_difficulty_on_completed():
    data = todo._empty()
    todo.add_task(data, "rate me", now=NOW)
    tid = data["active"][0]["id"]
    todo.refresh(data, [tid], difficulties={tid: "hard"}, now=NOW)
    assert data["active"] == []
    assert data["archive"][0]["difficulty"] == "hard"


def test_refresh_ignores_invalid_difficulty_and_missing():
    data = todo._empty()
    todo.add_task(data, "a", now=NOW)
    todo.add_task(data, "b", now=NOW)
    a, b = data["active"][0]["id"], data["active"][1]["id"]
    todo.refresh(data, [a, b], difficulties={a: "nope"}, now=NOW)  # b has none
    arch = {t["title"]: t for t in data["archive"]}
    assert "difficulty" not in arch["a"]      # invalid -> unrated
    assert "difficulty" not in arch["b"]      # not provided -> unrated


def test_refresh_difficulty_not_carried_to_spawned_recurrence():
    data = todo._empty()
    due = NOW.isoformat()
    todo.add_task(data, "daily", due=due, recurrence="daily", now=NOW)
    tid = data["active"][0]["id"]
    todo.refresh(data, [tid], difficulties={tid: "easy"}, now=NOW)
    assert data["archive"][0]["difficulty"] == "easy"
    assert "difficulty" not in data["active"][0]   # fresh occurrence is unrated


def test_set_difficulty_sets_and_clears():
    data = todo._empty()
    todo.add_task(data, "x", now=NOW)
    tid = data["active"][0]["id"]
    todo.refresh(data, [tid], now=NOW)            # archive it (unrated)
    todo.set_difficulty(data, tid, "medium")
    assert data["archive"][0]["difficulty"] == "medium"
    todo.set_difficulty(data, tid, "")            # clear
    assert "difficulty" not in data["archive"][0]
    todo.set_difficulty(data, "ghost", "hard")    # unknown id = no-op (no raise)


# --------------------------------------------------------------------------- #
# Task notes
# --------------------------------------------------------------------------- #

def test_add_task_initializes_notes_and_subtasks():
    data = todo._empty()
    todo.add_task(data, "Task", now=NOW)
    t = data["active"][0]
    assert t["notes"] == ""
    assert t["subtasks"] == []


def test_set_task_notes_sets_and_strips():
    data = todo._empty()
    todo.add_task(data, "Task", now=NOW)
    tid = data["active"][0]["id"]
    todo.set_task_notes(data, tid, "  buy milk  ")
    assert data["active"][0]["notes"] == "buy milk"


def test_set_task_notes_can_clear():
    data = todo._empty()
    todo.add_task(data, "Task", now=NOW)
    tid = data["active"][0]["id"]
    todo.set_task_notes(data, tid, "something")
    todo.set_task_notes(data, tid, "")
    assert data["active"][0]["notes"] == ""


def test_set_task_notes_unknown_id_noop():
    data = todo._empty()
    todo.add_task(data, "Task", now=NOW)
    todo.set_task_notes(data, "ghost", "x")   # no raise
    assert data["active"][0]["notes"] == ""


# --------------------------------------------------------------------------- #
# Subtasks
# --------------------------------------------------------------------------- #

def test_add_subtask_appends_undone():
    data = todo._empty()
    todo.add_task(data, "Task", now=NOW)
    tid = data["active"][0]["id"]
    todo.add_subtask(data, tid, "  step one  ")
    subs = data["active"][0]["subtasks"]
    assert subs == [{"text": "step one", "done": False}]


def test_add_subtask_empty_raises():
    data = todo._empty()
    todo.add_task(data, "Task", now=NOW)
    tid = data["active"][0]["id"]
    with pytest.raises(ValueError):
        todo.add_subtask(data, tid, "   ")


def test_add_subtask_unknown_id_noop():
    data = todo._empty()
    todo.add_task(data, "Task", now=NOW)
    tid = data["active"][0]["id"]
    todo.add_subtask(data, "ghost", "x")
    assert data["active"][0]["subtasks"] == []


def test_replace_subtasks_validates_and_copies_rows():
    data = todo._empty()
    todo.add_task(data, "trip")
    task_id = data["active"][0]["id"]
    rows = [{"text": " Pack ", "done": True}]
    todo.replace_subtasks(data, task_id, rows)
    assert data["active"][0]["subtasks"] == [{"text": "Pack", "done": True}]
    rows[0]["text"] = "mutated"
    assert data["active"][0]["subtasks"][0]["text"] == "Pack"
    with pytest.raises(ValueError):
        todo.replace_subtasks(data, task_id, [{"text": "", "done": False}])


def test_reopen_task_moves_completed_task_back_to_active():
    data = todo._empty()
    todo.add_task(data, "Reconsider this")
    task_id = data["active"][0]["id"]
    todo.refresh(data, [task_id], difficulties={task_id: "easy"})

    todo.reopen_task(data, task_id)

    task, status = todo.task_by_id(data, task_id)
    assert status == "active"
    assert task["title"] == "Reconsider this"
    assert "completed" not in task
    assert "difficulty" not in task


def test_toggle_subtask_flips_done():
    data = todo._empty()
    todo.add_task(data, "Task", now=NOW)
    tid = data["active"][0]["id"]
    todo.add_subtask(data, tid, "a")
    todo.toggle_subtask(data, tid, 0)
    assert data["active"][0]["subtasks"][0]["done"] is True
    todo.toggle_subtask(data, tid, 0)
    assert data["active"][0]["subtasks"][0]["done"] is False


def test_toggle_subtask_out_of_range_noop():
    data = todo._empty()
    todo.add_task(data, "Task", now=NOW)
    tid = data["active"][0]["id"]
    todo.add_subtask(data, tid, "a")
    todo.toggle_subtask(data, tid, 5)       # no raise, no change
    todo.toggle_subtask(data, "ghost", 0)
    assert data["active"][0]["subtasks"][0]["done"] is False


def test_edit_subtask_replaces_text():
    data = todo._empty()
    todo.add_task(data, "Task", now=NOW)
    tid = data["active"][0]["id"]
    todo.add_subtask(data, tid, "old")
    todo.edit_subtask(data, tid, 0, "  new  ")
    assert data["active"][0]["subtasks"][0]["text"] == "new"


def test_edit_subtask_empty_raises():
    data = todo._empty()
    todo.add_task(data, "Task", now=NOW)
    tid = data["active"][0]["id"]
    todo.add_subtask(data, tid, "old")
    with pytest.raises(ValueError):
        todo.edit_subtask(data, tid, 0, "  ")


def test_edit_subtask_out_of_range_noop():
    data = todo._empty()
    todo.add_task(data, "Task", now=NOW)
    tid = data["active"][0]["id"]
    todo.add_subtask(data, tid, "old")
    todo.edit_subtask(data, tid, 9, "new")    # no raise, no change
    assert data["active"][0]["subtasks"][0]["text"] == "old"


def test_delete_subtask_removes_at_index():
    data = todo._empty()
    todo.add_task(data, "Task", now=NOW)
    tid = data["active"][0]["id"]
    todo.add_subtask(data, tid, "a")
    todo.add_subtask(data, tid, "b")
    todo.delete_subtask(data, tid, 0)
    assert [s["text"] for s in data["active"][0]["subtasks"]] == ["b"]


def test_delete_subtask_out_of_range_noop():
    data = todo._empty()
    todo.add_task(data, "Task", now=NOW)
    tid = data["active"][0]["id"]
    todo.add_subtask(data, tid, "a")
    todo.delete_subtask(data, tid, 9)
    todo.delete_subtask(data, "ghost", 0)
    assert len(data["active"][0]["subtasks"]) == 1


def _abc(data, tid):
    todo.add_subtask(data, tid, "a")
    todo.add_subtask(data, tid, "b")
    todo.add_subtask(data, tid, "c")


def test_reorder_subtask_move_down():
    data = todo._empty()
    todo.add_task(data, "Task", now=NOW)
    tid = data["active"][0]["id"]
    _abc(data, tid)
    todo.reorder_subtask(data, tid, 0, 2)
    assert [s["text"] for s in data["active"][0]["subtasks"]] == ["b", "c", "a"]


def test_reorder_subtask_move_up():
    data = todo._empty()
    todo.add_task(data, "Task", now=NOW)
    tid = data["active"][0]["id"]
    _abc(data, tid)
    todo.reorder_subtask(data, tid, 2, 0)
    assert [s["text"] for s in data["active"][0]["subtasks"]] == ["c", "a", "b"]


def test_reorder_subtask_same_index_noop():
    data = todo._empty()
    todo.add_task(data, "Task", now=NOW)
    tid = data["active"][0]["id"]
    _abc(data, tid)
    todo.reorder_subtask(data, tid, 1, 1)
    assert [s["text"] for s in data["active"][0]["subtasks"]] == ["a", "b", "c"]


def test_reorder_subtask_out_of_range_noop():
    data = todo._empty()
    todo.add_task(data, "Task", now=NOW)
    tid = data["active"][0]["id"]
    _abc(data, tid)
    todo.reorder_subtask(data, tid, 9, 0)     # from out of range
    todo.reorder_subtask(data, tid, 0, 9)     # to out of range
    todo.reorder_subtask(data, tid, -1, 0)    # negative from
    assert [s["text"] for s in data["active"][0]["subtasks"]] == ["a", "b", "c"]


def test_reorder_subtask_unknown_id_noop():
    data = todo._empty()
    todo.add_task(data, "Task", now=NOW)
    tid = data["active"][0]["id"]
    _abc(data, tid)
    todo.reorder_subtask(data, "ghost", 0, 2)
    assert [s["text"] for s in data["active"][0]["subtasks"]] == ["a", "b", "c"]


# --------------------------------------------------------------------------- #
# Recurrence copies notes + subtasks (done reset)
# --------------------------------------------------------------------------- #

def test_refresh_recurring_copies_notes_and_resets_subtasks():
    data = todo._empty()
    todo.add_task(data, "Daily report",
                  due=(NOW + timedelta(hours=2)).isoformat(),
                  recurrence="daily", now=NOW)
    tid = data["active"][0]["id"]
    todo.set_task_notes(data, tid, "remember details")
    todo.add_subtask(data, tid, "part a")
    todo.add_subtask(data, tid, "part b")
    todo.toggle_subtask(data, tid, 0)       # mark first done

    todo.refresh(data, [tid], now=NOW)

    # Archived occurrence keeps its checked state.
    archived = data["archive"][0]
    assert archived["subtasks"][0]["done"] is True
    # Spawned occurrence copies notes + subtask text, all done reset to False.
    spawned = data["active"][0]
    assert spawned["notes"] == "remember details"
    assert [s["text"] for s in spawned["subtasks"]] == ["part a", "part b"]
    assert all(s["done"] is False for s in spawned["subtasks"])
    # Deep copy: mutating the spawned subtask must not touch the archived one.
    spawned["subtasks"][1]["done"] = True
    assert archived["subtasks"][1]["done"] is False


# --------------------------------------------------------------------------- #
# Tag pages / backlinks: todo.tag_overview
# --------------------------------------------------------------------------- #

def _tag_data():
    """A task store with active/archive/expired tasks tagged 'work'."""
    data = todo._empty()
    todo.set_tag_color(data, "work", "#5b8dd6")
    todo.set_tag_color(data, "home", "#6bbf73")
    # active task, tagged work + home
    data["active"].append({
        "id": "a1", "title": "Plan sprint", "due": "2026-06-30T17:00:00",
        "created": "2026-06-20T09:00:00", "recurrence": None,
        "tags": ["work", "home"]})
    # completed early: due 06-25, completed 06-23 -> 2 days early
    data["archive"].append({
        "id": "c1", "title": "Finish report", "due": "2026-06-25T17:00:00",
        "completed": "2026-06-23T17:00:00", "created": "2026-06-15T09:00:00",
        "recurrence": None, "tags": ["work"]})
    # completed late: due 06-20, completed 06-22 -> 2 days late
    data["archive"].append({
        "id": "c2", "title": "Review PRs", "due": "2026-06-20T17:00:00",
        "completed": "2026-06-22T17:00:00", "created": "2026-06-10T09:00:00",
        "recurrence": None, "tags": ["work", "home"]})
    # completed, no due -> excluded from lead-time
    data["archive"].append({
        "id": "c3", "title": "Misc", "due": None,
        "completed": "2026-06-21T17:00:00", "created": "2026-06-10T09:00:00",
        "recurrence": None, "tags": ["work"]})
    # expired
    data["expired"].append({
        "id": "e1", "title": "Missed thing", "due": "2026-06-18T17:00:00",
        "expired_at": "2026-06-19T00:00:00", "created": "2026-06-12T09:00:00",
        "recurrence": "daily", "tags": ["work"]})
    return data


def test_todo_tag_overview_counts_across_buckets():
    ov = todo.tag_overview(_tag_data(), "work")
    assert ov["exists"] is True
    assert ov["color"] == "#5b8dd6"
    assert ov["active"] == 1
    assert ov["completed"] == 3
    assert ov["expired"] == 1


def test_todo_tag_overview_case_insensitive():
    assert todo.tag_overview(_tag_data(), "WORK")["completed"] == 3


def test_todo_tag_overview_lead_time_positive_is_early():
    ov = todo.tag_overview(_tag_data(), "work")
    # c1: 2 days early (+2); c2: 2 days late (-2); c3: no due -> excluded.
    # mean(+2, -2) = 0.0
    assert ov["lead_time_days"] == 0.0


def test_todo_tag_overview_lead_time_null_when_no_due():
    data = todo._empty()
    todo.set_tag_color(data, "x", "#5b8dd6")
    data["archive"].append({
        "id": "n", "title": "no due", "due": None,
        "completed": "2026-06-21T17:00:00", "created": "2026-06-10T09:00:00",
        "recurrence": None, "tags": ["x"]})
    assert todo.tag_overview(data, "x")["lead_time_days"] is None


def test_todo_tag_overview_cooccurrence():
    ov = todo.tag_overview(_tag_data(), "work")
    names = {c["name"]: c["count"] for c in ov["cooccurring"]}
    # 'home' shares a1 (active) and c2 (archive) -> 2; 'work' excluded
    assert names.get("home") == 2
    assert all(c["name"] != "work" for c in ov["cooccurring"])


def test_todo_tag_overview_timeline():
    ov = todo.tag_overview(_tag_data(), "work")
    assert len(ov["timeline"]) == 5
    row = ov["timeline"][0]
    assert set(row) >= {"date", "title", "status", "due", "completed"}
    statuses = {r["title"]: r["status"] for r in ov["timeline"]}
    assert statuses["Plan sprint"] == "active"
    assert statuses["Finish report"] == "completed"
    assert statuses["Missed thing"] == "expired"


def test_todo_tag_overview_first_last():
    ov = todo.tag_overview(_tag_data(), "work")
    assert ov["first"] is not None and ov["last"] is not None


def test_todo_tag_overview_date_filter():
    ov = todo.tag_overview(_tag_data(), "work",
                           start="2026-06-23", end="2026-06-30")
    # only c1 (completed 06-23) among the dated occurrences within range
    assert ov["completed"] == 1


def test_todo_tag_overview_unknown_tag_empty():
    ov = todo.tag_overview(_tag_data(), "ghost")
    assert ov["exists"] is False
    assert ov["active"] == 0 and ov["completed"] == 0 and ov["expired"] == 0
    assert ov["lead_time_days"] is None
    assert ov["cooccurring"] == []
    assert ov["timeline"] == []
    assert ov["first"] is None and ov["last"] is None


# --------------------------------------------------------------------------- #
# parse_due_token — inline >due grammar (Spec 2: [] task spawning)
# NOW is 2026-06-15 (a Monday) at 12:00.
# --------------------------------------------------------------------------- #

def test_parse_due_token_iso():
    assert todo.parse_due_token("2026-07-04", now=NOW) == "2026-07-04T23:59:00"


def test_parse_due_token_today():
    assert todo.parse_due_token("today", now=NOW) == "2026-06-15T23:59:00"


def test_parse_due_token_tomorrow():
    assert todo.parse_due_token("tomorrow", now=NOW) == "2026-06-16T23:59:00"


def test_parse_due_token_weekday_full():
    # NOW is Monday 06-15; "friday" -> next Friday 06-19.
    assert todo.parse_due_token("friday", now=NOW) == "2026-06-19T23:59:00"


def test_parse_due_token_weekday_3letter():
    assert todo.parse_due_token("fri", now=NOW) == "2026-06-19T23:59:00"


def test_parse_due_token_weekday_today_is_that_weekday():
    # NOW is Monday; "monday"/"mon" resolve to today (on/after today).
    assert todo.parse_due_token("monday", now=NOW) == "2026-06-15T23:59:00"
    assert todo.parse_due_token("mon", now=NOW) == "2026-06-15T23:59:00"


def test_parse_due_token_relative_days():
    assert todo.parse_due_token("+3d", now=NOW) == "2026-06-18T23:59:00"


def test_parse_due_token_relative_weeks():
    assert todo.parse_due_token("+2w", now=NOW) == "2026-06-29T23:59:00"


def test_parse_due_token_relative_months():
    # +1m reuses _add_one_month: 06-15 -> 07-15.
    assert todo.parse_due_token("+1m", now=NOW) == "2026-07-15T23:59:00"


def test_parse_due_token_case_insensitive():
    assert todo.parse_due_token("Tomorrow", now=NOW) == "2026-06-16T23:59:00"
    assert todo.parse_due_token("FRI", now=NOW) == "2026-06-19T23:59:00"


def test_parse_due_token_invalid_returns_none():
    assert todo.parse_due_token("someday", now=NOW) is None
    assert todo.parse_due_token("2026-13-99", now=NOW) is None
    assert todo.parse_due_token("+5x", now=NOW) is None
    assert todo.parse_due_token("", now=NOW) is None
    assert todo.parse_due_token(None, now=NOW) is None
