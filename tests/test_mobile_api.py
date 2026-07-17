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
    enrollment = integrations.issue_mobile_enrollment(store)
    integrations.save(app.config["INTEGRATIONS_FILE"], store)
    response = client.post("/api/mobile/enroll", json={
        "enrollment_token": enrollment, "device_name": "Pixel"})
    assert response.status_code == 201
    return response.get_json()["token"]


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
    journal.save(app.config["JOURNAL_FILE"], store)
    response = client.get("/api/mobile/config", headers=_auth(token))
    assert response.status_code == 200
    body = response.get_json()
    assert body["mood_scale"] == {"min": 1, "max": 7}
    people_config = next(section for section in body["sections"]
                         if section["name"] == "people")
    assert people_config["tags"] == ["alex"]
    assert people_config["mention_tags"] == ["alex", "sam", "casey"]
    assert body["task_tags"] == {}


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


def test_manage_page_renders_mobile_pairing_and_device_revoke(client, app, monkeypatch):
    monkeypatch.setenv("TODOPUP_PUBLIC_URL", "https://mac.example.ts.net")
    response = client.post("/integrations/mobile/enrollment")
    assert response.status_code == 302
    page = client.get("/journal/sections")
    assert b"TodoPup mobile" in page.data
    assert b"https://mac.example.ts.net" in page.data
    assert b"todopup://config?" in page.data
    assert b"Scan to pair" in page.data
    assert b"https://mac.example.ts.net/integrations/phone/ingest" in page.data
    assert b"https://mac.example.ts.net/integrations/health/ingest" in page.data

    _pair(client, app)
    page = client.get("/journal/sections")
    assert b"Pixel" in page.data
    assert b"Revoke" in page.data
