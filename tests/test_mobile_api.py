import integrations
import journal
import todo
import pytest
import app as app_module


@pytest.fixture
def app(tmp_path):
    flask_app = app_module.app
    flask_app.config["TESTING"] = True
    flask_app.config["JOURNAL_FILE"] = str(tmp_path / "journal.json")
    flask_app.config["DATA_FILE"] = str(tmp_path / "tasks.json")
    flask_app.config["INTEGRATIONS_FILE"] = str(tmp_path / "integrations.json")
    journal.save(flask_app.config["JOURNAL_FILE"], journal._seeded())
    todo.save(flask_app.config["DATA_FILE"], todo._empty())
    return flask_app


@pytest.fixture
def client(app):
    with app.test_client() as test_client:
        yield test_client


def _pair(client, app):
    store = integrations.load(app.config["INTEGRATIONS_FILE"])
    _, token = integrations.create_mobile_device(store, "Pixel")
    integrations.save(app.config["INTEGRATIONS_FILE"], store)
    return token


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def test_mobile_api_requires_bearer_token(client, app):
    assert client.get("/api/mobile/config").status_code == 401
    assert client.get("/api/mobile/config",
                      headers=_auth("wrong")).status_code == 401


def test_mobile_config_returns_sections_tags_and_task_tag_registry(client, app):
    token = _pair(client, app)
    store = journal.load(app.config["JOURNAL_FILE"])
    people = next(s for s in store["sections"] if s["name"] == "people")
    people["tags"] = ["alex"]
    people["archived_tags"] = ["sam"]
    journal.upsert_entry(store, "2026-07-14", "Earlier", "",
                         tags={people["id"]: ["casey"]})
    journal.upsert_entry(store, "2026-07-16", "Later", "")
    journal.upsert_entry(store, "2026-07-17", "2026-07-17", "")
    journal.set_entry_usage(store, "2026-07-18", {"total_seconds": 60})
    journal.upsert_entry(store, "2026-07-19", "2026-07-19", "", mood=5)
    journal.save(app.config["JOURNAL_FILE"], store)
    response = client.get("/api/mobile/config", headers=_auth(token))
    assert response.status_code == 200
    body = response.get_json()
    assert body["mood_scale"] == {"min": 1, "max": 7}
    people_config = next(section for section in body["sections"]
                         if section["name"] == "people")
    assert people_config["tags"] == ["alex"]
    assert people_config["archived_tags"] == ["sam"]
    assert "journal_tag_archive" in body["capabilities"]
    assert people_config["mention_tags"] == ["alex", "sam", "casey"]
    assert body["task_tags"] == {}
    assert body["entry_dates"] == ["2026-07-14", "2026-07-16", "2026-07-19"]
    assert body["calendar_dates"] == ["2026-07-14", "2026-07-16"]


@pytest.mark.parametrize("permanent", [True, False])
def test_mobile_tag_archive_receipt_preserves_history_and_later_restore(client, app, permanent):
    token = _pair(client, app)
    data = journal.load(app.config["JOURNAL_FILE"])
    section = journal.active_sections(data)[0]
    journal.upsert_entry(data, "2026-09-10", "History", "Keep this",
                         tags={section["id"]: ["alex"]})
    if permanent:
        journal.add_section_tag(data, section["id"], "alex")
    journal.save(app.config["JOURNAL_FILE"], data)
    entries = journal.load(app.config["JOURNAL_FILE"])["entries"]
    payload = {"request_id": "archive-alex", "section_id": section["id"],
               "name": " Alex ", "action": "archive"}
    archived = client.post("/api/mobile/tags", headers=_auth(token), json=payload)
    assert archived.status_code == 200
    assert archived.get_json()["tag"]["archived"] is True
    stored = journal.load(app.config["JOURNAL_FILE"])
    assert stored["entries"] == entries
    assert stored["sections"][0]["tags"] == []
    assert stored["sections"][0]["archived_tags"] == ["alex"]
    config = client.get("/api/mobile/config", headers=_auth(token)).get_json()
    assert config["sections"][0]["archived_tags"] == ["alex"]

    restored = client.post("/api/mobile/tags", headers=_auth(token), json={
        "request_id": "restore-alex", "section_id": section["id"], "name": "alex"})
    assert restored.status_code == 201
    # Replay uses the persisted receipt, not a second archive after the re-add.
    replay = client.post("/api/mobile/tags", headers=_auth(token), json=payload)
    assert replay.status_code == 200
    assert replay.get_json() == archived.get_json()
    stored = journal.load(app.config["JOURNAL_FILE"])
    assert stored["sections"][0]["tags"] == ["alex"]
    assert stored["sections"][0]["archived_tags"] == []
    assert stored["entries"] == entries


@pytest.mark.parametrize("patch", [
    {"section_id": "missing"}, {"section_id": []}, {"name": ["alex"]},
    {"name": None}, {"name": ""}, {"action": "delete"}, {"action": []},
    {"domain": "task", "action": "archive"}, {"domain": "unknown"},
])
def test_mobile_tag_invalid_mutation_returns_400_without_store_changes(client, app, patch):
    from pathlib import Path
    token = _pair(client, app)
    data = journal.load(app.config["JOURNAL_FILE"])
    section = journal.active_sections(data)[0]
    before = Path(app.config["JOURNAL_FILE"]).read_bytes()
    tasks_before = Path(app.config["DATA_FILE"]).read_bytes()
    response = client.post("/api/mobile/tags", headers=_auth(token), json={
        "request_id": "bad-archive", "section_id": section["id"],
        "name": "alex", "action": "archive", **patch})
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "validation_error"
    assert Path(app.config["JOURNAL_FILE"]).read_bytes() == before
    assert Path(app.config["DATA_FILE"]).read_bytes() == tasks_before


def test_mobile_tag_restore_temporary_does_not_register_permanent(client, app):
    token = _pair(client, app)
    data = journal.load(app.config["JOURNAL_FILE"])
    section = journal.active_sections(data)[0]
    journal.upsert_entry(data, "2026-09-10", "History", "",
                         tags={section["id"]: ["alex"]})
    journal.archive_temporary_tag(data, section["id"], "alex")
    journal.save(app.config["JOURNAL_FILE"], data)
    entries = journal.load(app.config["JOURNAL_FILE"])["entries"]
    payload = {"request_id": "restore-temp", "section_id": section["id"],
               "name": "alex", "action": "restore_temporary"}
    restored = client.post("/api/mobile/tags", headers=_auth(token), json=payload)
    assert restored.status_code == 200
    assert restored.get_json()["tag"]["archived"] is False
    stored = journal.load(app.config["JOURNAL_FILE"])
    assert stored["sections"][0]["tags"] == []
    assert stored["sections"][0]["archived_tags"] == []
    assert stored["entries"] == entries
    assert journal.temporary_tags(stored)[section["id"]] == ["alex"]
    # A lost acknowledgement retried after another archive must not undo it.
    journal.archive_temporary_tag(stored, section["id"], "alex")
    journal.save(app.config["JOURNAL_FILE"], stored)
    replay = client.post("/api/mobile/tags", headers=_auth(token), json=payload)
    assert replay.get_json() == restored.get_json()
    assert journal.load(app.config["JOURNAL_FILE"])["sections"][0]["archived_tags"] == ["alex"]


def test_mobile_tag_dedicated_actions_are_fail_closed_and_idempotent(client, app):
    token = _pair(client, app)
    data = journal.load(app.config["JOURNAL_FILE"])
    section = journal.active_sections(data)[0]
    journal.add_section_tag(data, section["id"], "alex")
    journal.save(app.config["JOURNAL_FILE"], data)
    payload = {"request_id": "direct-archive", "section_id": section["id"], "name": "alex"}
    archived = client.post("/api/mobile/tags/archive", headers=_auth(token), json=payload)
    assert archived.status_code == 200
    assert archived.get_json()["tag"]["archived"] is True
    restored = client.post("/api/mobile/tags/restore-temporary", headers=_auth(token),
                           json={**payload, "request_id": "direct-restore"})
    assert restored.status_code == 200
    assert restored.get_json()["tag"]["archived"] is False
    replay = client.post("/api/mobile/tags/archive", headers=_auth(token), json=payload)
    assert replay.get_json() == archived.get_json()
    section = journal.load(app.config["JOURNAL_FILE"])["sections"][0]
    assert section["tags"] == []
    assert section["archived_tags"] == []
    # A mismatched body must not turn a dedicated archive into an addition.
    mismatch = client.post("/api/mobile/tags/archive", headers=_auth(token), json={
        **payload, "request_id": "mismatch", "action": "add"})
    assert mismatch.status_code == 400
    assert journal.load(app.config["JOURNAL_FILE"])["sections"][0] == section


def test_chinese_tags_mobile_journal_task_archive_and_restore(client, app):
    token = _pair(client, app)
    headers = _auth(token)
    section_id = client.get("/api/mobile/config", headers=headers).get_json()["sections"][0]["id"]
    identity = {"section_id": section_id, "name": "小李"}
    added = client.post("/api/mobile/tags", headers=headers, json={**identity, "request_id": "cn-add"})
    assert added.status_code == 201
    saved = client.put("/api/mobile/journal/2026-09-11", headers=headers, json={
        "request_id": "cn-entry", "base_updated": None, "title": "", "body": "和 @小李 散步",
        "tags": {section_id: ["小李", "北京"]}, "numbers": {}})
    assert saved.status_code == 200
    entry = saved.get_json()["entry"]
    assert entry["tags"][section_id] == ["小李", "北京"]
    assert entry["title"] == "和 小李 散步"
    entry = client.get("/api/mobile/journal/2026-09-11", headers=headers).get_json()["entry"]
    archived = client.post("/api/mobile/tags/archive", headers=headers, json={**identity, "request_id": "cn-archive"})
    assert archived.status_code == 200
    config = client.get("/api/mobile/config", headers=headers).get_json()
    assert config["sections"][0]["archived_tags"] == ["小李"]
    restored = client.post("/api/mobile/tags/restore-temporary", headers=headers,
                           json={**identity, "request_id": "cn-restore"})
    assert restored.status_code == 200
    config = client.get("/api/mobile/config", headers=headers).get_json()
    assert config["sections"][0]["tags"] == []
    assert config["sections"][0]["archived_tags"] == []
    assert "小李" in config["sections"][0]["mention_tags"]
    assert client.get("/api/mobile/journal/2026-09-11", headers=headers).get_json()["entry"] == entry
    task_tag = client.post("/api/mobile/tags", headers=headers, json={
        "request_id": "cn-task-tag", "domain": "task", "name": "工作", "color": "#123456"})
    assert task_tag.status_code == 201
    task = client.post("/api/mobile/tasks", headers=headers, json={
        "request_id": "cn-task", "title": "联系小李", "tags": ["工作"]})
    assert task.status_code == 201
    assert task.get_json()["task"]["tags"] == ["工作"]


def test_mobile_journal_put_get_inline_fields_and_idempotency(client, app):
    token = _pair(client, app)
    store = journal.load(app.config["JOURNAL_FILE"])
    tag_section = journal.active_sections(store)[0]
    numeric = journal.add_section(store, "weight", "numeric", "#123456", unit="lb")
    journal.add_section_tag(store, tag_section["id"], "alex")
    journal.save(app.config["JOURNAL_FILE"], store)
    payload = {
        "request_id": "save-1", "base_updated": None,
        "title": "Phone day", "body": "Met @alex and #weight 175",
        "audio_transcript": "Voice note text", "mood": 6,
        "tags": {}, "numbers": {},
    }
    first = client.put("/api/mobile/journal/2026-07-15",
                       headers=_auth(token), json=payload)
    assert first.status_code == 200
    entry = first.get_json()["entry"]
    assert entry["tags"][tag_section["id"]] == ["alex"]
    assert entry["numbers"][numeric["id"]] == 175.0
    assert entry["audio_transcript"] == "Voice note text"
    again = client.put("/api/mobile/journal/2026-07-15",
                       headers=_auth(token), json={**payload, "title": "Changed"})
    assert again.get_json() == first.get_json()
    got = client.get("/api/mobile/journal/2026-07-15", headers=_auth(token))
    assert got.get_json()["entry"]["title"] == "Phone day"


def test_mobile_journal_put_derives_optional_phone_title(client, app):
    token = _pair(client, app)

    prose = client.put("/api/mobile/journal/2026-07-17", headers=_auth(token), json={
        "request_id": "untitled-prose", "title": "", "body": "washed hair and took a walk",
        "base_updated": None,
    })
    mood_only = client.put("/api/mobile/journal/2026-07-18", headers=_auth(token), json={
        "request_id": "untitled-mood", "title": "", "body": "", "mood": 5,
        "base_updated": None,
    })

    assert prose.status_code == 200
    assert prose.get_json()["entry"]["title"] == "Washed hair and took a walk"
    assert mood_only.status_code == 200
    assert mood_only.get_json()["entry"]["title"] == "2026-07-18"


def test_mobile_journal_preserves_transcript_only_entry(client, app):
    token = _pair(client, app)
    response = client.put("/api/mobile/journal/2026-09-10", headers=_auth(token), json={
        "request_id": "transcript-only", "base_updated": None,
        "title": "", "body": "", "audio_transcript": "Remember this voice note",
        "autosave": True,
    })
    assert response.status_code == 200
    entry = response.get_json()["entry"]
    assert entry is not None
    assert entry["audio_transcript"] == "Remember this voice note"
    assert journal.get_entry_by_date(journal.load(app.config["JOURNAL_FILE"]),
                                     "2026-09-10")["id"] == entry["id"]


def test_mobile_journal_put_rejects_stale_base_with_current_entry(client, app):
    token = _pair(client, app)
    first = client.put("/api/mobile/journal/2026-07-15", headers=_auth(token), json={
        "request_id": "one", "title": "First", "body": "", "base_updated": None})
    assert first.status_code == 200
    conflict = client.put("/api/mobile/journal/2026-07-15", headers=_auth(token), json={
        "request_id": "two", "title": "Stale", "body": "",
        "base_updated": "2000-01-01T00:00:00"})
    assert conflict.status_code == 409
    assert conflict.get_json()["error"]["code"] == "conflict"
    assert conflict.get_json()["current"]["title"] == "First"


def test_mobile_task_crud_and_completion(client, app):
    token = _pair(client, app)
    created = client.post("/api/mobile/tasks", headers=_auth(token), json={
        "request_id": "task-1", "title": "Call Alex", "tags": ["people"],
        "notes": "After lunch"})
    assert created.status_code == 201
    task_id = created.get_json()["task"]["id"]
    listed = client.get("/api/mobile/tasks", headers=_auth(token)).get_json()
    assert listed["tasks"][0]["notes"] == "After lunch"
    edited = client.patch(f"/api/mobile/tasks/{task_id}", headers=_auth(token), json={
        "request_id": "task-2", "title": "Call Alexandra", "done": False})
    assert edited.status_code == 200
    completed = client.patch(f"/api/mobile/tasks/{task_id}", headers=_auth(token), json={
        "request_id": "task-3", "done": True, "difficulty": "easy"})
    assert completed.status_code == 200
    assert completed.get_json()["task"]["status"] == "completed"

    reopened = client.patch(f"/api/mobile/tasks/{task_id}", headers=_auth(token), json={
        "request_id": "task-4", "title": "Call Alexandra tomorrow", "done": False})
    assert reopened.status_code == 200
    assert reopened.get_json()["task"]["status"] == "active"
    assert reopened.get_json()["task"]["done"] is False
    assert reopened.get_json()["task"]["title"] == "Call Alexandra tomorrow"


def test_mobile_task_field_baseline_preserves_unrelated_mac_edits(client, app):
    token = _pair(client, app)
    created = client.post("/api/mobile/tasks", headers=_auth(token), json={
        "request_id": "field-create", "title": "Phone title", "notes": "Original notes"}).get_json()["task"]
    task_id = created["id"]
    data = todo.load(app.config["DATA_FILE"])
    todo.set_task_notes(data, task_id, "Mac notes")
    todo.save(app.config["DATA_FILE"], data)
    response = client.patch(f"/api/mobile/tasks/{task_id}", headers=_auth(token), json={
        "request_id": "field-edit", "title": "New phone title",
        "base": {"title": "Phone title", "status": "active"},
    })
    assert response.status_code == 200
    assert response.get_json()["task"]["title"] == "New phone title"
    assert response.get_json()["task"]["notes"] == "Mac notes"


def test_mobile_task_overlap_returns_current_without_overwriting(client, app):
    token = _pair(client, app)
    created = client.post("/api/mobile/tasks", headers=_auth(token), json={
        "request_id": "overlap-create", "title": "Before"}).get_json()["task"]
    task_id = created["id"]
    data = todo.load(app.config["DATA_FILE"])
    todo.edit_task(data, task_id, "Mac title")
    todo.save(app.config["DATA_FILE"], data)
    payload = {"request_id": "overlap-edit", "title": "Phone title",
               "base": {"title": "Before", "status": "active"}}
    response = client.patch(f"/api/mobile/tasks/{task_id}", headers=_auth(token), json=payload)
    assert response.status_code == 409
    assert response.get_json()["current"]["title"] == "Mac title"
    assert todo.task_by_id(todo.load(app.config["DATA_FILE"]), task_id)[0]["title"] == "Mac title"
    assert client.patch(f"/api/mobile/tasks/{task_id}", headers=_auth(token), json=payload).get_json() == response.get_json()


def test_mobile_task_delete_does_not_discard_unseen_mac_edit(client, app):
    token = _pair(client, app)
    created = client.post("/api/mobile/tasks", headers=_auth(token), json={
        "request_id": "delete-create", "title": "Keep me", "notes": "Before"}).get_json()["task"]
    data = todo.load(app.config["DATA_FILE"])
    todo.set_task_notes(data, created["id"], "New Mac note")
    todo.save(app.config["DATA_FILE"], data)
    base = {key: created.get(key) for key in (
        "title", "due", "recurrence", "tags", "notes", "subtasks", "difficulty", "done", "status")}
    response = client.delete(f"/api/mobile/tasks/{created['id']}", headers=_auth(token), json={
        "request_id": "delete-stale", "base": base,
    })
    assert response.status_code == 409
    assert response.get_json()["current"]["notes"] == "New Mac note"
    assert todo.task_by_id(todo.load(app.config["DATA_FILE"]), created["id"])[0] is not None


def test_mobile_task_deleted_on_mac_returns_conflict_for_versioned_edit(client, app):
    token = _pair(client, app)
    response = client.patch("/api/mobile/tasks/missing", headers=_auth(token), json={
        "request_id": "deleted-edit", "title": "Phone title", "base": {"title": "Old", "status": "active"},
    })
    assert response.status_code == 409
    assert response.get_json()["current"] is None


def test_mobile_completed_task_notes_are_rejected_instead_of_silently_lost(client, app):
    token = _pair(client, app)
    created = client.post("/api/mobile/tasks", headers=_auth(token), json={
        "request_id": "completed-notes-create", "title": "Done", "done": True,
        "notes": "Original notes",
    }).get_json()["task"]
    response = client.patch(f"/api/mobile/tasks/{created['id']}", headers=_auth(token), json={
        "request_id": "completed-notes-edit", "notes": "Phone notes",
    })
    assert response.status_code == 409
    assert response.get_json()["current"]["notes"] == "Original notes"


def test_mobile_config_distinguishes_empty_existing_dates_from_deletions(client, app):
    token = _pair(client, app)
    data = journal.load(app.config["JOURNAL_FILE"])
    journal.upsert_entry(data, "2026-09-10", "2026-09-10", "")
    journal.save(app.config["JOURNAL_FILE"], data)
    response = client.get("/api/mobile/config", headers=_auth(token)).get_json()
    assert response["entry_dates"] == []
    assert response["stored_entry_dates"] == ["2026-09-10"]


def test_mobile_task_create_preserves_subtasks(client, app):
    token = _pair(client, app)
    created = client.post("/api/mobile/tasks", headers=_auth(token), json={
        "request_id": "task-with-subs", "title": "Pack bag",
        "subtasks": [
            {"text": "Water", "done": True},
            {"text": "Keys", "done": False},
        ],
    })

    assert created.status_code == 201
    assert created.get_json()["task"]["subtasks"] == [
        {"text": "Water", "done": True},
        {"text": "Keys", "done": False},
    ]


def test_mobile_task_create_preserves_valid_offline_client_id(client, app):
    token = _pair(client, app)
    client_id = "12345678-1234-4abc-9def-1234567890ab"
    created = client.post("/api/mobile/tasks", headers=_auth(token), json={
        "request_id": "offline-create", "client_id": client_id,
        "title": "Captured offline"})
    assert created.status_code == 201
    assert created.get_json()["task"]["id"] == client_id
    edited = client.patch(f"/api/mobile/tasks/{client_id}", headers=_auth(token), json={
        "request_id": "offline-edit", "notes": "Queued after create"})
    assert edited.status_code == 200


def test_mobile_task_create_rejects_invalid_or_colliding_client_id(client, app):
    token = _pair(client, app)
    bad = client.post("/api/mobile/tasks", headers=_auth(token), json={
        "request_id": "bad-id", "client_id": "../../oops", "title": "x"})
    assert bad.status_code == 400
    client_id = "a" * 32
    first = client.post("/api/mobile/tasks", headers=_auth(token), json={
        "request_id": "first-id", "client_id": client_id, "title": "first"})
    assert first.status_code == 201
    collision = client.post("/api/mobile/tasks", headers=_auth(token), json={
        "request_id": "collision-id", "client_id": client_id, "title": "second"})
    assert collision.status_code == 409
    assert collision.get_json()["error"]["code"] == "id_conflict"


def test_mobile_task_patch_replaces_validated_subtasks(client, app):
    token = _pair(client, app)
    created = client.post("/api/mobile/tasks", headers=_auth(token), json={
        "request_id": "sub-create", "title": "Trip"})
    task_id = created.get_json()["task"]["id"]
    updated = client.patch(f"/api/mobile/tasks/{task_id}", headers=_auth(token), json={
        "request_id": "sub-edit", "subtasks": [
            {"text": "Pack", "done": True},
            {"text": "Charge phone", "done": False},
        ]})
    assert updated.status_code == 200
    assert updated.get_json()["task"]["subtasks"] == [
        {"text": "Pack", "done": True},
        {"text": "Charge phone", "done": False},
    ]
    invalid = client.patch(f"/api/mobile/tasks/{task_id}", headers=_auth(token), json={
        "request_id": "sub-bad", "subtasks": [{"text": "  ", "done": False}]})
    assert invalid.status_code == 400


def test_mobile_api_validation_errors_are_json(client, app):
    token = _pair(client, app)
    response = client.put("/api/mobile/journal/not-a-date", headers=_auth(token), json={
        "request_id": "bad", "title": "x", "body": ""})
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "validation_error"
    missing = client.patch("/api/mobile/tasks/nope", headers=_auth(token), json={
        "request_id": "missing", "done": True})
    assert missing.status_code == 404


def test_manage_page_describes_usb_pairing_and_renders_revoke(client, app):
    stored = integrations.load(app.config["INTEGRATIONS_FILE"])
    device, _ = integrations.create_mobile_device(stored, "Julia phone")
    integrations.save(app.config["INTEGRATIONS_FILE"], stored)

    page = client.get("/journal/sections")
    assert b"Datapom mobile" in page.data
    assert b"USB" in page.data
    assert b"scripts/sync_android_usb.sh" in page.data
    assert b"Create device token" not in page.data
    assert b"Private Mac URL" not in page.data
    assert b"Julia phone" in page.data
    assert b"Revoke" in page.data
    response = client.post(f"/integrations/mobile/devices/{device['id']}/revoke")
    assert response.status_code == 302
