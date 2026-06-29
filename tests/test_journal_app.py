"""Tests for the journal HTTP layer. Uses test_client() and a temp
JOURNAL_FILE so the real data/journal.json is never touched."""

import pytest

import app as app_module
import journal
import todo
import integrations as I


@pytest.fixture
def app(tmp_path):
    flask_app = app_module.app
    flask_app.config["TESTING"] = True
    journal_file = tmp_path / "journal.json"
    flask_app.config["JOURNAL_FILE"] = str(journal_file)
    flask_app.config["DATA_FILE"] = str(tmp_path / "tasks.json")
    flask_app.config["INTEGRATIONS_FILE"] = str(tmp_path / "integrations.json")
    # Seeded store (six default sections), mirroring first run.
    journal.save(str(journal_file), journal._seeded())
    # Empty task store so the analytics route never touches the real one.
    todo.save(str(tmp_path / "tasks.json"), todo._empty())
    yield flask_app


@pytest.fixture
def client(app):
    with app.test_client() as c:
        yield c


def _journal_path():
    return app_module.app.config["JOURNAL_FILE"]


def test_todo_index_has_brand_toggle_link_to_journal(client):
    """The brand mascot on the todo page links to the journal, with a
    'journal ->' caption."""
    resp = client.get("/")
    assert resp.status_code == 200
    assert b'class="brand-toggle"' in resp.data
    assert b'href="/journal"' in resp.data
    assert b"journal" in resp.data.lower()


def test_journal_page_brand_toggles_back_to_tasks(client):
    """On the journal side the brand is Pompompurin and links back to /."""
    resp = client.get("/journal")
    assert resp.status_code == 200
    assert b"pompompurin" in resp.data.lower()
    assert b'href="/"' in resp.data
    assert b"todo &rarr;" in resp.data or b"todo \xe2\x86\x92" in resp.data


def _first_tag_section_id():
    data = journal.load(_journal_path())
    return journal.active_sections(data)[0]["id"]   # "people"


def test_journal_today_renders_form(client):
    resp = client.get("/journal")
    assert resp.status_code == 200
    assert b"What happened today" in resp.data
    assert b"people" in resp.data       # seeded section card


def test_save_creates_entry_and_redirects(client):
    sid = _first_tag_section_id()
    resp = client.post("/journal/save", data={
        "date": "2026-06-15", "title": "A good day", "body": "stuff",
        f"tag:{sid}": "maya",
    })
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    e = journal.get_entry_by_date(data, "2026-06-15")
    assert e["title"] == "A good day"
    assert e["tags"][sid] == ["maya"]


def test_save_permanent_new_tag_joins_registry(client):
    sid = _first_tag_section_id()
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "",
        f"newtag-name:{sid}": "cousin lee", f"newtag-kind:{sid}": "permanent",
    })
    data = journal.load(_journal_path())
    assert "cousin lee" in journal.section_by_id(data, sid)["tags"]
    assert "cousin lee" in journal.get_entry_by_date(data, "2026-06-15")["tags"][sid]


def test_save_temporary_new_tag_stays_off_registry(client):
    sid = _first_tag_section_id()
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "",
        f"newtag-name:{sid}": "aunt rosa", f"newtag-kind:{sid}": "temporary",
    })
    data = journal.load(_journal_path())
    assert "aunt rosa" not in journal.section_by_id(data, sid)["tags"]
    assert "aunt rosa" in journal.get_entry_by_date(data, "2026-06-15")["tags"][sid]


def test_save_invalid_title_flashes_and_saves_nothing(client):
    resp = client.post("/journal/save", data={"date": "2026-06-15", "title": "  ", "body": ""})
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    assert journal.get_entry_by_date(data, "2026-06-15") is None


def test_edit_existing_date_prefills(client):
    client.post("/journal/save", data={"date": "2026-06-10", "title": "Past", "body": "hi"})
    resp = client.get("/journal/2026-06-10")
    assert resp.status_code == 200
    assert b"Past" in resp.data
    assert b"Update entry" in resp.data


def test_save_preserves_archived_section_data(client):
    """Editing an entry must not drop data for a section archived after the
    entry was written (the archived-section merge)."""
    sid = _first_tag_section_id()
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "", f"tag:{sid}": "maya"})
    data = journal.load(_journal_path())
    journal.archive_section(data, sid)
    journal.save(_journal_path(), data)
    # Re-save the same date WITHOUT the archived section's fields.
    client.post("/journal/save", data={"date": "2026-06-15", "title": "t2", "body": "more"})
    data = journal.load(_journal_path())
    e = journal.get_entry_by_date(data, "2026-06-15")
    assert e["tags"].get(sid) == ["maya"]   # archived data preserved
    assert e["title"] == "t2"


def test_save_unchecking_tag_clears_it(client):
    sid = _first_tag_section_id()
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "", f"tag:{sid}": "maya"})
    client.post("/journal/save", data={"date": "2026-06-15", "title": "t", "body": ""})
    data = journal.load(_journal_path())
    e = journal.get_entry_by_date(data, "2026-06-15")
    assert sid not in e["tags"]


def test_save_numeric_zero_round_trips(client):
    data = journal.load(_journal_path())
    s = journal.add_section(data, "sleep", "numeric", "#6fa8dc", unit="hrs")
    journal.save(_journal_path(), data)
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "", f"num:{s['id']}": "0"})
    data = journal.load(_journal_path())
    e = journal.get_entry_by_date(data, "2026-06-15")
    assert e["numbers"][s["id"]] == 0.0


def test_save_bad_number_aborts_entirely(client):
    """A bad numeric value aborts the whole save: no entry AND the permanent
    new tag in another section is not persisted (all-or-nothing)."""
    data = journal.load(_journal_path())
    num = journal.add_section(data, "sleep", "numeric", "#6fa8dc", unit="hrs")
    journal.save(_journal_path(), data)
    tag_sid = _first_tag_section_id()
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "",
        f"newtag-name:{tag_sid}": "cousin lee", f"newtag-kind:{tag_sid}": "permanent",
        f"num:{num['id']}": "abc"})
    data = journal.load(_journal_path())
    assert journal.get_entry_by_date(data, "2026-06-15") is None
    assert "cousin lee" not in journal.section_by_id(data, tag_sid)["tags"]


def test_save_mood_persists(client):
    resp = client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "", "mood": "4"})
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    assert journal.get_entry_by_date(data, "2026-06-15")["mood"] == 4


def test_save_empty_mood_stores_null(client):
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "", "mood": ""})
    data = journal.load(_journal_path())
    assert journal.get_entry_by_date(data, "2026-06-15")["mood"] is None


def test_save_out_of_range_mood_flashes_not_500(client):
    resp = client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "", "mood": "9"})
    assert resp.status_code == 302   # graceful flash redirect, not a 500
    data = journal.load(_journal_path())
    assert journal.get_entry_by_date(data, "2026-06-15") is None


def test_save_non_int_mood_flashes_not_500(client):
    resp = client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "", "mood": "abc"})
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    assert journal.get_entry_by_date(data, "2026-06-15") is None


def test_entry_page_renders_mood_picker(client):
    resp = client.get("/journal")
    assert resp.status_code == 200
    assert b"mood-picker" in resp.data
    # all seven GIFs present
    for n in range(1, 8):
        assert f"{n}-pompom.gif".encode() in resp.data


def test_entry_page_preselects_saved_mood(client):
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "", "mood": "3"})
    resp = client.get("/journal/2026-06-15")
    assert b"has-selection" in resp.data
    # the data-mood=3 button carries the selected class
    assert b'class="mood-opt selected"' in resp.data
    assert b'data-mood="3"' in resp.data
    # hidden input pre-populated
    assert b'name="mood"' in resp.data and b'value="3"' in resp.data


def test_move_entry_route(client):
    client.post("/journal/save", data={"date": "2026-06-15", "title": "t", "body": ""})
    data = journal.load(_journal_path())
    eid = journal.get_entry_by_date(data, "2026-06-15")["id"]
    resp = client.post(f"/journal/entry/{eid}/move", data={"date": "2026-06-20"})
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    assert journal.get_entry_by_date(data, "2026-06-15") is None
    assert journal.get_entry_by_date(data, "2026-06-20") is not None


def test_move_entry_route_rejects_occupied(client):
    client.post("/journal/save", data={"date": "2026-06-15", "title": "t", "body": ""})
    client.post("/journal/save", data={"date": "2026-06-20", "title": "x", "body": ""})
    data = journal.load(_journal_path())
    eid = journal.get_entry_by_date(data, "2026-06-15")["id"]
    resp = client.post(f"/journal/entry/{eid}/move", data={"date": "2026-06-20"})
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    # both still exist; nothing moved
    assert journal.get_entry_by_date(data, "2026-06-15") is not None
    assert journal.get_entry_by_date(data, "2026-06-20")["title"] == "x"


def test_move_entry_route_rejects_invalid_date(client):
    client.post("/journal/save", data={"date": "2026-06-15", "title": "t", "body": ""})
    data = journal.load(_journal_path())
    eid = journal.get_entry_by_date(data, "2026-06-15")["id"]
    resp = client.post(f"/journal/entry/{eid}/move", data={"date": "not-a-date"})
    assert resp.status_code == 302
    # the entry stays put on its original day
    assert journal.get_entry_by_date(journal.load(_journal_path()), "2026-06-15") is not None


# --------------------------------------------------------------------------- #
# Task 9: Search route and delete route
# --------------------------------------------------------------------------- #

def test_search_lists_all_entries_newest_first(client):
    client.post("/journal/save", data={"date": "2026-06-10", "title": "Older", "body": ""})
    client.post("/journal/save", data={"date": "2026-06-14", "title": "Newer", "body": ""})
    resp = client.get("/journal/search")
    assert resp.status_code == 200
    body = resp.data.decode()
    assert body.index("Newer") < body.index("Older")
    assert b"journal-search.js" in resp.data        # live filtering wired
    assert b"entries-data" in resp.data             # entries embedded as JSON


def test_delete_entry_removes_it(client):
    client.post("/journal/save", data={"date": "2026-06-10", "title": "Bye", "body": ""})
    eid = journal.get_entry_by_date(journal.load(_journal_path()), "2026-06-10")["id"]
    resp = client.post(f"/journal/entry/{eid}/delete")
    assert resp.status_code == 302
    assert journal.get_entry_by_date(journal.load(_journal_path()), "2026-06-10") is None


# --------------------------------------------------------------------------- #
# Task 10: Sections management page
# --------------------------------------------------------------------------- #

def test_sections_page_lists_sections(client):
    resp = client.get("/journal/sections")
    assert resp.status_code == 200
    assert b"people" in resp.data
    assert b"work" in resp.data


def test_sections_page_embeds_suggestion_data(client):
    """The Manage page hosts the (moved) tag-suggestions feature: it embeds the
    suggestion data blob and wires up tag-suggest.js."""
    resp = client.get("/journal/sections")
    assert resp.status_code == 200
    assert b'id="suggest-data"' in resp.data
    assert b'id="suggest-root"' in resp.data
    assert b"tag-suggest.js" in resp.data
    assert b"Suggestions" in resp.data


def test_sections_page_shows_temporary_tags(client):
    """Tags that live only on entries (not permanent or archived) appear in a
    Temporary group on the manage page."""
    data = journal.load(_journal_path())
    people = next(s for s in data["sections"] if s["name"] == "people")
    journal.upsert_entry(data, "2026-06-10", "t", "",
                         tags={people["id"]: ["zaphod"]})
    journal.save(_journal_path(), data)
    resp = client.get("/journal/sections")
    assert resp.status_code == 200
    assert b"zaphod" in resp.data
    assert b"Temporary" in resp.data


def test_add_tag_section(client):
    resp = client.post("/journal/sections/add", data={
        "name": "mood", "type": "tag", "color": "#abcdef"})
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    assert any(s["name"] == "mood" and s["type"] == "tag" for s in data["sections"])


def test_add_numeric_section_with_unit(client):
    resp = client.post("/journal/sections/add", data={
        "name": "sleep", "type": "numeric", "color": "#6fa8dc", "unit": "hrs"})
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    s = next(s for s in data["sections"] if s["name"] == "sleep")
    assert s["type"] == "numeric" and s["unit"] == "hrs"


def test_add_section_bad_color_flashes_and_saves_nothing(client):
    resp = client.post("/journal/sections/add", data={
        "name": "mood", "type": "numeric", "color": "purple"})
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    assert not any(s["name"] == "mood" for s in data["sections"])


def test_edit_section_rename_and_color(client):
    sid = journal.active_sections(journal.load(_journal_path()))[0]["id"]
    resp = client.post(f"/journal/sections/{sid}/edit", data={
        "name": "friends", "color": "#111111"})
    assert resp.status_code == 302
    s = journal.section_by_id(journal.load(_journal_path()), sid)
    assert s["name"] == "friends" and s["color"] == "#111111"


def test_edit_section_bad_name_flashes(client):
    sid = journal.active_sections(journal.load(_journal_path()))[0]["id"]
    original = journal.section_by_id(journal.load(_journal_path()), sid)["name"]
    client.post(f"/journal/sections/{sid}/edit", data={
        "name": "bad;name!", "color": "#abcdef"})
    assert journal.section_by_id(journal.load(_journal_path()), sid)["name"] == original


def test_archive_section_soft_deletes(client):
    sid = journal.active_sections(journal.load(_journal_path()))[0]["id"]
    resp = client.post(f"/journal/sections/{sid}/delete")
    assert resp.status_code == 302
    s = journal.section_by_id(journal.load(_journal_path()), sid)
    assert s["archived"] is True


def test_add_permanent_tag_to_section(client):
    sid = journal.active_sections(journal.load(_journal_path()))[0]["id"]
    resp = client.post(f"/journal/sections/{sid}/tags", data={"tag": "maya"})
    assert resp.status_code == 302
    assert "maya" in journal.section_by_id(journal.load(_journal_path()), sid)["tags"]


def test_remove_permanent_tag_does_not_affect_entries(client):
    """Removing a tag from the master list must NOT remove it from existing entries."""
    sid = _first_tag_section_id()
    # Add the tag to the master list.
    client.post(f"/journal/sections/{sid}/tags", data={"tag": "maya"})
    # Save an entry that uses that tag.
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "Day one", "body": "",
        f"tag:{sid}": "maya",
    })
    # Remove the tag from the master list.
    resp = client.post(f"/journal/sections/{sid}/tags/maya/delete")
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    # Not in the master list anymore.
    assert "maya" not in journal.section_by_id(data, sid)["tags"]
    # Still on the entry.
    entry = journal.get_entry_by_date(data, "2026-06-15")
    assert "maya" in entry["tags"][sid]


# --------------------------------------------------------------------------- #
# Archive page routes
# --------------------------------------------------------------------------- #

def test_archive_page_lists_archived_section(client):
    sid = journal.active_sections(journal.load(_journal_path()))[0]["id"]
    client.post(f"/journal/sections/{sid}/delete")
    resp = client.get("/journal/sections/archive")
    assert resp.status_code == 200
    assert b"people" in resp.data


def test_archive_page_lists_archived_tags(client):
    sid = _first_tag_section_id()
    client.post(f"/journal/sections/{sid}/tags", data={"tag": "maya"})
    client.post(f"/journal/sections/{sid}/tags/maya/delete")
    resp = client.get("/journal/sections/archive")
    assert resp.status_code == 200
    assert b"maya" in resp.data


def test_archive_page_has_back_to_manage_link(client):
    resp = client.get("/journal/sections/archive")
    assert resp.status_code == 200
    # A dedicated back-to-manage control (the inverse of the manage->archive
    # link), distinct from the nav.
    assert b'class="archive-link back-link"' in resp.data
    assert b'href="/journal/sections"' in resp.data


def test_restore_section(client):
    sid = journal.active_sections(journal.load(_journal_path()))[0]["id"]
    client.post(f"/journal/sections/{sid}/delete")
    resp = client.post(f"/journal/sections/{sid}/restore")
    assert resp.status_code == 302
    assert journal.section_by_id(journal.load(_journal_path()), sid)["archived"] is False


def test_restore_section_tag(client):
    sid = _first_tag_section_id()
    client.post(f"/journal/sections/{sid}/tags", data={"tag": "maya"})
    client.post(f"/journal/sections/{sid}/tags/maya/delete")
    resp = client.post(f"/journal/sections/{sid}/tags/maya/restore")
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    assert "maya" in journal.section_by_id(data, sid)["tags"]
    assert "maya" not in journal.section_by_id(data, sid)["archived_tags"]


def test_promote_temporary_tag_to_permanent(client):
    """POSTing the promote route moves an entry-only temp tag into the section's
    permanent list, and it stops appearing as temporary."""
    sid = _first_tag_section_id()
    data = journal.load(_journal_path())
    journal.upsert_entry(data, "2026-06-10", "t", "", tags={sid: ["zaphod"]})
    journal.save(_journal_path(), data)
    # Precondition: it's temporary, not permanent.
    assert journal.temporary_tags(journal.load(_journal_path())) == {sid: ["zaphod"]}

    resp = client.post(f"/journal/sections/{sid}/tags/zaphod/promote")
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    assert "zaphod" in journal.section_by_id(data, sid)["tags"]
    assert journal.temporary_tags(data) == {}


def test_demote_permanent_tag_used_on_entry_resurfaces_as_temporary(client):
    """Dragging a permanent tag into the Temporary zone hits the demote route.
    If the tag is still used on an entry, demoting removes it from the master
    list and temporary_tags() re-derives it from the entry (not archived)."""
    sid = _first_tag_section_id()
    client.post(f"/journal/sections/{sid}/tags", data={"tag": "maya"})
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "Day one", "body": "",
        f"tag:{sid}": "maya",
    })
    resp = client.post(f"/journal/sections/{sid}/tags/maya/demote")
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    s = journal.section_by_id(data, sid)
    assert "maya" not in s["tags"]
    assert "maya" not in s["archived_tags"]          # not archived (still used)
    assert journal.temporary_tags(data) == {sid: ["maya"]}  # re-derived


def test_demote_unused_permanent_tag_archives_it(client):
    """Demoting a permanent tag that no entry uses archives it (no temporary)."""
    sid = _first_tag_section_id()
    client.post(f"/journal/sections/{sid}/tags", data={"tag": "ghost"})
    resp = client.post(f"/journal/sections/{sid}/tags/ghost/demote")
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    s = journal.section_by_id(data, sid)
    assert "ghost" not in s["tags"]
    assert "ghost" in s["archived_tags"]
    assert journal.temporary_tags(data) == {}


def test_archive_temporary_tag_route(client):
    """The × on a temporary chip archives it: no longer temporary, in archived."""
    sid = _first_tag_section_id()
    data = journal.load(_journal_path())
    journal.upsert_entry(data, "2026-06-10", "t", "", tags={sid: ["zaphod"]})
    journal.save(_journal_path(), data)
    assert journal.temporary_tags(journal.load(_journal_path())) == {sid: ["zaphod"]}
    resp = client.post(f"/journal/sections/{sid}/tags/zaphod/archive-temp")
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    assert "zaphod" in journal.section_by_id(data, sid)["archived_tags"]
    assert journal.temporary_tags(data) == {}


def test_readd_archived_tag_via_form_unarchives_it(client):
    sid = _first_tag_section_id()
    client.post(f"/journal/sections/{sid}/tags", data={"tag": "maya"})
    client.post(f"/journal/sections/{sid}/tags/maya/delete")
    # Re-add via the normal add-tag form (not the restore route).
    client.post(f"/journal/sections/{sid}/tags", data={"tag": "MAYA"})
    data = journal.load(_journal_path())
    assert "maya" in journal.section_by_id(data, sid)["tags"]
    assert "maya" not in journal.section_by_id(data, sid)["archived_tags"]


# --------------------------------------------------------------------------- #
# Analytics page
# --------------------------------------------------------------------------- #

def test_analytics_page_renders(client):
    resp = client.get("/journal/analytics")
    assert resp.status_code == 200
    assert b"analytics-root" in resp.data        # the JS mount point
    assert b"analytics.js" in resp.data          # script is wired up


def test_analytics_data_returns_json(client):
    resp = client.get("/journal/analytics/data")
    assert resp.status_code == 200
    assert resp.is_json
    payload = resp.get_json()
    assert {"sections", "entries", "date_range", "tasks"} <= set(payload)
    # Suggestion blocks moved to the Manage page; they are no longer in the feed.
    assert "suggestions" not in payload
    assert "dormant" not in payload
    # seeded store has the six default sections
    assert [s["name"] for s in payload["sections"]][0] == "people"


def test_analytics_data_entries_carry_mood(client):
    """The analytics feed surfaces each entry's mood (int 1..7 or null) so the
    Mood tab and Overview can chart it."""
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "", "mood": "5"})
    client.post("/journal/save", data={
        "date": "2026-06-16", "title": "t", "body": "", "mood": ""})
    payload = client.get("/journal/analytics/data").get_json()
    by_date = {e["date"]: e["mood"] for e in payload["entries"]}
    assert by_date["2026-06-15"] == 5
    assert by_date["2026-06-16"] is None


def test_analytics_route_not_shadowed_by_date_route(client):
    """`/journal/analytics` must hit the analytics page, not be parsed as a
    date by /journal/<date>."""
    resp = client.get("/journal/analytics")
    assert resp.status_code == 200
    assert b"analytics-root" in resp.data


def test_journal_nav_has_analytics_link(client):
    """Every journal page exposes the Analytics link in its nav."""
    for path in ["/journal", "/journal/search", "/journal/sections"]:
        resp = client.get(path)
        assert resp.status_code == 200
        assert b'href="/journal/analytics"' in resp.data, path


# --------------------------------------------------------------------------- #
# Rich entries: @mention save behavior
# --------------------------------------------------------------------------- #

def test_save_body_mention_adds_tag_unioned_with_chips(client):
    """A body mention of an existing tag is added under its section, unioned
    with any chip selections (purely additive)."""
    sid = _first_tag_section_id()
    data = journal.load(_journal_path())
    journal.add_section_tag(data, sid, "maya")
    journal.add_section_tag(data, sid, "alex")
    journal.save(_journal_path(), data)
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "lunch with @alex",
        f"tag:{sid}": "maya"})
    e = journal.get_entry_by_date(journal.load(_journal_path()), "2026-06-15")
    assert set(e["tags"][sid]) == {"maya", "alex"}


def test_save_body_mention_non_destructive_on_resave(client):
    """Removing the mention from prose while the chip stays keeps the tag."""
    sid = _first_tag_section_id()
    data = journal.load(_journal_path())
    journal.add_section_tag(data, sid, "alex")
    journal.save(_journal_path(), data)
    # First save: chip + mention both present.
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "saw @alex",
        f"tag:{sid}": "alex"})
    # Re-save: mention dropped from body, chip still selected.
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "nothing here",
        f"tag:{sid}": "alex"})
    e = journal.get_entry_by_date(journal.load(_journal_path()), "2026-06-15")
    assert e["tags"][sid] == ["alex"]


def test_save_unknown_mention_adds_nothing(client):
    sid = _first_tag_section_id()
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "met @stranger"})
    e = journal.get_entry_by_date(journal.load(_journal_path()), "2026-06-15")
    assert sid not in e.get("tags", {})


def test_save_temp_tag_from_prior_entry_is_mentionable_and_stays_temp(client):
    """A temporary tag used on a prior entry can be mentioned on a new entry,
    and is added as temporary (not promoted to section.tags)."""
    sid = _first_tag_section_id()
    # Prior entry establishes "zed" as a temporary tag.
    client.post("/journal/save", data={
        "date": "2026-06-10", "title": "t", "body": "",
        f"newtag-name:{sid}": "zed", f"newtag-kind:{sid}": "temporary"})
    # New entry mentions @zed in the body.
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "met @zed again"})
    data = journal.load(_journal_path())
    e = journal.get_entry_by_date(data, "2026-06-15")
    assert "zed" in e["tags"][sid]
    assert "zed" not in journal.section_by_id(data, sid)["tags"]


def test_entry_page_embeds_mention_index(client):
    data = journal.load(_journal_path())
    sid = data["sections"][0]["id"]
    journal.add_section_tag(data, sid, "maya")
    journal.save(_journal_path(), data)
    resp = client.get("/journal")
    assert resp.status_code == 200
    assert b'id="mention-index"' in resp.data
    assert b"journal-richtext.js" in resp.data
    assert b"maya" in resp.data


# --------------------------------------------------------------------------- #
# Suggestions v2: detail / apply / dismiss routes
# --------------------------------------------------------------------------- #

def _people_sid():
    return journal.load(_journal_path())["sections"][0]["id"]


def test_suggestion_detail_shape(client):
    sid = _people_sid()
    client.post("/journal/save", data={
        "date": "2026-06-20", "title": "t", "body": "went running today"})
    resp = client.get("/journal/suggestions/running")
    assert resp.status_code == 200
    payload = resp.get_json()
    assert payload["word"] == "running"
    assert isinstance(payload["sections"], list)
    assert {"id", "name", "color"} <= set(payload["sections"][0])
    # only tag sections (the seeded store is all tag sections)
    assert sid in {s["id"] for s in payload["sections"]}
    occ = payload["occurrences"]
    assert occ and occ[0]["date"] == "2026-06-20"
    assert "**running**" in occ[0]["snippet"]


def test_suggestion_apply_permanent_mutates_store(client):
    sid = _people_sid()
    client.post("/journal/save", data={
        "date": "2026-06-20", "title": "t", "body": "running"})
    resp = client.post("/journal/suggestions/running/apply", data={
        "section_id": sid, "kind": "permanent", "dates": "2026-06-20"})
    assert resp.status_code == 200 and resp.get_json()["ok"] is True
    data = journal.load(_journal_path())
    assert "running" in journal.section_by_id(data, sid)["tags"]
    assert journal.get_entry_by_date(data, "2026-06-20")["tags"][sid] \
        == ["running"]


def test_suggestion_apply_temporary_multiple_dates(client):
    sid = _people_sid()
    resp = client.post("/journal/suggestions/running/apply", data={
        "section_id": sid, "kind": "temporary",
        "dates": ["2026-06-20", "2026-06-21"]})
    assert resp.get_json()["ok"] is True
    data = journal.load(_journal_path())
    assert "running" not in journal.section_by_id(data, sid)["tags"]
    for d in ("2026-06-20", "2026-06-21"):
        assert journal.get_entry_by_date(data, d)["tags"][sid] == ["running"]


def test_suggestion_apply_rejects_empty_dates_and_bad_section(client):
    sid = _people_sid()
    bad = client.post("/journal/suggestions/running/apply", data={
        "section_id": sid, "kind": "temporary", "dates": ""})
    assert bad.status_code == 400 and bad.get_json()["ok"] is False
    nosec = client.post("/journal/suggestions/running/apply", data={
        "section_id": "nope", "kind": "temporary", "dates": "2026-06-20"})
    assert nosec.status_code == 400 and nosec.get_json()["ok"] is False


def test_suggestion_dismiss_records_dismissal(client):
    resp = client.post("/journal/suggestions/running/dismiss")
    assert resp.status_code == 200 and resp.get_json()["ok"] is True
    data = journal.load(_journal_path())
    assert "running" in data["dismissed_suggestions"]


# --------------------------------------------------------------------------- #
# Task 6: Integrations page + Fitbit OAuth routes
# --------------------------------------------------------------------------- #

def test_integrations_page_renders(client):
    r = client.get("/integrations")
    assert r.status_code == 200
    assert b"Fitbit" in r.data


def test_save_credentials_then_connect_redirects_to_fitbit(client, app):
    client.post("/integrations/fitbit/credentials",
                data={"client_id": "CID", "client_secret": "SEC"})
    d = I.load(app.config["INTEGRATIONS_FILE"])
    assert d["fitbit"]["client_id"] == "CID"
    r = client.get("/integrations/fitbit/connect")
    assert r.status_code == 302
    assert "www.fitbit.com/oauth2/authorize" in r.headers["Location"]
    assert "state=" in r.headers["Location"]


def test_callback_exchanges_code(client, app, monkeypatch):
    client.post("/integrations/fitbit/credentials",
                data={"client_id": "CID", "client_secret": "SEC"})
    # capture the state the connect route stored
    client.get("/integrations/fitbit/connect")
    d = I.load(app.config["INTEGRATIONS_FILE"])
    state = d["fitbit"]["oauth_state"]
    monkeypatch.setattr("fitbit.exchange_code",
        lambda *a, **k: {"access_token": "A", "refresh_token": "R",
                         "scope": "sleep", "expires_at": 9e9})
    # avoid network on the post-connect backfill
    monkeypatch.setattr("app._fitbit_sync", lambda *a, **k: {"synced": [], "errors": []})
    r = client.get(f"/integrations/fitbit/callback?code=CODE&state={state}")
    assert r.status_code == 302
    assert I.is_connected(I.load(app.config["INTEGRATIONS_FILE"]), "fitbit")


def test_disconnect_clears_tokens(client, app):
    d = I.load(app.config["INTEGRATIONS_FILE"])
    I.set_tokens(d, "fitbit", {"access_token": "A", "refresh_token": "R"})
    I.save(app.config["INTEGRATIONS_FILE"], d)
    client.post("/integrations/fitbit/disconnect")
    assert not I.is_connected(I.load(app.config["INTEGRATIONS_FILE"]), "fitbit")


def test_callback_rejects_state_mismatch(client, app):
    """Callback with a wrong state must redirect (not 500) and stay disconnected."""
    # Save credentials so the route gets past the no-credentials guard.
    client.post("/integrations/fitbit/credentials",
                data={"client_id": "CID", "client_secret": "SEC"})
    # Initiate connect to store a real oauth_state.
    client.get("/integrations/fitbit/connect")
    # Now hit callback with a deliberately wrong state.
    r = client.get("/integrations/fitbit/callback?code=X&state=WRONG")
    assert r.status_code == 302
    assert not I.is_connected(I.load(app.config["INTEGRATIONS_FILE"]), "fitbit")


def test_callback_handles_fitbit_error(client, app):
    """Callback with ?error= must redirect (not 500) and stay disconnected."""
    r = client.get("/integrations/fitbit/callback?error=access_denied")
    assert r.status_code == 302
    assert not I.is_connected(I.load(app.config["INTEGRATIONS_FILE"]), "fitbit")


def test_sync_writes_sleep(client, app, monkeypatch):
    d = I.load(app.config["INTEGRATIONS_FILE"])
    I.set_tokens(d, "fitbit", {"access_token": "A", "refresh_token": "R",
                               "expires_at": 9e9})
    I.save(app.config["INTEGRATIONS_FILE"], d)
    monkeypatch.setattr("fitbit.fetch_sleep",
        lambda token, date, transport=None: {"sleep": [{
            "isMainSleep": True, "startTime": f"{date}T23:00:00.000",
            "endTime": f"{date}T06:00:00.000", "minutesAsleep": 420,
            "efficiency": 90, "type": "classic", "levels": {"summary": {}}}]})
    r = client.post("/integrations/fitbit/sync?days=1")
    body = r.get_json()
    assert body["ok"] and body["connected"]
    assert len(body["synced"]) == 1
    # entry got the sleep
    import journal
    jdata = journal.load(app.config["JOURNAL_FILE"])
    assert any(e.get("sleep") for e in jdata["entries"])


def test_sync_not_connected(client, app):
    r = client.post("/integrations/fitbit/sync")
    body = r.get_json()
    assert body["ok"] and body["connected"] is False


def test_sync_refreshes_on_401(client, app, monkeypatch):
    d = I.load(app.config["INTEGRATIONS_FILE"])
    I.set_credentials(d, "fitbit", "CID", "SEC")
    I.set_tokens(d, "fitbit", {"access_token": "OLD", "refresh_token": "R",
                               "expires_at": 9e9})
    I.save(app.config["INTEGRATIONS_FILE"], d)
    calls = {"n": 0}
    def fake_fetch(token, date, transport=None):
        calls["n"] += 1
        if token == "OLD":
            raise PermissionError("401")
        return {"sleep": [{"isMainSleep": True,
            "startTime": f"{date}T23:00:00.000", "endTime": f"{date}T06:00:00.000",
            "minutesAsleep": 420, "efficiency": 90, "type": "classic",
            "levels": {"summary": {}}}]}
    monkeypatch.setattr("fitbit.fetch_sleep", fake_fetch)
    monkeypatch.setattr("fitbit.refresh_tokens",
        lambda *a, **k: {"access_token": "NEW", "refresh_token": "R2",
                         "scope": "sleep", "expires_at": 9e9})
    r = client.post("/integrations/fitbit/sync?days=1")
    assert r.get_json()["synced"]
    assert I.load(app.config["INTEGRATIONS_FILE"])["fitbit"]["tokens"]["access_token"] == "NEW"


# --------------------------------------------------------------------------- #
# Task 8: Entry-form sleep panel
# --------------------------------------------------------------------------- #

def test_entry_shows_connect_fitbit_when_not_connected(client):
    """When Fitbit is not connected the entry page shows a 'Connect Fitbit' link."""
    resp = client.get("/journal")
    assert resp.status_code == 200
    assert b"Connect Fitbit" in resp.data


def test_entry_shows_no_sleep_data_when_connected_empty(client, app):
    """When Fitbit is connected but no sleep data is stored, the panel shows
    'No sleep data for this day'."""
    d = I.load(app.config["INTEGRATIONS_FILE"])
    I.set_tokens(d, "fitbit", {"access_token": "tok"})
    I.save(app.config["INTEGRATIONS_FILE"], d)
    resp = client.get("/journal")
    assert resp.status_code == 200
    assert b"No sleep data" in resp.data
