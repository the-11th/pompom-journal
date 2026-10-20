"""Unit tests for the pure task-analytics helpers in todo.py."""
import todo


def _arch(title, completed, due=None, recurrence=None, tags=None, difficulty=None):
    t = {"id": title, "title": title, "completed": completed, "due": due,
         "recurrence": recurrence, "tags": tags or []}
    if difficulty:
        t["difficulty"] = difficulty
    return t


def test_completion_throughput_counts_by_day_in_range():
    arch = [_arch("a", "2026-06-15T09:00:00"),
            _arch("b", "2026-06-15T18:00:00"),
            _arch("c", "2026-06-16T08:00:00")]
    assert todo.completion_throughput(arch) == {"2026-06-15": 2, "2026-06-16": 1}
    assert todo.completion_throughput(arch, start="2026-06-16") == {"2026-06-16": 1}
    assert todo.completion_throughput(arch, end="2026-06-15") == {"2026-06-15": 2}


def test_completion_summary_includes_quiet_days_in_daily_mean():
    archive = [{"completed": "2026-09-04T10:00:00"}, {"completed": "2026-09-10T10:00:00"}]
    summary = todo.completion_summary(archive, "2026-09-04", "2026-09-10")
    assert summary == {"total": 2, "best_day": 1, "days": 7,
                       "mean_per_day": 2 / 7, "first": "2026-09-04", "last": "2026-09-10"}
    assert todo.completion_summary(archive, "2026-09-01", "2026-09-10")["mean_per_day"] == .2


def test_completion_summary_infers_missing_bounds_and_handles_empty_ranges():
    archive = [{"completed": "2026-09-04T10:00:00"}, {"completed": "2026-09-10T10:00:00"}]
    assert todo.completion_summary(archive)["days"] == 7
    assert todo.completion_summary([], "2026-09-04", "2026-09-10")["mean_per_day"] == 0
    assert todo.completion_summary([])["mean_per_day"] is None
    assert todo.completion_summary(archive, "2026-09-11", "2026-09-01")["days"] == 0


def test_completed_late_count():
    arch = [_arch("late", "2026-06-16T10:00:00", due="2026-06-15T10:00:00"),
            _arch("ontime", "2026-06-15T08:00:00", due="2026-06-15T10:00:00"),
            _arch("nodue", "2026-06-15T08:00:00")]            # no due -> ignored
    assert todo.completed_late_count(arch) == {"late": 1, "on_time": 1}


def test_expiry_counts():
    exp = [{"expired_at": "2026-06-15T00:00:00"},
           {"expired_at": "2026-06-15T00:00:00"},
           {"expired_at": "2026-06-17T00:00:00"}]
    assert todo.expiry_counts(exp) == {"2026-06-15": 2, "2026-06-17": 1}


def test_recurring_adherence_completed_vs_missed():
    arch = [_arch("r1", "2026-06-15T09:00:00", recurrence="daily"),
            _arch("once", "2026-06-15T09:00:00")]              # non-recurring ignored
    exp = [{"expired_at": "2026-06-14T00:00:00", "recurrence": "daily"},
           {"expired_at": "2026-06-13T00:00:00"}]              # non-recurring ignored
    assert todo.recurring_adherence(arch, exp) == {"completed": 1, "missed": 1}


def test_difficulty_breakdown():
    arch = [_arch("a", "2026-06-15T09:00:00", difficulty="hard"),
            _arch("b", "2026-06-15T09:00:00", difficulty="easy"),
            _arch("c", "2026-06-15T09:00:00")]                 # unrated
    assert todo.difficulty_breakdown(arch) == {
        "easy": 1, "medium": 0, "hard": 1, "unrated": 1}


def test_task_tag_frequency():
    arch = [_arch("a", "2026-06-15T09:00:00", tags=["work", "home"]),
            _arch("b", "2026-06-16T09:00:00", tags=["work"])]
    assert todo.task_tag_frequency(arch) == {"work": 2, "home": 1}
    assert todo.task_tag_frequency(arch, start="2026-06-16") == {"work": 1}


def test_task_payload_shape():
    data = todo._empty()
    from datetime import datetime
    now = datetime(2026, 6, 15, 9, 0, 0)
    todo.add_task(data, "open", now=now)
    todo.add_task(data, "done", now=now)
    did = data["active"][1]["id"]
    todo.refresh(data, [did], difficulties={did: "hard"}, now=now)
    p = todo.task_payload(data)
    assert {"active", "archive", "expired", "tags", "date_range"} <= set(p)
    assert p["archive"][0]["completed"][:10] == "2026-06-15"
    assert p["archive"][0]["difficulty"] == "hard"
    assert p["date_range"]["min"] is not None
