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


def test_save_inline_numeric_fills_empty_field(client):
    """Body `#weight 175` with no explicit field value lands the value."""
    data = journal.load(_journal_path())
    w = journal.add_section(data, "weight", "numeric", "#fff", unit="lbs")
    journal.save(_journal_path(), data)
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "weighed in at #weight 175 today"})
    data = journal.load(_journal_path())
    e = journal.get_entry_by_date(data, "2026-06-15")
    assert e["numbers"][w["id"]] == 175.0


def test_save_explicit_field_beats_inline_numeric(client):
    """Body `#weight 175` AND explicit field `180` → field wins."""
    data = journal.load(_journal_path())
    w = journal.add_section(data, "weight", "numeric", "#fff", unit="lbs")
    journal.save(_journal_path(), data)
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "#weight 175",
        f"num:{w['id']}": "180"})
    data = journal.load(_journal_path())
    e = journal.get_entry_by_date(data, "2026-06-15")
    assert e["numbers"][w["id"]] == 180.0


def test_save_inline_numeric_unknown_section_ignored(client):
    """Body `#foo 9` referencing no section is ignored — no spurious data."""
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "#foo 9"})
    data = journal.load(_journal_path())
    e = journal.get_entry_by_date(data, "2026-06-15")
    assert e["numbers"] == {}


def test_save_inline_numeric_round_trips_into_field(client):
    """A saved inline value re-renders with the numeric field populated."""
    data = journal.load(_journal_path())
    w = journal.add_section(data, "weight", "numeric", "#fff", unit="lbs")
    journal.save(_journal_path(), data)
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "#weight 175"})
    resp = client.get("/journal/2026-06-15")
    assert resp.status_code == 200
    assert ('name="num:%s" value="175' % w["id"]).encode() in resp.data


def test_entry_page_embeds_numeric_index(client):
    """The entry page carries a numeric-index JSON blob for the client mirror."""
    data = journal.load(_journal_path())
    journal.add_section(data, "weight", "numeric", "#abcabc", unit="lbs")
    journal.save(_journal_path(), data)
    resp = client.get("/journal/2026-06-15")
    assert b'id="numeric-index"' in resp.data
    assert b"weight" in resp.data


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


def test_manage_page_shows_configure_button_and_chart_opts_data(client):
    resp = client.get("/journal/sections")
    assert resp.status_code == 200
    assert b"configure-btn" in resp.data
    assert b"section-chart-opts-data" in resp.data


def test_chart_opts_route_disables_unselected_and_reflects_on_manage_page(client):
    client.post("/journal/sections/add", data={
        "name": "money", "type": "numeric", "color": "#6fa8dc"})
    sid = next(s["id"] for s in journal.load(_journal_path())["sections"]
               if s["name"] == "money")
    keep_on = [oid for oid, _ in journal.NUMERIC_CHART_OPTIONS if oid != "numeric-cumulative"]
    resp = client.post(f"/journal/sections/{sid}/chart-opts",
                        data={"enabled": keep_on})
    assert resp.status_code == 302
    s = journal.section_by_id(journal.load(_journal_path()), sid)
    assert s["chart_opts"]["numeric-cumulative"] is False
    assert all(s["chart_opts"][oid] for oid in keep_on)

    page = client.get("/journal/sections")
    assert page.status_code == 200
    assert b"money" in page.data


def test_chart_opts_route_unknown_section_is_noop(client):
    resp = client.post("/journal/sections/missing/chart-opts", data={"enabled": ["numeric-line"]})
    assert resp.status_code == 302


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


def test_analytics_data_entries_carry_sleep(client, app):
    """The analytics feed surfaces each entry's sleep dict so the Sleep tab
    can render its charts; a staged sleep entry carries the stages key."""
    jdata = journal.load(app.config["JOURNAL_FILE"])
    journal.set_entry_sleep(jdata, "2026-06-15", {
        "duration_min": 420, "start": "23:00", "end": "06:00",
        "quality": 90, "efficiency": 90, "score": None,
        "stages": {"deep": 60, "light": 240, "rem": 90, "wake": 30},
        "source": "fitbit", "fetched": "x",
    })
    journal.save(app.config["JOURNAL_FILE"], jdata)

    resp = client.get("/journal/analytics/data")
    assert resp.status_code == 200
    payload = resp.get_json()
    sleep_entries = [e for e in payload["entries"] if e.get("sleep")]
    assert len(sleep_entries) == 1
    s = sleep_entries[0]["sleep"]
    assert s["duration_min"] == 420
    assert s["stages"]["deep"] == 60


def test_analytics_data_entries_carry_rescuetime(client, app):
    """The analytics feed surfaces each entry's rescuetime dict so the
    Productivity tab can render its charts."""
    import journal
    jdata = journal.load(app.config["JOURNAL_FILE"])
    journal.set_entry_rescuetime(jdata, "2026-06-28",
        {"pulse": 70, "productive_min": 120, "total_min": 150,
         "distracting_min": 20, "neutral_min": 10, "top_categories": [],
         "source": "rescuetime", "fetched": "x"})
    journal.save(app.config["JOURNAL_FILE"], jdata)
    body = client.get("/journal/analytics/data").get_json()
    assert any(e.get("rescuetime") for e in body["entries"])


def test_analytics_data_entries_carry_music(client, app):
    import journal
    jdata = journal.load(app.config["JOURNAL_FILE"])
    journal.set_entry_music(jdata, "2026-06-29",
        {"tracks": 10, "minutes": 40, "distinct": 9, "top_artists": [],
         "valence": None, "energy": None, "danceability": None, "tempo": None,
         "source": "spotify", "fetched": "x"})
    journal.save(app.config["JOURNAL_FILE"], jdata)
    body = client.get("/journal/analytics/data").get_json()
    assert any(e.get("music") for e in body["entries"])


def test_analytics_data_carries_leading_indicator_streams(client, app):
    """The Leading tab computes client-side from the existing payload; assert it
    still carries every stream the JS mirrors need (mood + the per-entry
    predictor streams + the task payload with completed/difficulty)."""
    import journal
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "", "mood": "5"})
    jdata = journal.load(app.config["JOURNAL_FILE"])
    journal.set_entry_sleep(jdata, "2026-06-15", {
        "duration_min": 420, "quality": 90, "source": "test", "fetched": "x"})
    journal.save(app.config["JOURNAL_FILE"], jdata)

    payload = client.get("/journal/analytics/data").get_json()
    # Every entry object exposes the predictor + target fields (nullable).
    for e in payload["entries"]:
        for field in ("mood", "numbers", "sleep", "rescuetime", "music"):
            assert field in e
    # Task payload carries completion dates + difficulty (categorical predictor).
    assert "archive" in payload["tasks"]


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

def test_integrations_redirects_to_manage_section(client):
    # The integrations UI now lives as a section on the journal Manage page;
    # /integrations is kept as a redirect for old links/bookmarks.
    r = client.get("/integrations")
    assert r.status_code == 302
    assert "/journal/sections#sec-integrations" in r.headers["Location"]


def test_manage_page_renders_integrations_section(client):
    r = client.get("/journal/sections")
    assert r.status_code == 200
    assert b'id="sec-integrations"' in r.data
    assert b"Google Health" in r.data


def test_manage_page_loads_sync_script(client):
    # The "Sync now" buttons need integrations-sync.js loaded on the manage page.
    r = client.get("/journal/sections")
    assert b"integrations-sync.js" in r.data


def test_google_save_credentials_and_connect(client, app):
    client.post("/integrations/google/credentials",
                data={"client_id": "CID", "client_secret": "SEC"})
    d = I.load(app.config["INTEGRATIONS_FILE"])
    assert d["google"]["client_id"] == "CID"
    r = client.get("/integrations/google/connect")
    assert r.status_code == 302
    assert "accounts.google.com/o/oauth2/v2/auth" in r.headers["Location"]
    assert "state=" in r.headers["Location"]


def test_google_callback_exchanges_code(client, app, monkeypatch):
    client.post("/integrations/google/credentials",
                data={"client_id": "CID", "client_secret": "SEC"})
    # capture the state the connect route stored
    client.get("/integrations/google/connect")
    d = I.load(app.config["INTEGRATIONS_FILE"])
    state = d["google"]["oauth_state"]
    monkeypatch.setattr("google_health.exchange_code",
        lambda *a, **k: {"access_token": "A", "refresh_token": "R",
                         "scope": "sleep", "expires_at": 9e9})
    # avoid network on the post-connect backfill
    monkeypatch.setattr("app._google_sync", lambda *a, **k: {"synced": [], "errors": []})
    r = client.get(f"/integrations/google/callback?code=CODE&state={state}")
    assert r.status_code == 302
    assert I.is_connected(I.load(app.config["INTEGRATIONS_FILE"]), "google")


def test_google_disconnect(client, app):
    d = I.load(app.config["INTEGRATIONS_FILE"])
    I.set_tokens(d, "google", {"access_token": "A", "refresh_token": "R"})
    I.save(app.config["INTEGRATIONS_FILE"], d)
    client.post("/integrations/google/disconnect")
    assert not I.is_connected(I.load(app.config["INTEGRATIONS_FILE"]), "google")


def test_google_callback_state_mismatch(client, app):
    """Callback with a wrong state must redirect (not 500) and stay disconnected."""
    # Save credentials so the route gets past the no-credentials guard.
    client.post("/integrations/google/credentials",
                data={"client_id": "CID", "client_secret": "SEC"})
    # Initiate connect to store a real oauth_state.
    client.get("/integrations/google/connect")
    # Now hit callback with a deliberately wrong state.
    r = client.get("/integrations/google/callback?code=X&state=WRONG")
    assert r.status_code == 302
    assert not I.is_connected(I.load(app.config["INTEGRATIONS_FILE"]), "google")


def test_google_callback_handles_error_param(client, app):
    """Callback with an ?error= (user denied consent) must redirect (not 500)
    and stay disconnected — the error is handled before any token exchange."""
    client.post("/integrations/google/credentials",
                data={"client_id": "CID", "client_secret": "SEC"})
    r = client.get("/integrations/google/callback?error=access_denied")
    assert r.status_code == 302
    assert not I.is_connected(I.load(app.config["INTEGRATIONS_FILE"]), "google")


def test_google_sync_writes_sleep(client, app, monkeypatch):
    d = I.load(app.config["INTEGRATIONS_FILE"])
    I.set_tokens(d, "google", {"access_token": "A", "refresh_token": "R",
                               "expires_at": 9e9})
    I.save(app.config["INTEGRATIONS_FILE"], d)
    monkeypatch.setattr("google_health.fetch_sleep",
        lambda token, date, transport=None: {"dataPoints": [{"sleep": {
            "interval": {
                "startTime": f"{date}T05:00:00Z", "startUtcOffset": "0s",
                "endTime": f"{date}T12:00:00Z", "endUtcOffset": "0s"},
            "sleepType": "CLASSIC", "sleepStages": [],
            "sleepSummary": {"efficiency": 90}}}]})
    r = client.post("/integrations/google/sync?days=1")
    body = r.get_json()
    assert body["ok"] and body["connected"]
    assert len(body["synced"]) == 1
    # entry got the sleep
    import journal
    jdata = journal.load(app.config["JOURNAL_FILE"])
    assert any(e.get("sleep") for e in jdata["entries"])


def test_google_sync_not_connected(client, app):
    r = client.post("/integrations/google/sync")
    body = r.get_json()
    assert body["ok"] and body["connected"] is False


def test_google_sync_refreshes_on_401(client, app, monkeypatch):
    d = I.load(app.config["INTEGRATIONS_FILE"])
    I.set_credentials(d, "google", "CID", "SEC")
    I.set_tokens(d, "google", {"access_token": "OLD", "refresh_token": "R",
                               "expires_at": 9e9})
    I.save(app.config["INTEGRATIONS_FILE"], d)
    calls = {"n": 0}
    def fake_fetch(token, date, transport=None):
        calls["n"] += 1
        if token == "OLD":
            raise PermissionError("401")
        return {"dataPoints": [{"sleep": {
            "interval": {
                "startTime": f"{date}T05:00:00Z", "startUtcOffset": "0s",
                "endTime": f"{date}T12:00:00Z", "endUtcOffset": "0s"},
            "sleepType": "CLASSIC", "sleepStages": [],
            "sleepSummary": {"efficiency": 90}}}]}
    monkeypatch.setattr("google_health.fetch_sleep", fake_fetch)
    monkeypatch.setattr("google_health.refresh_tokens",
        lambda *a, **k: {"access_token": "NEW", "refresh_token": "R2",
                         "scope": "sleep", "expires_at": 9e9})
    r = client.post("/integrations/google/sync?days=1")
    assert r.get_json()["synced"]
    assert I.load(app.config["INTEGRATIONS_FILE"])["google"]["tokens"]["access_token"] == "NEW"


# --------------------------------------------------------------------------- #
# Task 8: Entry-form sleep panel
# --------------------------------------------------------------------------- #

def test_entry_shows_connect_google_when_not_connected(client):
    """When Google Health is not connected the entry page shows a 'Connect Google Health' link."""
    resp = client.get("/journal")
    assert resp.status_code == 200
    assert b"Connect Google Health" in resp.data


def test_entry_shows_no_sleep_data_when_connected_empty(client, app):
    """When Google Health is connected but no sleep data is stored, the panel shows
    'No sleep data for this day'."""
    d = I.load(app.config["INTEGRATIONS_FILE"])
    I.set_tokens(d, "google", {"access_token": "tok"})
    I.save(app.config["INTEGRATIONS_FILE"], d)
    resp = client.get("/journal")
    assert resp.status_code == 200
    assert b"No sleep data" in resp.data


# --------------------------------------------------------------------------- #
# Task 5: RescueTime routes
# --------------------------------------------------------------------------- #

def test_rescuetime_save_key(client, app):
    client.post("/integrations/rescuetime/key", data={"api_key": "KEY123"})
    d = I.load(app.config["INTEGRATIONS_FILE"])
    assert d["rescuetime"]["api_key"] == "KEY123"
    assert I.is_connected(d, "rescuetime")


def test_rescuetime_sync_writes_entries(client, app, monkeypatch):
    d = I.load(app.config["INTEGRATIONS_FILE"])
    I.set_api_key(d, "rescuetime", "KEY123")
    I.save(app.config["INTEGRATIONS_FILE"], d)
    monkeypatch.setattr("rescuetime.fetch_daily_summary",
        lambda key, transport=None: [
            {"date": "2026-06-28", "productivity_pulse": 70,
             "all_productive_hours": 2.0, "total_hours": 3.0}])
    # Isolate the per-activity fetch (a separate Analytic Data API call).
    monkeypatch.setattr("rescuetime.fetch_activities",
        lambda key, date, transport=None: {
            "row_headers": ["Rank", "Time Spent (seconds)", "Number of People",
                            "Activity", "Category", "Productivity"],
            "rows": [[1, 3600, 1, "github.com", "Dev", 2]]})
    r = client.post("/integrations/rescuetime/sync?date=2026-06-28")
    body = r.get_json()
    assert body["ok"] and body["connected"]
    assert "2026-06-28" in body["synced"]
    import journal
    jdata = journal.load(app.config["JOURNAL_FILE"])
    rt = journal.get_entry_by_date(jdata, "2026-06-28")["rescuetime"]
    assert rt["pulse"] == 70
    # Website/app breakdown attached alongside the summary.
    assert rt["top_activities"] == [{"name": "github.com", "min": 60,
                                     "category": "Dev", "productivity": 2}]


def test_rescuetime_sync_activity_fetch_failure_keeps_summary(client, app, monkeypatch):
    d = I.load(app.config["INTEGRATIONS_FILE"])
    I.set_api_key(d, "rescuetime", "KEY123")
    I.save(app.config["INTEGRATIONS_FILE"], d)
    monkeypatch.setattr("rescuetime.fetch_daily_summary",
        lambda key, transport=None: [
            {"date": "2026-06-28", "productivity_pulse": 70,
             "all_productive_hours": 2.0, "total_hours": 3.0}])
    def boom(key, date, transport=None):
        raise RuntimeError("anapi down")
    monkeypatch.setattr("rescuetime.fetch_activities", boom)
    body = client.post("/integrations/rescuetime/sync?date=2026-06-28").get_json()
    assert "2026-06-28" in body["synced"]           # summary still written
    assert any("activities" in e for e in body["errors"])
    import journal
    jdata = journal.load(app.config["JOURNAL_FILE"])
    rt = journal.get_entry_by_date(jdata, "2026-06-28")["rescuetime"]
    assert rt["pulse"] == 70 and "top_activities" not in rt


def test_rescuetime_sync_backfills_activities_on_legacy_days(client, app, monkeypatch):
    """A day already synced before the feature (rescuetime present, no
    top_activities) gets the breakdown backfilled without a force re-sync."""
    import journal
    jdata = journal.load(app.config["JOURNAL_FILE"])
    journal.set_entry_rescuetime(jdata, "2026-06-28",
        {"pulse": 55, "total_min": 200, "top_categories": [], "source": "rescuetime", "fetched": "x"})
    journal.save(app.config["JOURNAL_FILE"], jdata)
    d = I.load(app.config["INTEGRATIONS_FILE"])
    I.set_api_key(d, "rescuetime", "KEY123")
    I.save(app.config["INTEGRATIONS_FILE"], d)
    monkeypatch.setattr("rescuetime.fetch_daily_summary",
        lambda key, transport=None: [
            {"date": "2026-06-28", "productivity_pulse": 55, "total_hours": 3.33}])
    monkeypatch.setattr("rescuetime.fetch_activities",
        lambda key, date, transport=None: {
            "row_headers": ["Rank", "Time Spent (seconds)", "Number of People",
                            "Activity", "Category", "Productivity"],
            "rows": [[1, 1200, 1, "slack.com", "Communication", 1]]})
    client.post("/integrations/rescuetime/sync")
    jdata = journal.load(app.config["JOURNAL_FILE"])
    rt = journal.get_entry_by_date(jdata, "2026-06-28")["rescuetime"]
    assert rt["pulse"] == 55                         # summary preserved (not rewritten)
    assert rt["top_activities"] == [{"name": "slack.com", "min": 20,
                                     "category": "Communication", "productivity": 1}]


def test_rescuetime_sync_not_connected(client, app):
    body = client.post("/integrations/rescuetime/sync").get_json()
    assert body["ok"] and body["connected"] is False


def test_rescuetime_disconnect(client, app):
    d = I.load(app.config["INTEGRATIONS_FILE"])
    I.set_api_key(d, "rescuetime", "KEY123")
    I.save(app.config["INTEGRATIONS_FILE"], d)
    client.post("/integrations/rescuetime/disconnect")
    assert not I.is_connected(I.load(app.config["INTEGRATIONS_FILE"]), "rescuetime")


# --------------------------------------------------------------------------- #
# Task 7: RescueTime UI — settings card + entry panel row
# --------------------------------------------------------------------------- #

def test_integrations_page_has_rescuetime_card(client):
    r = client.get("/journal/sections")
    assert b"RescueTime" in r.data
    assert b'name="api_key"' in r.data


def test_entry_shows_rescuetime_connect_when_not_connected(client):
    r = client.get("/journal")
    assert b"Connect RescueTime" in r.data


# --------------------------------------------------------------------------- #
# Phone usage — ingest / token / disconnect (shared bearer token, no OAuth)
# --------------------------------------------------------------------------- #

def _connect_phone(app, token="TOK-123"):
    d = I.load(app.config["INTEGRATIONS_FILE"])
    I.set_token(d, "phone", token)
    I.save(app.config["INTEGRATIONS_FILE"], d)


def test_phone_generate_token(client, app):
    r = client.post("/integrations/phone/token")
    assert r.status_code == 302
    d = I.load(app.config["INTEGRATIONS_FILE"])
    assert I.get_token(d, "phone")
    assert I.is_connected(d, "phone")


def test_phone_ingest_requires_token(client, app):
    _connect_phone(app)
    r = client.post("/integrations/phone/ingest",
                    json={"date": "2026-07-06", "screen_min": 100})
    assert r.status_code == 401


def test_phone_ingest_bad_token(client, app):
    _connect_phone(app, "TOK-123")
    r = client.post("/integrations/phone/ingest",
                    json={"date": "2026-07-06", "screen_min": 100},
                    headers={"Authorization": "Bearer WRONG"})
    assert r.status_code == 401


def test_phone_ingest_writes_day(client, app):
    _connect_phone(app, "TOK-123")
    r = client.post("/integrations/phone/ingest",
                    json={"date": "2026-07-06", "screen_min": 312, "unlocks": 87,
                          "top_apps": [{"name": "com.instagram.android",
                                        "label": "Instagram", "min": 74}]},
                    headers={"Authorization": "Bearer TOK-123"})
    body = r.get_json()
    assert body["ok"] and body["dates"] == ["2026-07-06"]
    jdata = journal.load(app.config["JOURNAL_FILE"])
    u = journal.get_entry_by_date(jdata, "2026-07-06")["usage"]
    assert u["screen_min"] == 312 and u["source"] == "phone"
    # last_sync recorded
    assert I.last_sync(I.load(app.config["INTEGRATIONS_FILE"]), "phone")


def test_phone_ingest_list_writes_multiple_days(client, app):
    _connect_phone(app, "TOK-123")
    r = client.post("/integrations/phone/ingest",
                    json=[{"date": "2026-07-06", "screen_min": 300},
                          {"date": "2026-07-05", "screen_min": 200},
                          {"date": "2026-07-04", "screen_min": 100}],
                    headers={"Authorization": "Bearer TOK-123"})
    body = r.get_json()
    assert set(body["dates"]) == {"2026-07-06", "2026-07-05", "2026-07-04"}
    jdata = journal.load(app.config["JOURNAL_FILE"])
    assert journal.get_entry_by_date(jdata, "2026-07-04")["usage"]["screen_min"] == 100


def test_phone_disconnect(client, app):
    _connect_phone(app, "TOK-123")
    client.post("/integrations/phone/disconnect")
    assert not I.is_connected(I.load(app.config["INTEGRATIONS_FILE"]), "phone")


def test_integrations_page_has_phone_card(client, app):
    _connect_phone(app, "TOK-123")
    r = client.get("/journal/sections")
    assert b"Phone usage" in r.data
    # endpoint URL surfaced for the phone config
    assert b"/integrations/phone/ingest" in r.data


def test_phone_card_has_apk_download_url_and_qr(client, app):
    r = client.get("/journal/sections")
    # Real GitHub Release APK link (no placeholder "#").
    assert b"releases/latest/download/phone-usage.apk" in r.data
    # Download QR div carries the APK URL in its data-qr attribute.
    assert b'class="phone-qr" data-qr="https://github.com/' in r.data
    # The vendored (local, no-CDN) QR lib is loaded on the page.
    assert b"vendor/qrcode.js" in r.data
    assert b"phone-qr.js" in r.data


def test_phone_config_qr_only_after_token_generate(client, app):
    # No token reveal on a normal page load → no config deep-link QR.
    r = client.get("/journal/sections")
    assert b"todopup://config" not in r.data
    # Generating a token reveals it once; the config QR is emitted only then,
    # carrying endpoint + token in a todopup://config deep link.
    client.post("/integrations/phone/token")
    r2 = client.get("/journal/sections")
    assert b"todopup://config" in r2.data
    assert b"token%3D" in r2.data or b"token=" in r2.data
    # ...and it is not re-rendered from storage on the next load.
    r3 = client.get("/journal/sections")
    assert b"todopup://config" not in r3.data


def test_analytics_data_entries_carry_usage(client, app):
    jdata = journal.load(app.config["JOURNAL_FILE"])
    journal.set_entry_usage(jdata, "2026-07-06",
        {"date": "2026-07-06", "screen_min": 312, "unlocks": 87,
         "top_apps": [], "source": "phone", "fetched": "x"})
    journal.save(app.config["JOURNAL_FILE"], jdata)
    body = client.get("/journal/analytics/data").get_json()
    assert any(e.get("usage") for e in body["entries"])


# --------------------------------------------------------------------------- #
# Task 5: Spotify OAuth routes + taste endpoint
# --------------------------------------------------------------------------- #

def test_spotify_save_credentials_and_connect(client, app):
    client.post("/integrations/spotify/credentials",
                data={"client_id": "CID", "client_secret": "SEC"})
    d = I.load(app.config["INTEGRATIONS_FILE"])
    assert d["spotify"]["client_id"] == "CID"
    r = client.get("/integrations/spotify/connect")
    assert r.status_code == 302
    assert "accounts.spotify.com/authorize" in r.headers["Location"]
    assert "state=" in r.headers["Location"]


def test_spotify_callback_exchanges_code(client, app, monkeypatch):
    client.post("/integrations/spotify/credentials",
                data={"client_id": "CID", "client_secret": "SEC"})
    client.get("/integrations/spotify/connect")
    state = I.load(app.config["INTEGRATIONS_FILE"])["spotify"]["oauth_state"]
    monkeypatch.setattr("spotify.exchange_code",
        lambda *a, **k: {"access_token": "A", "refresh_token": "R",
                         "scope": "s", "expires_at": 9e9})
    monkeypatch.setattr("app._spotify_sync", lambda *a, **k: {"connected": True, "synced": [], "errors": []})
    r = client.get(f"/integrations/spotify/callback?code=C&state={state}")
    assert r.status_code == 302
    assert I.is_connected(I.load(app.config["INTEGRATIONS_FILE"]), "spotify")


def test_spotify_callback_state_mismatch(client, app):
    client.post("/integrations/spotify/credentials",
                data={"client_id": "CID", "client_secret": "SEC"})
    r = client.get("/integrations/spotify/callback?code=C&state=WRONG")
    assert r.status_code == 302
    assert not I.is_connected(I.load(app.config["INTEGRATIONS_FILE"]), "spotify")


def test_spotify_taste_endpoint(client, app):
    d = I.load(app.config["INTEGRATIONS_FILE"])
    I.set_taste(d, "spotify", {"genres": {"short_term": ["indie"]}})
    I.save(app.config["INTEGRATIONS_FILE"], d)
    body = client.get("/integrations/spotify/taste").get_json()
    assert body["genres"]["short_term"] == ["indie"]


def test_spotify_disconnect(client, app):
    d = I.load(app.config["INTEGRATIONS_FILE"])
    I.set_tokens(d, "spotify", {"access_token": "A", "refresh_token": "R"})
    I.save(app.config["INTEGRATIONS_FILE"], d)
    client.post("/integrations/spotify/disconnect")
    assert not I.is_connected(I.load(app.config["INTEGRATIONS_FILE"]), "spotify")


# --------------------------------------------------------------------------- #
# Task 6: _spotify_sync orchestration + sync route
# --------------------------------------------------------------------------- #

def _rp_on(day):
    """Recently-played payload with a single play on `day` (an ISO date str).
    Built relative to the caller's date so `merge_plays`' keep-window (which
    prunes against the real clock) never drops it."""
    return {"items": [
        {"played_at": day + "T22:10:00.000Z",
         "track": {"id": "t1", "name": "A", "duration_ms": 200000,
                   "artists": [{"name": "Phoebe Bridgers"}]}}]}


def _connect_spotify(app):
    d = I.load(app.config["INTEGRATIONS_FILE"])
    I.set_credentials(d, "spotify", "CID", "SEC")
    I.set_tokens(d, "spotify", {"access_token": "A", "refresh_token": "R", "expires_at": 9e9})
    I.save(app.config["INTEGRATIONS_FILE"], d)


def test_spotify_sync_writes_music(client, app, monkeypatch):
    from datetime import date
    today = date.today().isoformat()
    _connect_spotify(app)
    monkeypatch.setattr("spotify.fetch_recently_played", lambda tok, transport=None: _rp_on(today))
    monkeypatch.setattr("spotify.fetch_audio_features", lambda tok, ids, transport=None: None)
    monkeypatch.setattr("spotify.fetch_top", lambda tok, kind, tr, transport=None: {"items": []})
    r = client.post("/integrations/spotify/sync?date=" + today)
    body = r.get_json()
    assert body["ok"] and body["connected"]
    assert today in body["synced"]
    import journal
    jdata = journal.load(app.config["JOURNAL_FILE"])
    assert journal.get_entry_by_date(jdata, today)["music"]["tracks"] == 1


def test_spotify_sync_not_connected(client, app):
    body = client.post("/integrations/spotify/sync").get_json()
    assert body["ok"] and body["connected"] is False


def test_spotify_sync_refreshes_taste(client, app, monkeypatch):
    _connect_spotify(app)
    monkeypatch.setattr("spotify.fetch_recently_played", lambda tok, transport=None: {"items": []})
    monkeypatch.setattr("spotify.fetch_audio_features", lambda tok, ids, transport=None: None)
    monkeypatch.setattr("spotify.fetch_top",
        lambda tok, kind, tr, transport=None: {"items": [{"name": "X", "genres": ["indie"]}]}
        if kind == "artists" else {"items": [{"name": "Song"}]})
    client.post("/integrations/spotify/sync")
    taste = I.get_taste(I.load(app.config["INTEGRATIONS_FILE"]), "spotify")
    assert taste["artists"]["short_term"] == ["X"]


# --------------------------------------------------------------------------- #
# Task 7: Spotify settings card + entry music panel row
# --------------------------------------------------------------------------- #

def test_integrations_page_has_spotify_card(client):
    r = client.get("/journal/sections")
    assert b"Spotify" in r.data


def test_entry_shows_connect_spotify_when_not_connected(client):
    r = client.get("/journal")
    assert b"Connect Spotify" in r.data


# --------------------------------------------------------------------------- #
# Inline [] task spawning (Spec 2)
# --------------------------------------------------------------------------- #

def _tasks_path():
    return app_module.app.config["DATA_FILE"]


def test_save_body_spawns_task_with_due_and_tag(client):
    """`[] foo >tomorrow @alex` spawns an active task (title/due/tags), the day
    is tagged `alex`, and the body is rewritten to a linked token."""
    sid = _first_tag_section_id()
    data = journal.load(_journal_path())
    journal.add_section_tag(data, sid, "alex")
    journal.save(_journal_path(), data)
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t",
        "body": "[] foo >tomorrow @alex"})
    # Task created.
    tdata = todo.load(_tasks_path())
    assert len(tdata["active"]) == 1
    task = tdata["active"][0]
    assert task["title"] == "foo @alex"
    # ">tomorrow" resolves against the real clock (the route does not inject
    # now); compare to today+1 at 23:59 rather than a hard-coded date.
    expected_due = todo.parse_due_token("tomorrow")
    assert task["due"] == expected_due
    assert task["tags"] == ["alex"]
    # Body rewritten to a linked token referencing the new id.
    e = journal.get_entry_by_date(journal.load(_journal_path()), "2026-06-15")
    assert e["body"] == "[task:%s] foo >tomorrow @alex" % task["id"]
    # Day also tagged with the mention.
    assert "alex" in e["tags"][sid]


def test_save_body_spawn_is_idempotent_on_resave(client):
    """Re-saving the (rewritten) body does not spawn a duplicate task."""
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "[] buy milk"})
    tdata = todo.load(_tasks_path())
    assert len(tdata["active"]) == 1
    linked_id = tdata["active"][0]["id"]
    e = journal.get_entry_by_date(journal.load(_journal_path()), "2026-06-15")
    assert e["body"] == "[task:%s] buy milk" % linked_id
    # Re-save the rewritten body verbatim.
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": e["body"]})
    assert len(todo.load(_tasks_path())["active"]) == 1


def test_save_body_empty_title_marker_not_spawned(client):
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "[]\n[] real"})
    tdata = todo.load(_tasks_path())
    assert [t["title"] for t in tdata["active"]] == ["real"]


def test_entry_page_embeds_task_ref_index(client):
    """The entry page carries a task-ref-index blob reflecting linked tasks'
    status (active/done/expired/missing)."""
    # Active task.
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "[] still open"})
    tdata = todo.load(_tasks_path())
    active_id = tdata["active"][0]["id"]

    # Complete it -> moves to archive (done).
    todo.refresh(tdata, [active_id], now=__import__("datetime").datetime(2026, 6, 15, 13))
    todo.save(_tasks_path(), tdata)

    resp = client.get("/journal/2026-06-15")
    assert resp.status_code == 200
    assert b'id="task-ref-index"' in resp.data
    body = resp.get_data(as_text=True)
    import json as _json, re as _re
    m = _re.search(r'id="task-ref-index">(.*?)</script>', body, _re.S)
    idx = _json.loads(m.group(1))
    assert idx[active_id]["status"] == "done"
    assert idx[active_id]["done"] is True


def test_task_ref_index_missing_status(client):
    """A [task:bogus] token with no matching task renders as missing."""
    data = journal.load(_journal_path())
    journal.upsert_entry(data, "2026-06-15", "t", "[task:deadbeef] ghost")
    journal.save(_journal_path(), data)
    resp = client.get("/journal/2026-06-15")
    body = resp.get_data(as_text=True)
    import json as _json, re as _re
    m = _re.search(r'id="task-ref-index">(.*?)</script>', body, _re.S)
    idx = _json.loads(m.group(1))
    assert idx["deadbeef"]["status"] == "missing"
    assert idx["deadbeef"]["done"] is False


# --------------------------------------------------------------------------- #
# Sleep -> managed numeric sections (integration through the routes)
# --------------------------------------------------------------------------- #

def _connect_google(app):
    d = I.load(app.config["INTEGRATIONS_FILE"])
    I.set_tokens(d, "google", {"access_token": "A", "refresh_token": "R",
                               "expires_at": 9e9})
    I.save(app.config["INTEGRATIONS_FILE"], d)


def test_google_sync_creates_managed_sections_staged(client, app, monkeypatch):
    _connect_google(app)
    monkeypatch.setattr("google_health.fetch_sleep",
        lambda token, date, transport=None: {"dataPoints": [{"sleep": {
            "interval": {
                "startTime": f"{date}T05:14:00Z", "startUtcOffset": "-25200s",
                "endTime": f"{date}T12:58:00Z", "endUtcOffset": "-25200s"},
            "sleepType": "STAGES",
            "sleepStages": [
                {"stageType": "DEEP", "duration": "4260s"},
                {"stageType": "LIGHT", "duration": "14400s"},
                {"stageType": "REM", "duration": "5400s"},
                {"stageType": "AWAKE", "duration": "1800s"}],
            "sleepSummary": {"efficiency": 92}}}]})
    r = client.post("/integrations/google/sync?days=1")
    assert r.get_json()["ok"]
    jdata = journal.load(app.config["JOURNAL_FILE"])
    managed = {s["metric"]: s for s in jdata["sections"] if s.get("managed")}
    assert set(managed) == {"sleep_duration", "sleep_quality", "deep_sleep",
                            "rem_sleep", "light_sleep", "awake_time"}
    assert managed["sleep_duration"]["unit"] == "hrs"
    assert managed["sleep_quality"]["unit"] == "%"
    assert managed["deep_sleep"]["unit"] == "min"
    assert all(s["managed"] == "google_sleep" for s in managed.values())
    entry = next(e for e in jdata["entries"] if e.get("sleep"))
    nums = entry["numbers"]
    assert nums[managed["deep_sleep"]["id"]] == 71.0
    assert nums[managed["awake_time"]["id"]] == 30.0
    assert nums[managed["sleep_quality"]["id"]] == 92.0


def test_google_sync_classic_creates_only_two(client, app, monkeypatch):
    _connect_google(app)
    monkeypatch.setattr("google_health.fetch_sleep",
        lambda token, date, transport=None: {"dataPoints": [{"sleep": {
            "interval": {
                "startTime": f"{date}T05:00:00Z", "startUtcOffset": "0s",
                "endTime": f"{date}T12:00:00Z", "endUtcOffset": "0s"},
            "sleepType": "CLASSIC", "sleepStages": [],
            "sleepSummary": {"efficiency": 90}}}]})
    client.post("/integrations/google/sync?days=1")
    jdata = journal.load(app.config["JOURNAL_FILE"])
    metrics = {s["metric"] for s in jdata["sections"] if s.get("managed")}
    assert metrics == {"sleep_duration", "sleep_quality"}


def test_entry_form_excludes_managed_numeric_input(client, app):
    jdata = journal.load(app.config["JOURNAL_FILE"])
    plain = journal.add_section(jdata, "weight", "numeric", "#6fa8dc", unit="kg")
    ids = journal.ensure_sleep_sections(jdata, ["sleep_duration"])
    journal.save(app.config["JOURNAL_FILE"], jdata)
    r = client.get("/journal/2026-06-15")
    html = r.get_data(as_text=True)
    assert f'name="num:{plain["id"]}"' in html            # normal input present
    assert f'name="num:{ids["sleep_duration"]}"' not in html  # managed hidden


def test_journal_save_preserves_managed_number(client, app):
    jdata = journal.load(app.config["JOURNAL_FILE"])
    ids = journal.ensure_sleep_sections(jdata, ["sleep_duration"])
    sid = ids["sleep_duration"]
    journal.set_entry_number(jdata, "2026-06-15", sid, 7.5)
    journal.save(app.config["JOURNAL_FILE"], jdata)
    # Save the entry without any num: field for the managed section.
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "hello", "body": "world"})
    jdata = journal.load(app.config["JOURNAL_FILE"])
    entry = journal.get_entry_by_date(jdata, "2026-06-15")
    assert entry["numbers"][sid] == 7.5      # managed value survived


def test_managed_section_appears_in_search(client, app):
    jdata = journal.load(app.config["JOURNAL_FILE"])
    ids = journal.ensure_sleep_sections(jdata, ["sleep_duration"])
    sid = ids["sleep_duration"]
    journal.set_entry_number(jdata, "2026-06-15", sid, 7.5)
    journal.save(app.config["JOURNAL_FILE"], jdata)
    r = client.get("/journal/search")
    html = r.get_data(as_text=True)
    assert "sleep duration" in html
    assert sid in html


def test_inline_numeric_capture_skips_managed(client, app):
    jdata = journal.load(app.config["JOURNAL_FILE"])
    ids = journal.ensure_sleep_sections(jdata, ["sleep_duration"])
    sid = ids["sleep_duration"]
    journal.save(app.config["JOURNAL_FILE"], jdata)
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "slept #sleep_duration 5"})
    jdata = journal.load(app.config["JOURNAL_FILE"])
    entry = journal.get_entry_by_date(jdata, "2026-06-15")
    assert sid not in (entry.get("numbers") or {})   # not captured


def test_manage_page_shows_auto_pill_for_managed(client, app):
    jdata = journal.load(app.config["JOURNAL_FILE"])
    journal.ensure_sleep_sections(jdata, ["sleep_duration"])
    journal.save(app.config["JOURNAL_FILE"], jdata)
    r = client.get("/journal/sections")
    assert "pill-auto" in r.get_data(as_text=True)
