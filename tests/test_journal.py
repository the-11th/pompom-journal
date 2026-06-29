"""Tests for the pure journal logic in journal.py.

Fixed `now` for deterministic timestamps; pytest tmp_path for file I/O.
Stores are initialized via journal._empty() unless a test needs seeding.
"""

import json
from datetime import datetime

import pytest

import journal

NOW = datetime(2026, 6, 15, 9, 0, 0)


def test_empty_store_shape():
    assert journal._empty() == {
        "sections": [], "entries": [], "dismissed_suggestions": {}}


def test_seeded_has_six_default_tag_sections():
    data = journal._seeded()
    names = [s["name"] for s in data["sections"]]
    assert names == ["people", "places", "food", "chores", "health", "work"]
    assert all(s["type"] == "tag" for s in data["sections"])
    assert all(s["tags"] == [] and s["archived"] is False for s in data["sections"])
    # ids are unique
    assert len({s["id"] for s in data["sections"]}) == 6


def test_save_then_load_round_trips(tmp_path):
    path = str(tmp_path / "journal.json")
    data = journal._empty()
    journal.save(path, data)
    assert journal.load(path) == data


def test_load_missing_file_returns_seeded(tmp_path):
    path = str(tmp_path / "nope.json")
    data = journal.load(path)
    assert [s["name"] for s in data["sections"]][0] == "people"


def test_load_corrupt_backs_up_and_seeds(tmp_path):
    path = tmp_path / "journal.json"
    path.write_text("{ not json", encoding="utf-8")
    data = journal.load(str(path))
    assert (tmp_path / "journal.json.bak").exists()
    assert len(data["sections"]) == 6


def test_load_migrates_missing_fields(tmp_path):
    path = tmp_path / "journal.json"
    path.write_text(json.dumps({
        "sections": [{"id": "x", "name": "people", "type": "tag", "color": "#fff"}],
        "entries": [{"id": "e", "date": "2026-06-15", "title": "t", "body": ""}],
    }), encoding="utf-8")
    data = journal.load(str(path))
    s = data["sections"][0]
    assert s["tags"] == [] and s["unit"] is None and s["archived"] is False
    e = data["entries"][0]
    assert e["tags"] == {} and e["numbers"] == {}
    # New top-level key defaults to {} on a store written before it existed.
    assert data["dismissed_suggestions"] == {}


# --------------------------------------------------------------------------- #
# Task 2: Section lookup & display helpers
# --------------------------------------------------------------------------- #

def test_active_sections_excludes_archived():
    data = journal._empty()
    a = journal.add_section(data, "people", "tag", "#fff")
    b = journal.add_section(data, "work", "tag", "#000")
    b["archived"] = True
    assert journal.active_sections(data) == [a]


def test_section_by_id_finds_archived_too():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    s["archived"] = True
    assert journal.section_by_id(data, s["id"]) is s
    assert journal.section_by_id(data, "missing") is None


def test_section_color_falls_back_to_default():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#abcdef")
    assert journal.section_color(data, s["id"]) == "#abcdef"
    assert journal.section_color(data, "missing") == journal.DEFAULT_SECTION_COLOR


def test_is_registered_tag():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    s["tags"] = ["maya"]
    assert journal.is_registered_tag(data, s["id"], "maya") is True
    assert journal.is_registered_tag(data, s["id"], "MAYA") is True   # normalized
    assert journal.is_registered_tag(data, s["id"], "ghost") is False


# --------------------------------------------------------------------------- #
# Task 3: Section CRUD with validation
# --------------------------------------------------------------------------- #

def test_add_section_validates_and_assigns_id():
    data = journal._empty()
    s = journal.add_section(data, "  People ", "tag", "#e0a955")
    assert s["name"] == "people"           # normalized
    assert s["type"] == "tag" and s["archived"] is False
    assert len(s["id"]) == 32              # uuid4 hex
    assert journal.active_sections(data) == [s]


def test_add_numeric_section_keeps_unit():
    data = journal._empty()
    s = journal.add_section(data, "sleep", "numeric", "#6fa8dc", unit="hrs")
    assert s["type"] == "numeric" and s["unit"] == "hrs"


def test_add_section_rejects_bad_name():
    data = journal._empty()
    for bad in ["", "   ", "no<script>", "a;b"]:
        with pytest.raises(ValueError):
            journal.add_section(data, bad, "tag", "#fff")


def test_add_section_rejects_bad_type_and_color():
    data = journal._empty()
    with pytest.raises(ValueError):
        journal.add_section(data, "x", "bogus", "#fff")
    with pytest.raises(ValueError):
        journal.add_section(data, "x", "tag", "not-a-color")


def test_add_section_rejects_duplicate_active_name():
    data = journal._empty()
    journal.add_section(data, "people", "tag", "#fff")
    with pytest.raises(ValueError):
        journal.add_section(data, "PEOPLE", "tag", "#000")


def test_rename_section():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.rename_section(data, s["id"], "friends")
    assert journal.section_by_id(data, s["id"])["name"] == "friends"


def test_rename_rejects_duplicate():
    data = journal._empty()
    journal.add_section(data, "people", "tag", "#fff")
    s2 = journal.add_section(data, "work", "tag", "#000")
    with pytest.raises(ValueError):
        journal.rename_section(data, s2["id"], "people")


def test_set_color_and_unit():
    data = journal._empty()
    s = journal.add_section(data, "sleep", "numeric", "#fff", unit="hrs")
    journal.set_section_color(data, s["id"], "#123456")
    journal.set_section_unit(data, s["id"], "minutes here")  # capped to 12
    s2 = journal.section_by_id(data, s["id"])
    assert s2["color"] == "#123456"
    assert s2["unit"] == "minutes here"[:12]


def test_archive_section_soft_deletes():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.archive_section(data, s["id"])
    assert journal.section_by_id(data, s["id"])["archived"] is True
    assert journal.active_sections(data) == []


# --------------------------------------------------------------------------- #
# Task 4: Permanent tags on sections
# --------------------------------------------------------------------------- #

def test_add_section_tag_appends_normalized_unique():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.add_section_tag(data, s["id"], " Maya ")
    journal.add_section_tag(data, s["id"], "maya")   # dup ignored
    assert journal.section_by_id(data, s["id"])["tags"] == ["maya"]


def test_add_section_tag_rejects_bad_name_and_numeric_section():
    data = journal._empty()
    tag_s = journal.add_section(data, "people", "tag", "#fff")
    num_s = journal.add_section(data, "sleep", "numeric", "#fff", unit="hrs")
    with pytest.raises(ValueError):
        journal.add_section_tag(data, tag_s["id"], "bad;name")
    with pytest.raises(ValueError):
        journal.add_section_tag(data, num_s["id"], "nope")


def test_remove_section_tag_removes_from_master_list_but_keeps_entry_tags():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.add_section_tag(data, s["id"], "maya")
    # Create an entry that uses the tag before removing it from the section
    e = journal.upsert_entry(data, "2026-06-15", "t", "",
                             tags={s["id"]: ["maya"]}, now=NOW)
    journal.remove_section_tag(data, s["id"], "maya")
    # Tag is gone from the section's master list ...
    assert journal.section_by_id(data, s["id"])["tags"] == []
    # ... but the entry still carries it (historical data preserved)
    assert e["tags"] == {s["id"]: ["maya"]}


# --------------------------------------------------------------------------- #
# Task 5: Entry lookup & date helpers
# --------------------------------------------------------------------------- #

def test_today_iso_uses_injected_now():
    assert journal.today_iso(now=NOW) == "2026-06-15"


def test_valid_date():
    assert journal._valid_date("2026-06-15") is True
    assert journal._valid_date("2026-13-99") is False
    assert journal._valid_date("nope") is False
    assert journal._valid_date(None) is False


def test_get_entry_by_date_and_sorted():
    data = journal._empty()
    journal.upsert_entry(data, "2026-06-13", "older", "", now=NOW)
    journal.upsert_entry(data, "2026-06-15", "newer", "", now=NOW)
    assert journal.get_entry_by_date(data, "2026-06-15")["title"] == "newer"
    assert journal.get_entry_by_date(data, "2026-06-01") is None
    dates = [e["date"] for e in journal.entries_sorted(data)]
    assert dates == ["2026-06-15", "2026-06-13"]   # newest first


# --------------------------------------------------------------------------- #
# Task 6: Entry upsert & delete
# --------------------------------------------------------------------------- #

def test_upsert_creates_then_updates_same_date():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    e1 = journal.upsert_entry(data, "2026-06-15", "Day one", "body",
                              tags={s["id"]: ["maya"]}, now=NOW)
    assert e1["created"] == NOW.isoformat()
    assert e1["tags"] == {s["id"]: ["maya"]}
    # same date -> updates, does not duplicate
    later = datetime(2026, 6, 15, 21, 0, 0)
    e2 = journal.upsert_entry(data, "2026-06-15", "Edited", "new body", now=later)
    assert len(data["entries"]) == 1
    assert e2["id"] == e1["id"]
    assert e2["created"] == NOW.isoformat()       # preserved
    assert e2["updated"] == later.isoformat()     # bumped
    assert e2["title"] == "Edited"
    assert e2["body"] == "new body"


def test_upsert_validates_date_and_title():
    data = journal._empty()
    with pytest.raises(ValueError):
        journal.upsert_entry(data, "bad-date", "t", "", now=NOW)
    with pytest.raises(ValueError):
        journal.upsert_entry(data, "2026-06-15", "   ", "", now=NOW)


def test_upsert_cleans_tags_and_numbers():
    data = journal._empty()
    tag_s = journal.add_section(data, "people", "tag", "#fff")
    num_s = journal.add_section(data, "sleep", "numeric", "#fff", unit="hrs")
    e = journal.upsert_entry(
        data, "2026-06-15", "t", "",
        tags={tag_s["id"]: [" Maya ", "maya", "dad"], "ghost-section": ["x"]},
        numbers={num_s["id"]: "8.5", "ghost-section": "3"},
        now=NOW,
    )
    assert e["tags"] == {tag_s["id"]: ["maya", "dad"]}   # normalized, deduped, ghost dropped
    assert e["numbers"] == {num_s["id"]: 8.5}            # cast to float, ghost dropped


def test_upsert_rejects_non_numeric_value():
    data = journal._empty()
    num_s = journal.add_section(data, "sleep", "numeric", "#fff", unit="hrs")
    with pytest.raises(ValueError):
        journal.upsert_entry(data, "2026-06-15", "t", "",
                             numbers={num_s["id"]: "eight"}, now=NOW)


def test_upsert_rejects_nan_number():
    data = journal._empty()
    num_s = journal.add_section(data, "sleep", "numeric", "#fff", unit="hrs")
    with pytest.raises(ValueError):
        journal.upsert_entry(data, "2026-06-15", "t", "",
                             numbers={num_s["id"]: "nan"}, now=NOW)


def test_upsert_rejects_inf_number():
    data = journal._empty()
    num_s = journal.add_section(data, "sleep", "numeric", "#fff", unit="hrs")
    with pytest.raises(ValueError):
        journal.upsert_entry(data, "2026-06-15", "t", "",
                             numbers={num_s["id"]: "inf"}, now=NOW)


def test_upsert_accepts_archived_section_id_for_tag():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    section_id = s["id"]
    journal.archive_section(data, section_id)
    # Archived section id should be accepted so historical data is preserved
    e = journal.upsert_entry(data, "2026-06-15", "t", "",
                             tags={section_id: ["maya"]}, now=NOW)
    assert e["tags"] == {section_id: ["maya"]}


# --------------------------------------------------------------------------- #
# Mood quick-pick (1..7, optional, top-level entry field)
# --------------------------------------------------------------------------- #

def test_upsert_stores_valid_mood_on_create():
    data = journal._empty()
    e = journal.upsert_entry(data, "2026-06-15", "t", "", mood=5, now=NOW)
    assert e["mood"] == 5


def test_upsert_stores_valid_mood_on_update():
    data = journal._empty()
    journal.upsert_entry(data, "2026-06-15", "t", "", mood=2, now=NOW)
    e = journal.upsert_entry(data, "2026-06-15", "t", "", mood=6, now=NOW)
    assert len(data["entries"]) == 1
    assert e["mood"] == 6


def test_upsert_coerces_int_like_mood():
    data = journal._empty()
    e = journal.upsert_entry(data, "2026-06-15", "t", "", mood="4", now=NOW)
    assert e["mood"] == 4 and isinstance(e["mood"], int)


def test_upsert_mood_none_or_omitted_stores_null():
    data = journal._empty()
    e1 = journal.upsert_entry(data, "2026-06-15", "t", "", now=NOW)
    assert e1["mood"] is None
    e2 = journal.upsert_entry(data, "2026-06-16", "t", "", mood=None, now=NOW)
    assert e2["mood"] is None
    e3 = journal.upsert_entry(data, "2026-06-17", "t", "", mood="", now=NOW)
    assert e3["mood"] is None


def test_upsert_rejects_out_of_range_mood():
    data = journal._empty()
    with pytest.raises(ValueError):
        journal.upsert_entry(data, "2026-06-15", "t", "", mood=0, now=NOW)
    with pytest.raises(ValueError):
        journal.upsert_entry(data, "2026-06-16", "t", "", mood=8, now=NOW)


def test_upsert_rejects_non_int_mood():
    data = journal._empty()
    with pytest.raises(ValueError):
        journal.upsert_entry(data, "2026-06-15", "t", "", mood="abc", now=NOW)
    with pytest.raises(ValueError):
        journal.upsert_entry(data, "2026-06-16", "t", "", mood=3.5, now=NOW)


def test_upsert_mood_preserved_when_not_passed_then_changed_then_cleared():
    data = journal._empty()
    journal.upsert_entry(data, "2026-06-15", "t", "", mood=3, now=NOW)
    # Re-passing the same mood keeps it; a new value replaces it.
    changed = journal.upsert_entry(data, "2026-06-15", "t", "", mood=7, now=NOW)
    assert changed["mood"] == 7
    # Clearing it (None) stores null.
    cleared = journal.upsert_entry(data, "2026-06-15", "t", "", mood=None, now=NOW)
    assert cleared["mood"] is None


def test_load_migrates_missing_mood(tmp_path):
    path = tmp_path / "journal.json"
    path.write_text(json.dumps({
        "sections": [],
        "entries": [{"id": "e", "date": "2026-06-15", "title": "t", "body": "",
                     "tags": {}, "numbers": {}}],
    }), encoding="utf-8")
    data = journal.load(str(path))
    assert data["entries"][0]["mood"] is None


def test_valid_mood_helper():
    assert journal._valid_mood(1) and journal._valid_mood(7)
    assert journal._valid_mood("4")
    assert not journal._valid_mood(0)
    assert not journal._valid_mood(8)
    assert not journal._valid_mood("abc")
    assert not journal._valid_mood(None)


def test_delete_entry():
    data = journal._empty()
    e = journal.upsert_entry(data, "2026-06-15", "t", "", now=NOW)
    journal.delete_entry(data, e["id"])
    assert data["entries"] == []


# --------------------------------------------------------------------------- #
# entry_dates
# --------------------------------------------------------------------------- #

def test_entry_dates_sorted_unique():
    data = journal._empty()
    journal.upsert_entry(data, "2026-06-15", "a", "", now=NOW)
    journal.upsert_entry(data, "2026-06-13", "b", "", now=NOW)
    assert journal.entry_dates(data) == ["2026-06-13", "2026-06-15"]
    assert journal.entry_dates(journal._empty()) == []


# --------------------------------------------------------------------------- #
# move_entry
# --------------------------------------------------------------------------- #

def test_move_entry_to_empty_date():
    data = journal._empty()
    e = journal.upsert_entry(data, "2026-06-15", "t", "", now=NOW)
    journal.move_entry(data, e["id"], "2026-06-20")
    assert journal.get_entry_by_date(data, "2026-06-15") is None
    assert journal.get_entry_by_date(data, "2026-06-20")["id"] == e["id"]


def test_move_entry_rejects_occupied_target():
    data = journal._empty()
    e = journal.upsert_entry(data, "2026-06-15", "t", "", now=NOW)
    journal.upsert_entry(data, "2026-06-20", "other", "", now=NOW)
    with pytest.raises(ValueError):
        journal.move_entry(data, e["id"], "2026-06-20")
    # unchanged
    assert journal.get_entry_by_date(data, "2026-06-15")["id"] == e["id"]


def test_move_entry_rejects_bad_date():
    data = journal._empty()
    e = journal.upsert_entry(data, "2026-06-15", "t", "", now=NOW)
    with pytest.raises(ValueError):
        journal.move_entry(data, e["id"], "nope")


def test_move_entry_same_date_is_noop():
    data = journal._empty()
    e = journal.upsert_entry(data, "2026-06-15", "t", "", now=NOW)
    journal.move_entry(data, e["id"], "2026-06-15")
    assert journal.get_entry_by_date(data, "2026-06-15")["id"] == e["id"]


# --------------------------------------------------------------------------- #
# Task 9: Search index helpers
# --------------------------------------------------------------------------- #

def test_search_index_shape_and_order():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.upsert_entry(data, "2026-06-13", "old", "ran in the park",
                         tags={s["id"]: ["maya"]}, now=NOW)
    journal.upsert_entry(data, "2026-06-15", "new", "quiet day", now=NOW)
    idx = journal.search_index(data)
    assert [i["date"] for i in idx] == ["2026-06-15", "2026-06-13"]   # newest first
    older = idx[1]
    assert older["title"] == "old" and older["body"] == "ran in the park"
    assert older["tags"] == ["maya"]


def test_search_index_tag_chips_carry_section_color():
    """tag_chips pair each tag with its own section's color, deduped + sorted."""
    data = journal._empty()
    people = journal.add_section(data, "people", "tag", "#aabbcc")
    food = journal.add_section(data, "food", "tag", "#112233")
    journal.upsert_entry(data, "2026-06-13", "t", "body",
                         tags={people["id"]: ["maya"], food["id"]: ["ramen"]},
                         now=NOW)
    idx = journal.search_index(data)
    chips = idx[0]["tag_chips"]
    assert chips == [
        {"name": "maya", "color": "#aabbcc"},
        {"name": "ramen", "color": "#112233"},
    ]


def test_numeric_bounds():
    data = journal._empty()
    s = journal.add_section(data, "sleep", "numeric", "#fff", unit="hrs")
    journal.upsert_entry(data, "2026-06-13", "a", "", numbers={s["id"]: "6"}, now=NOW)
    journal.upsert_entry(data, "2026-06-15", "b", "", numbers={s["id"]: "9"}, now=NOW)
    assert journal.numeric_bounds(data)[s["id"]] == [6.0, 9.0]
    s2 = journal.add_section(data, "weight", "numeric", "#fff", unit="lbs")
    assert s2["id"] not in journal.numeric_bounds(data)   # no values -> omitted


# --------------------------------------------------------------------------- #
# Archived tags & sections
# --------------------------------------------------------------------------- #

def test_remove_section_tag_archives_not_deletes():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.add_section_tag(data, s["id"], "maya")
    journal.remove_section_tag(data, s["id"], "maya")
    assert "maya" not in journal.section_by_id(data, s["id"])["tags"]
    assert "maya" in journal.section_by_id(data, s["id"])["archived_tags"]


def test_readd_archived_tag_moves_it_back():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.add_section_tag(data, s["id"], "maya")
    journal.remove_section_tag(data, s["id"], "maya")
    # Re-add the same tag.
    journal.add_section_tag(data, s["id"], "maya")
    s2 = journal.section_by_id(data, s["id"])
    assert "maya" in s2["tags"]
    assert "maya" not in s2["archived_tags"]


def test_readd_archived_tag_case_insensitive():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.add_section_tag(data, s["id"], "Maya")   # stored as "maya"
    journal.remove_section_tag(data, s["id"], "MAYA")  # archived as "maya"
    journal.add_section_tag(data, s["id"], "maya")    # re-add unarchives
    s2 = journal.section_by_id(data, s["id"])
    assert "maya" in s2["tags"]
    assert "maya" not in s2["archived_tags"]


def test_archived_sections_helper():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    assert journal.archived_sections(data) == []
    journal.archive_section(data, s["id"])
    assert journal.archived_sections(data) == [s]
    assert journal.active_sections(data) == []


def test_restore_section():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.archive_section(data, s["id"])
    journal.restore_section(data, s["id"])
    assert journal.section_by_id(data, s["id"])["archived"] is False
    assert journal.active_sections(data) == [s]


def test_restore_section_name_collision_raises():
    data = journal._empty()
    s1 = journal.add_section(data, "people", "tag", "#fff")
    journal.archive_section(data, s1["id"])
    journal.add_section(data, "people", "tag", "#000")  # new active section with same name
    with pytest.raises(ValueError):
        journal.restore_section(data, s1["id"])


def test_restore_section_tag():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.add_section_tag(data, s["id"], "maya")
    journal.remove_section_tag(data, s["id"], "maya")
    journal.restore_section_tag(data, s["id"], "maya")
    s2 = journal.section_by_id(data, s["id"])
    assert "maya" in s2["tags"]
    assert "maya" not in s2["archived_tags"]


def test_load_migrates_archived_tags_field(tmp_path):
    path = tmp_path / "journal.json"
    path.write_text(
        '{"sections": [{"id": "x", "name": "people", "type": "tag", "color": "#fff", "tags": ["maya"], "unit": null, "archived": false}], "entries": []}',
        encoding="utf-8",
    )
    data = journal.load(str(path))
    assert data["sections"][0].get("archived_tags") == []


# --------------------------------------------------------------------------- #
# Temporary tags (derived from entries) for the manage page
# --------------------------------------------------------------------------- #

def test_temporary_tags_empty_store():
    assert journal.temporary_tags(journal._empty()) == {}


def test_temporary_tags_no_entries():
    data = journal._empty()
    journal.add_section(data, "people", "tag", "#fff")
    assert journal.temporary_tags(data) == {}


def test_temporary_tags_includes_entry_only_tag():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.upsert_entry(data, "2026-06-10", "t", "", tags={s["id"]: ["zed"]},
                         now=NOW)
    assert journal.temporary_tags(data) == {s["id"]: ["zed"]}


def test_temporary_tags_excludes_permanent():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.add_section_tag(data, s["id"], "maya")
    journal.upsert_entry(data, "2026-06-10", "t", "", tags={s["id"]: ["maya"]},
                         now=NOW)
    assert journal.temporary_tags(data) == {}


def test_temporary_tags_excludes_archived():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.add_section_tag(data, s["id"], "alex")
    journal.remove_section_tag(data, s["id"], "alex")  # -> archived_tags
    journal.upsert_entry(data, "2026-06-10", "t", "", tags={s["id"]: ["alex"]},
                         now=NOW)
    assert journal.temporary_tags(data) == {}


def test_temporary_tags_case_insensitive_match_excludes():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.add_section_tag(data, s["id"], "Maya")  # stored normalized -> "maya"
    # An entry tag is also normalized to "maya" on upsert; it must not surface.
    journal.upsert_entry(data, "2026-06-10", "t", "", tags={s["id"]: ["MAYA"]},
                         now=NOW)
    assert journal.temporary_tags(data) == {}


def test_temporary_tags_sorted_and_deduped():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.upsert_entry(data, "2026-06-10", "a", "", tags={s["id"]: ["zed", "abe"]},
                         now=NOW)
    journal.upsert_entry(data, "2026-06-11", "b", "", tags={s["id"]: ["abe", "mo"]},
                         now=NOW)
    # Sorted, deduped across entries.
    assert journal.temporary_tags(data) == {s["id"]: ["abe", "mo", "zed"]}


def test_temporary_tags_omits_sections_with_none():
    data = journal._empty()
    a = journal.add_section(data, "people", "tag", "#fff")
    b = journal.add_section(data, "work", "tag", "#000")
    journal.add_section_tag(data, b["id"], "deploy")
    journal.upsert_entry(data, "2026-06-10", "t", "",
                         tags={a["id"]: ["zed"], b["id"]: ["deploy"]}, now=NOW)
    # Only section a has a temporary tag; b's tag is permanent.
    assert journal.temporary_tags(data) == {a["id"]: ["zed"]}


def test_temporary_tag_stops_being_temporary_once_promoted():
    """Promoting a temporary tag is just add_section_tag; afterwards it is
    registered as permanent and drops out of temporary_tags."""
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.upsert_entry(data, "2026-06-10", "t", "", tags={s["id"]: ["zed"]},
                         now=NOW)
    assert journal.temporary_tags(data) == {s["id"]: ["zed"]}
    journal.add_section_tag(data, s["id"], "zed")  # promote
    assert "zed" in s["tags"]
    assert journal.temporary_tags(data) == {}


def test_demote_section_tag_still_on_entry_becomes_temporary():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.add_section_tag(data, s["id"], "maya")
    journal.upsert_entry(data, "2026-06-10", "t", "", tags={s["id"]: ["maya"]},
                         now=NOW)
    journal.demote_section_tag(data, s["id"], "maya")
    assert "maya" not in s["tags"]
    assert "maya" not in s["archived_tags"]            # not archived (still used)
    assert journal.temporary_tags(data) == {s["id"]: ["maya"]}


def test_demote_section_tag_unused_archives():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.add_section_tag(data, s["id"], "ghost")
    journal.demote_section_tag(data, s["id"], "ghost")  # no entry uses it
    assert "ghost" not in s["tags"]
    assert "ghost" in s["archived_tags"]
    assert journal.temporary_tags(data) == {}


def test_demote_section_tag_unknown_is_noop():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.demote_section_tag(data, s["id"], "nope")
    assert s["tags"] == []
    assert s["archived_tags"] == []


def test_archive_temporary_tag_removes_it_from_temporary():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.upsert_entry(data, "2026-06-10", "t", "", tags={s["id"]: ["zed"]},
                         now=NOW)
    assert journal.temporary_tags(data) == {s["id"]: ["zed"]}
    journal.archive_temporary_tag(data, s["id"], "zed")
    assert "zed" in s["archived_tags"]
    assert "zed" not in s["tags"]          # never was permanent
    assert journal.temporary_tags(data) == {}


def test_archive_temporary_tag_normalizes_and_is_idempotent():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.upsert_entry(data, "2026-06-10", "t", "", tags={s["id"]: ["zed"]},
                         now=NOW)
    journal.archive_temporary_tag(data, s["id"], "ZED")   # normalizes
    journal.archive_temporary_tag(data, s["id"], "zed")   # idempotent
    assert s["archived_tags"] == ["zed"]


def test_archive_temporary_tag_unknown_section_is_noop():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.archive_temporary_tag(data, "nope", "zed")
    assert s["archived_tags"] == []


def test_archive_temporary_tag_numeric_section_is_noop():
    data = journal._empty()
    s = journal.add_section(data, "sleep", "numeric", "#fff", unit="hrs")
    journal.archive_temporary_tag(data, s["id"], "zed")
    assert s["archived_tags"] == []


# --------------------------------------------------------------------------- #
# Rich entries: @mention tag-section index
# --------------------------------------------------------------------------- #

def test_tag_section_index_includes_permanent_and_archived():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.add_section_tag(data, s["id"], "maya")
    journal.add_section_tag(data, s["id"], "alex")
    journal.remove_section_tag(data, s["id"], "alex")  # -> archived_tags
    idx = journal.tag_section_index(data)
    assert idx["maya"] == s["id"]
    assert idx["alex"] == s["id"]


def test_tag_section_index_harvests_temporary_from_entries():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.upsert_entry(data, "2026-06-10", "t", "", tags={s["id"]: ["zed"]},
                         now=NOW)
    idx = journal.tag_section_index(data)
    # "zed" is only a temporary tag (not in section.tags) but still indexed.
    assert idx["zed"] == s["id"]
    assert "zed" not in (s.get("tags") or [])


def test_tag_section_index_registered_home_wins_over_temp_use():
    data = journal._empty()
    people = journal.add_section(data, "people", "tag", "#fff")
    work = journal.add_section(data, "work", "tag", "#000")
    journal.add_section_tag(data, people["id"], "maya")  # registered home
    # Stray temporary use of "maya" under the work section must NOT win.
    journal.upsert_entry(data, "2026-06-12", "t", "", tags={work["id"]: ["maya"]},
                         now=NOW)
    idx = journal.tag_section_index(data)
    assert idx["maya"] == people["id"]


def test_tag_section_index_most_recent_entry_wins_for_pure_temp():
    data = journal._empty()
    a = journal.add_section(data, "alpha", "tag", "#fff")
    b = journal.add_section(data, "beta", "tag", "#000")
    # Same purely-temporary name used under two sections on two dates.
    journal.upsert_entry(data, "2026-06-10", "older", "", tags={a["id"]: ["solo"]},
                         now=NOW)
    journal.upsert_entry(data, "2026-06-14", "newer", "", tags={b["id"]: ["solo"]},
                         now=NOW)
    idx = journal.tag_section_index(data)
    assert idx["solo"] == b["id"]  # most-recent date wins


def test_tag_section_index_normalizes_names():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.add_section_tag(data, s["id"], "Maya")
    idx = journal.tag_section_index(data)
    assert "maya" in idx
    assert "Maya" not in idx


# --------------------------------------------------------------------------- #
# Rich entries: @mention extraction
# --------------------------------------------------------------------------- #

def test_extract_mentions_matches_word_boundary():
    index = {"maya": "S1"}
    out = journal.extract_mentions("had lunch with @maya today", index)
    assert out == {"S1": ["maya"]}


def test_extract_mentions_ignores_email_like():
    index = {"b": "S1"}
    # "@b" inside an email is preceded by a word char -> not a mention.
    out = journal.extract_mentions("ping a@b.com please", index)
    assert out == {}


def test_extract_mentions_matches_at_start_of_string():
    index = {"maya": "S1"}
    out = journal.extract_mentions("@maya said hi", index)
    assert out == {"S1": ["maya"]}


def test_extract_mentions_normalizes_case():
    index = {"maya": "S1"}
    out = journal.extract_mentions("saw @Maya", index)
    assert out == {"S1": ["maya"]}


def test_extract_mentions_drops_unknown():
    index = {"maya": "S1"}
    out = journal.extract_mentions("met @stranger and @maya", index)
    assert out == {"S1": ["maya"]}


def test_extract_mentions_groups_by_section_and_dedupes():
    index = {"maya": "S1", "alex": "S1", "paris": "S2"}
    out = journal.extract_mentions("@maya @alex @maya in @paris", index)
    assert out == {"S1": ["maya", "alex"], "S2": ["paris"]}


def test_extract_mentions_underscore_matches_multiword_tag():
    # `@alex_dad` resolves to the multi-word tag "alex dad".
    index = {"alex dad": "S1"}
    out = journal.extract_mentions("hung with @alex_dad today", index)
    assert out == {"S1": ["alex dad"]}


def test_extract_mentions_literal_underscore_tag_wins():
    # When both exist, a literal-underscore tag beats the spaced form.
    index = {"alex_dad": "S1", "alex dad": "S2"}
    out = journal.extract_mentions("@alex_dad", index)
    assert out == {"S1": ["alex_dad"]}


# --------------------------------------------------------------------------- #
# Rich entries: tag merge
# --------------------------------------------------------------------------- #

def test_merge_entry_tags_unions_across_sections():
    base = {"S1": ["maya"]}
    mentions = {"S1": ["alex"], "S2": ["paris"]}
    out = journal.merge_entry_tags(base, mentions)
    assert out == {"S1": ["maya", "alex"], "S2": ["paris"]}


def test_merge_entry_tags_dedupes_preserving_order():
    base = {"S1": ["maya", "alex"]}
    mentions = {"S1": ["alex", "zed"]}
    out = journal.merge_entry_tags(base, mentions)
    assert out == {"S1": ["maya", "alex", "zed"]}


def test_merge_entry_tags_does_not_mutate_inputs():
    base = {"S1": ["maya"]}
    mentions = {"S1": ["alex"]}
    journal.merge_entry_tags(base, mentions)
    assert base == {"S1": ["maya"]}
    assert mentions == {"S1": ["alex"]}


def test_merge_entry_tags_is_non_destructive():
    base = {"S1": ["maya"]}
    mentions = {}
    out = journal.merge_entry_tags(base, mentions)
    assert out == {"S1": ["maya"]}


# --------------------------------------------------------------------------- #
# Tag pages / backlinks: journal.tag_overview
# --------------------------------------------------------------------------- #

def _to_data():
    """A journal store with two sections and a few entries tagged 'work'."""
    data = journal._empty()
    work = journal.add_section(data, "work", "tag", "#5b8dd6")
    health = journal.add_section(data, "health", "tag", "#6bbf73")
    wid, hid = work["id"], health["id"]
    # 2026-06-10: work + meetings, mood 4
    journal.upsert_entry(data, "2026-06-10", "standup", "long standup body",
                         tags={wid: ["work", "meetings"]}, mood=4,
                         now=datetime(2026, 6, 10, 9, 0, 0))
    # 2026-06-12: work + focus (health), mood 6
    journal.upsert_entry(data, "2026-06-12", "deep focus", "no meetings finally",
                         tags={wid: ["work"], hid: ["focus"]}, mood=6,
                         now=datetime(2026, 6, 12, 9, 0, 0))
    # 2026-06-14: NOT tagged work, mood 2 (baseline contributor)
    journal.upsert_entry(data, "2026-06-14", "errands", "groceries",
                         tags={hid: ["focus"]}, mood=2,
                         now=datetime(2026, 6, 14, 9, 0, 0))
    # 2026-06-16: work, no mood
    journal.upsert_entry(data, "2026-06-16", "planning", "tense planning meeting",
                         tags={wid: ["work", "meetings"]},
                         now=datetime(2026, 6, 16, 9, 0, 0))
    return data, wid, hid


def test_journal_tag_overview_sections_and_counts():
    data, wid, hid = _to_data()
    ov = journal.tag_overview(data, "work")
    assert ov["entries"] == 3
    assert ov["first"] == "2026-06-10"
    assert ov["last"] == "2026-06-16"
    # 'work' lives only under the work section.
    assert ov["sections"] == [{"id": wid, "name": "work", "color": "#5b8dd6"}]


def test_journal_tag_overview_case_insensitive():
    data, wid, hid = _to_data()
    assert journal.tag_overview(data, "WORK")["entries"] == 3


def test_journal_tag_overview_mood_avg_baseline_uplift():
    data, wid, hid = _to_data()
    ov = journal.tag_overview(data, "work")
    # work-tagged moods present: 4, 6 -> avg 5.0
    assert ov["avg_mood"] == 5.0
    # baseline over all entries with mood: 4, 6, 2 -> 4.0
    assert ov["baseline_mood"] == 4.0
    assert ov["uplift"] == 1.0


def test_journal_tag_overview_mood_series_only_tagged_with_mood():
    data, wid, hid = _to_data()
    ov = journal.tag_overview(data, "work")
    assert ov["mood_series"] == [
        {"date": "2026-06-10", "mood": 4},
        {"date": "2026-06-12", "mood": 6},
    ]


def test_journal_tag_overview_dow_counts():
    data, wid, hid = _to_data()
    ov = journal.tag_overview(data, "work")
    # 2026-06-10 Wed, 06-12 Fri, 06-16 Tue -> Mon..Sun
    assert ov["dow"] == [0, 1, 1, 0, 1, 0, 0]


def test_journal_tag_overview_cooccurrence():
    data, wid, hid = _to_data()
    ov = journal.tag_overview(data, "work")
    # 'meetings' appears on 2 work entries; 'focus' on 1 (different section)
    names = {(c["name"], c["section_id"]): c["count"] for c in ov["cooccurring"]}
    assert names[("meetings", wid)] == 2
    assert names[("focus", hid)] == 1
    # 'work' itself excluded from its own co-occurrence
    assert all(c["name"] != "work" for c in ov["cooccurring"])


def test_journal_tag_overview_timeline_reverse_chronological():
    data, wid, hid = _to_data()
    ov = journal.tag_overview(data, "work")
    dates = [r["date"] for r in ov["timeline"]]
    assert dates == ["2026-06-16", "2026-06-12", "2026-06-10"]
    row = ov["timeline"][0]
    assert set(row) >= {"date", "snippet", "sections", "mood"}
    assert wid in row["sections"]


def test_journal_tag_overview_date_filter():
    data, wid, hid = _to_data()
    ov = journal.tag_overview(data, "work", start="2026-06-13", end="2026-06-30")
    assert ov["entries"] == 1
    assert ov["first"] == "2026-06-16" and ov["last"] == "2026-06-16"


def test_journal_tag_overview_unknown_tag_is_empty():
    data, wid, hid = _to_data()
    ov = journal.tag_overview(data, "nonexistent")
    assert ov["entries"] == 0
    assert ov["sections"] == []
    assert ov["first"] is None and ov["last"] is None
    assert ov["avg_mood"] is None and ov["uplift"] is None
    assert ov["mood_series"] == []
    assert ov["cooccurring"] == []
    assert ov["timeline"] == []
