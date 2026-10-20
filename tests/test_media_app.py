import io
import json
import re
import pytest
import journal
import todo
from integrations import store as integrations
import hashlib
import struct
from pathlib import Path
from app import app


@pytest.fixture
def client(tmp_path):
    app.config.update(TESTING=True, JOURNAL_FILE=str(tmp_path / "journal.json"),
                      DATA_FILE=str(tmp_path / "tasks.json"), INTEGRATIONS_FILE=str(tmp_path / "integrations.json"))
    journal.save(app.config["JOURNAL_FILE"], journal._seeded())
    todo.save(app.config["DATA_FILE"], todo._empty())
    with app.test_client() as client:
        yield client


@pytest.mark.parametrize('version,status', [('missing', 206), ('current', 206), ('stale', 409)])
def test_map_ranges_reject_stale_archive_versions(client, version, status):
    root = Path(app.config['JOURNAL_FILE']).parent / 'maps'
    root.mkdir()
    data = bytearray(127)
    data[:8] = b'PMTiles\x03'
    data[97:102] = bytes([2, 2, 1, 0, 5])
    struct.pack_into('<iiii', data, 102, -1800000000, -850000000, 1800000000, 850000000)
    (root / 'world.pmtiles').write_bytes(data)
    suffix = '' if version == 'missing' else '?v=' + (hashlib.sha256(data).hexdigest() if version == 'current' else 'f' * 64)
    response = client.get('/journal/media/maps/file/world' + suffix, headers={'Range': 'bytes=0-7'})
    assert response.status_code == status
    if status == 409:
        assert response.json['error']['code'] == 'map_version_changed'
        assert response.headers['X-Datapom-Error'] == 'map_version_changed'
    else:
        assert response.data == b'PMTiles\x03'


def test_map_response_opens_before_a_waiting_replacement_publishes(client, monkeypatch):
    import map_packs
    import media_routes
    from threading import Event, Thread
    root = Path(app.config['JOURNAL_FILE']).parent / 'maps'
    root.mkdir()
    original = bytearray(127)
    original[:8] = b'PMTiles\x03'
    original[97:102] = bytes([2, 2, 1, 0, 5])
    struct.pack_into('<iiii', original, 102, -1800000000, -850000000, 1800000000, 850000000)
    (root / 'world.pmtiles').write_bytes(original)
    replacement = bytearray(original)
    replacement[100] = 1
    (root / 'world.part.pmtiles').write_bytes(replacement)
    entered, release, writer_started = Event(), Event(), Event()
    replies = {}
    actual_send = media_routes.send_file

    def paused_send(*args, **kwargs):
        entered.set()
        assert release.wait(3)
        return actual_send(*args, **kwargs)

    def request_range():
        with app.test_client() as independent:
            replies['response'] = independent.get('/journal/media/maps/file/world?v=' + hashlib.sha256(original).hexdigest(),
                headers={'Range': 'bytes=97-101'}, buffered=True)

    def publish():
        writer_started.set()
        map_packs.finish_pack(root, 'world')

    monkeypatch.setattr(media_routes, 'send_file', paused_send)
    reader, writer = Thread(target=request_range), Thread(target=publish)
    reader.start()
    try:
        assert entered.wait(2)
        acquired = map_packs._guard.acquire(blocking=False)
        if acquired:
            map_packs._guard.release()
        assert not acquired, 'Version validation released the publication lock before opening the range stream'
        writer.start()
        assert writer_started.wait(2)
    finally:
        release.set()
        reader.join(3)
        if writer.ident is not None:
            writer.join(3)
    assert replies['response'].status_code == 206
    assert replies['response'].data == bytes(original[97:102])
    assert (root / 'world.pmtiles').read_bytes() == replacement


def test_location_summary_tracks_days_without_written_entries(client):
    samples = [
        {"id": f"fix-{i}", "at": f"2026-09-08T12:{minute:02d}:00+08:00",
         "lat": 31.2, "lon": 121.5, "accuracy_m": 8, "session": "one",
         "speed_mps": 0, "provider": "gps"}
        for i, minute in enumerate([0, 5, 10, 15])
    ]
    assert client.post('/journal/media/tracking', json={"samples": samples}).status_code == 200
    result = client.get('/journal/media/tracking?summary=1&from=2026-09-08&to=2026-09-08')
    assert result.status_code == 200
    assert "samples" not in result.json
    assert [d["date"] for d in result.json["days"]] == ["2026-09-08"]
    assert result.json["days"][0]["summary"]["recorded_seconds"] == 900
    assert result.json["place_totals"][0]["duration_seconds"] == 900
    assert client.get('/journal/media/tracking?summary=1&from=2026-09-09').json["days"] == []
    html = client.get('/journal/2026-09-08').text
    dates = re.search(r'id="entry-dates-data">(.*?)</script>', html).group(1)
    assert json.loads(dates) == []


def test_default_analytics_range_includes_tracking_only_days_and_reuses_cached_receipts(client, monkeypatch):
    import places
    data = journal.load(app.config["JOURNAL_FILE"])
    journal.upsert_entry(data, "2026-09-10", "Review", "A journal day")
    journal.save(app.config["JOURNAL_FILE"], data)
    for day in ("2026-09-09", "2026-09-11"):
        sample = {"id": day, "at": day + "T12:00:00+08:00", "lat": 31.2, "lon": 121.5}
        assert client.post('/journal/media/tracking', json={"samples": [sample]}).status_code == 200
    expected = {"min": "2026-09-09", "max": "2026-09-11"}
    assert client.get('/journal/analytics/data').json["date_range"] == expected
    def no_observation_scan(*args, **kwargs):
        pytest.fail("An unchanged analytics refresh must reuse cached tracking receipts")
    monkeypatch.setattr(places, '_day_values', no_observation_scan)
    # This is the unfiltered feed; explicit ranges are applied by the client.
    assert client.get('/journal/analytics/data?from=&to=').json["date_range"] == expected
    assert client.get('/journal/analytics/data?from=2026-09-10&to=2026-09-10').json["date_range"] == expected


def test_default_analytics_range_tracks_new_removed_and_corrupt_days(client):
    import journal_media
    import places
    root = Path(app.config["JOURNAL_FILE"]).parent / 'tracking'
    assert client.get('/journal/analytics/data').json['date_range'] == {'min': None, 'max': None}
    day = '2026-09-11'
    row = places.clean_sample({'id': 'new', 'at': day + 'T12:00:00+08:00', 'lat': 31.2, 'lon': 121.5})
    journal_media.save(root / (day + '.json'), {'new': row})
    assert client.get('/journal/analytics/data').json['date_range'] == {'min': day, 'max': day}
    (root / (day + '.json')).write_bytes(b'corrupt saved day')
    assert client.get('/journal/analytics/data').json['date_range'] == {'min': None, 'max': None}
    assert (root / (day + '.json.bak')).read_bytes() == b'corrupt saved day'
    (root / (day + '.json')).unlink()
    assert client.get('/journal/analytics/data').json['date_range'] == {'min': None, 'max': None}


def test_calendar_dots_update_after_text_is_added_and_cleared(client):
    path = '/journal/2026-09-08/autosave'
    metrics = client.post(path, json={'mood': 5}).json
    assert metrics['calendar_entry'] is False
    written = client.post(path, json={'body': 'A walk', 'base_updated': metrics['entry']['updated']}).json
    assert written['calendar_entry'] is True
    cleared = client.post(path, json={'body': '', 'base_updated': written['entry']['updated']}).json
    assert cleared['calendar_entry'] is False
    html = client.get('/journal/2026-09-08').text
    assert json.loads(re.search(r'id="entry-dates-data">(.*?)</script>', html).group(1)) == []
    assert json.loads(re.search(r'id="occupied-dates-data">(.*?)</script>', html).group(1)) == ['2026-09-08']


def test_location_summary_validates_range_and_requires_mobile_auth(client):
    assert client.get('/journal/media/tracking?summary=1&from=bad').status_code == 400
    assert client.get('/journal/media/tracking?summary=1&from=2026-09-09&to=2026-09-08').status_code == 400
    assert client.get('/api/mobile/media/tracking?summary=1').status_code == 401


@pytest.mark.parametrize('device', ['phone', 'laptop'])
def test_locations_save_without_saving_a_journal_and_retry_idempotently(client, device):
    credentials = integrations._empty()
    _, token = integrations.create_mobile_device(credentials, 'autosave-test')
    integrations.save(app.config['INTEGRATIONS_FILE'], credentials)
    path = '/api/mobile/media/tracking' if device == 'phone' else '/journal/media/tracking'
    headers = {'Authorization': 'Bearer ' + token} if device == 'phone' else {}
    row = {'id': device + '-observation', 'at': '2026-09-08T23:59:30+08:00',
           'lat': 31.2, 'lon': 121.5, 'accuracy_m': 8, 'source_device': device}
    for _ in range(2):
        response = client.post(path, headers=headers, json={'samples': [row]})
        assert response.json['accepted'] == [row['id']]
    with app.test_client() as reopened:
        rows = reopened.get('/journal/media/tracking?from=2026-09-08&to=2026-09-08').json['samples']
    assert len(rows) == 1 and rows[0]['source_device'] == device
    assert journal.load(app.config['JOURNAL_FILE'])['entries'] == []


def test_autosave_untitled_document_and_conflict(client):
    payload = {"base_updated": None, "title": "", "body": "Hello", "document": [
        {"id": "p", "type": "text", "text": "Hello"}]}
    first = client.post("/journal/2026-09-08/autosave", json=payload)
    assert first.status_code == 200
    entry = first.json["entry"]
    assert entry["body"] == "Hello"
    assert entry["document"][0]["text"] == "Hello"
    assert client.post("/journal/2026-09-08/autosave", json={**payload, "body": "Stale"}).status_code == 409
    payload["base_updated"] = entry["updated"]
    unchanged = client.post("/journal/2026-09-08/autosave", json=payload)
    assert unchanged.json["entry"]["updated"] == entry["updated"]


def test_autosave_does_not_spawn_unfinished_tasks(client):
    r = client.post("/journal/2026-09-08/autosave", json={"body": "[] buy", "base_updated": None})
    assert r.status_code == 200
    assert todo.load(app.config["DATA_FILE"])["active"] == []


def test_upload_requires_image_and_returns_local_urls(client):
    from PIL import Image
    file = io.BytesIO()
    Image.new("RGB", (24, 24)).save(file, "PNG")
    file.seek(0)
    response = client.post("/journal/media/upload", data={"file": (file, "test.png")})
    assert response.status_code == 201
    asset = response.json["asset"]
    assert client.get(f"/journal/media/file/{asset['id']}/original").data.startswith(b"\x89PNG")
    assert client.get("/journal/media/file/invalid/original").status_code == 404


def test_mobile_media_state_protected_and_shares_web_store(client):
    assert client.get("/api/mobile/media/state").status_code == 401
    store = integrations._empty()
    _, token = integrations.create_mobile_device(store, "test")
    integrations.save(app.config["INTEGRATIONS_FILE"], store)
    r = client.get("/api/mobile/media/state", headers={"Authorization": "Bearer " + token})
    assert r.status_code == 200
    assert r.json["groups"] == client.get("/journal/media/state").json["groups"]


def test_map_region_add_retry_keeps_one_region_and_never_starts_download(client, monkeypatch):
    import map_packs
    calls = []
    monkeypatch.setattr(map_packs, 'download', lambda *args, **kwargs: calls.append((args, kwargs)))
    payload = {'action': 'add', 'id': 'b' * 32, 'name': 'Trip', 'bounds': [120, 30, 122, 32]}
    for _ in range(2):
        response = client.post('/journal/media/maps', json=payload)
        assert response.status_code == 200
        assert len([item for item in response.json['packs'] if item['name'] == 'Trip']) == 1
    assert any(item['id'] == payload['id'] for item in response.json['packs'])
    assert calls == []
    assert client.post('/journal/media/maps', json={**payload, 'bounds': [121, 30, 122, 32]}).status_code == 400


@pytest.mark.parametrize('action', [None, '', 'downlaod', 'delete', 42, [], {}])
def test_unknown_map_action_never_starts_download(client, monkeypatch, action):
    import map_packs
    calls = []
    monkeypatch.setattr(map_packs, 'download', lambda *args, **kwargs: calls.append((args, kwargs)))
    response = client.post('/journal/media/maps', json={'action': action, 'id': 'world'})
    assert response.status_code == 400
    assert calls == []


def test_permanent_photo_tags_sync_both_ways_without_changing_photo_tags(client):
    store = integrations._empty()
    _, token = integrations.create_mobile_device(store, "photo-test")
    integrations.save(app.config["INTEGRATIONS_FILE"], store)
    headers = {"Authorization": "Bearer " + token}
    response = client.post('/api/mobile/media/state', headers=headers, json={'changes': [
        {'op_id': 'photo-tags', 'kind': 'groups', 'id': 'people', 'base_rev': 0,
         'patch': {'tags': ['Alex', 'Sam']}}]})
    assert response.status_code == 200
    group = client.get('/journal/media/state').json['groups']['people']
    assert group['tags'] == ['alex', 'sam']
    response = client.post('/journal/media/state', json={'changes': [
        {'op_id': 'demote-photo-tag', 'kind': 'groups', 'id': 'people', 'base_rev': group['rev'],
         'patch': {'tags': ['sam']}}]})
    assert response.status_code == 200
    assert client.get('/api/mobile/media/state', headers=headers).json['groups']['people']['tags'] == ['sam']


def test_starred_place_round_trips_between_mobile_and_web(client):
    store = integrations._empty()
    _, token = integrations.create_mobile_device(store, "test")
    integrations.save(app.config["INTEGRATIONS_FILE"], store)
    headers = {"Authorization": "Bearer " + token}
    response = client.post('/api/mobile/media/state', headers=headers, json={'changes': [
        {'op_id': 'star-place', 'kind': 'places', 'id': 'cafe', 'base_rev': None,
         'patch': {'name': 'Favourite café', 'lat': 31.2, 'lon': 121.5, 'starred': True}}]})
    assert response.status_code == 200
    saved = client.get('/journal/media/state').json['places']['cafe']
    assert saved['starred'] is True
    response = client.post('/journal/media/state', json={'changes': [
        {'op_id': 'unstar-place', 'kind': 'places', 'id': 'cafe', 'base_rev': saved['rev'],
         'patch': {'starred': False}}]})
    assert response.status_code == 200
    mobile = client.get('/api/mobile/media/state', headers=headers).json['places']['cafe']
    assert mobile['starred'] is False
    assert (mobile['name'], mobile['lat'], mobile['lon']) == ('Favourite café', 31.2, 121.5)


def test_blank_autosave_does_not_create_a_day(client):
    r = client.post("/journal/2026-09-08/autosave", json={"title": "", "body": "", "base_updated": None})
    assert r.status_code == 200
    assert r.json["entry"] is None
    assert journal.load(app.config["JOURNAL_FILE"])["entries"] == []


def test_commit_rewrites_tasks_in_document_once(client):
    payload = {"body": "ignored", "document": [{"id": "p", "type": "text", "text": "[] buy milk"}], "base_updated": None}
    saved = client.post('/journal/2026-09-08/commit', json=payload)
    assert saved.status_code == 200
    entry = saved.json['entry']
    assert entry['body'].startswith('[task:')
    assert entry['document'][0]['text'] == entry['body']
    task_id = journal.linked_task_ids(entry['body']).pop()
    assert saved.json['task_ref_index'][task_id] == {'done': False, 'status': 'active', 'title': 'buy milk'}
    again = client.post('/journal/2026-09-08/commit', json={**entry, 'base_updated': entry['updated']})
    assert again.status_code == 200
    assert len(todo.load(app.config['DATA_FILE'])['active']) == 1


def test_autosave_returns_current_linked_task_status(client):
    data = todo._empty()
    data['archive'] = [{'id': 'abc123', 'title': 'Archived review', 'completed': '2026-09-08T10:00:00'}]
    todo.save(app.config['DATA_FILE'], data)
    result = client.post('/journal/2026-09-08/autosave', json={'body': '[task:abc123] Archived review'})
    assert result.status_code == 200
    assert result.json['task_ref_index']['abc123'] == {'done': True, 'status': 'done', 'title': 'Archived review'}


def test_empty_text_document_does_not_create_entry(client):
    r = client.post('/journal/2026-09-08/autosave', json={'document': [{'id': 'p', 'type': 'text', 'text': ''}]})
    assert r.json['entry'] is None


def test_autosave_preserves_managed_and_archived_values(client):
    data = journal.load(app.config['JOURNAL_FILE'])
    journal.add_section(data, 'sleep api', 'numeric', '#e0a955', managed='google')
    section = data['sections'][-1]['id']
    entry = journal.upsert_entry(data, '2026-09-08', 'Today', 'hello', numbers={section: 8})
    journal.save(app.config['JOURNAL_FILE'], data)
    r = client.post('/journal/2026-09-08/autosave', json={'body': 'changed', 'numbers': {}, 'base_updated': entry['updated']})
    assert r.json['entry']['numbers'][section] == 8


def test_shared_photo_group_creates_entry_section(client):
    result = client.post('/journal/media/state', json={'changes': [{'op_id':'group-add','kind':'groups','id':'travel', 'base_rev':None, 'patch':{'name':'travel','share_entry':True}}]})
    assert result.status_code == 200
    data = journal.load(app.config['JOURNAL_FILE'])
    assert next(s for s in data['sections'] if s['name']=='travel')['type'] == 'tag'


def test_partial_new_tag_is_not_promoted_until_commit(client):
    sid = journal.load(app.config['JOURNAL_FILE'])['sections'][0]['id']
    payload = {'body':'A day', 'tags':{sid:['alex']}, 'new_tags':[{'section_id':sid,'name':'alex','kind':'permanent'}]}
    saved = client.post('/journal/2026-09-08/autosave', json=payload).json['entry']
    assert 'alex' not in journal.load(app.config['JOURNAL_FILE'])['sections'][0]['tags']
    payload['base_updated'] = saved['updated']
    result = client.post('/journal/2026-09-08/commit', json=payload)
    assert result.status_code == 200
    assert 'alex' in journal.load(app.config['JOURNAL_FILE'])['sections'][0]['tags']
    assert result.json['sections']


def test_task_retry_after_interrupted_journal_save_reuses_task(client):
    import journal_commands
    import journal_media
    data = journal.load(app.config['JOURNAL_FILE']); tasks = todo._empty()
    payload = {'document':[{'id':'p','type':'text','text':'[] buy tea'}]}
    journal_commands.commit(data,tasks,'2026-09-08',payload,journal_media._empty())
    # Task store was durably written but the process died before the journal write.
    fresh = journal.load(app.config['JOURNAL_FILE'])
    journal_commands.commit(fresh,tasks,'2026-09-08',payload,journal_media._empty())
    assert len(tasks['active']) == 1


@pytest.mark.parametrize('target', ['tasks', 'journal'])
@pytest.mark.parametrize('surface', ['web', 'mobile'])
def test_http_commit_retries_after_disk_write_failure_without_duplicate_task(client, monkeypatch, target, surface):
    module = todo if target == 'tasks' else journal
    original = module.save
    def fail_once(*args, **kwargs):
        monkeypatch.setattr(module, 'save', original)
        raise OSError('Synthetic interrupted save')
    credentials = integrations._empty()
    _, token = integrations.create_mobile_device(credentials, 'synthetic')
    integrations.save(app.config['INTEGRATIONS_FILE'], credentials)
    payload = {'base_updated': None, 'request_id': 'interrupted-commit',
               'document': [{'id': 'p', 'type': 'text', 'text': '[] buy tea'}]}
    monkeypatch.setattr(module, 'save', fail_once)
    path = '/journal/2026-09-08/commit' if surface == 'web' else '/api/mobile/journal/2026-09-08'
    method = client.post if surface == 'web' else client.put
    headers = {} if surface == 'web' else {'Authorization': 'Bearer ' + token}
    with pytest.raises(OSError, match='Synthetic'):
        method(path, json=payload, headers=headers)
    assert journal.load(app.config['JOURNAL_FILE'])['entries'] == []
    first_tasks = todo.load(app.config['DATA_FILE'])['active']
    assert len(first_tasks) == (1 if target == 'journal' else 0)
    retry = method(path, json=payload, headers=headers)
    assert retry.status_code == 200
    tasks = todo.load(app.config['DATA_FILE'])['active']
    assert len(tasks) == 1
    assert retry.json['entry']['body'] == '[task:' + tasks[0]['id'] + '] buy tea'
    if first_tasks:
        assert tasks[0]['id'] == first_tasks[0]['id']


def test_discord_status_never_exposes_receiver_token(client):
    r = client.post('/journal/media/discord/config', json={'receiver_url':'https://inbox.example.com','receiver_token':'secret','application_id':'123'})
    assert r.status_code == 200
    status = client.get('/journal/media/discord/status')
    assert status.json['connected']
    assert 'secret' not in status.get_data(as_text=True)


def test_discord_pull_cannot_mark_replaced_credentials_as_synced(client, monkeypatch):
    from integrations import discord_journal
    import journal_media
    from pathlib import Path
    initial = {'receiver_url': 'https://inbox.example.com', 'receiver_token': 'old-secret', 'application_id': '123'}
    assert client.post('/journal/media/discord/config', json=initial).status_code == 200
    # The fetch returns after another request replaces credentials at the same URL.
    def pull(root, config, store_lock=None):
        replacement = {**config, 'receiver_token': 'new-secret', 'last_sync': None}
        journal_media.save(Path(root) / 'discord.json', replacement)
        config['last_sync'] = '2026-09-10T12:00:00+00:00'
        return 0
    monkeypatch.setattr(discord_journal, 'pull', pull)
    assert client.post('/journal/media/discord/pull').status_code == 200
    assert client.get('/journal/media/discord/status').json['last_sync'] is None


def test_explicit_task_commit_changes_revision_after_autosave(client):
    payload = {'document':[{'id':'p','type':'text','text':'[] buy tea'}]}
    first = client.post('/journal/2026-09-08/autosave',json=payload).json['entry']
    second = client.post('/journal/2026-09-08/commit',json={**payload,'base_updated':first['updated']}).json['entry']
    assert first['updated'] != second['updated']
    assert second['body'].startswith('[task:')


def test_unchanged_autosave_does_not_write_store(client):
    from pathlib import Path
    payload={'body':'hello'}
    entry=client.post('/journal/2026-09-08/autosave',json=payload).json['entry']
    path=Path(app.config['JOURNAL_FILE']);before=path.stat().st_mtime_ns
    client.post('/journal/2026-09-08/autosave',json={**payload,'base_updated':entry['updated']})
    assert path.stat().st_mtime_ns == before


def test_missing_edited_photo_and_malformed_changes_are_validation_errors(client):
    import journal_media
    from pathlib import Path
    media = journal_media._empty(); media['assets']['a'*64] = {'id':'a'*64}
    journal_media.save(Path(app.config['JOURNAL_FILE']).parent/'media.json',media)
    response=client.post('/journal/2026-09-08/autosave',json={'document':[{'id':'p','type':'photo','asset_id':'a'*64,'edited_asset_id':'b'*64}]})
    assert response.status_code == 400
    assert client.post('/journal/2026-09-08/autosave',json={'document':[{'id':'p','type':'text','text':'a','links':['bad']}]}).status_code == 400
    assert client.post('/journal/media/state',json={'changes':[None]}).status_code == 400


def test_new_task_can_repeat_after_removing_old_link(client):
    p={'document':[{'id':'p','type':'text','text':'[] buy tea'}]}
    first=client.post('/journal/2026-09-08/commit',json=p).json['entry']
    cleared=client.post('/journal/2026-09-08/autosave',json={'document':[{'id':'p','type':'text','text':''}], 'base_updated':first['updated']}).json['entry']
    client.post('/journal/2026-09-08/commit',json={**p,'base_updated':cleared['updated']})
    assert len(todo.load(app.config['DATA_FILE'])['active']) == 2


def test_legacy_route_cannot_overwrite_parallel_autosave(client, monkeypatch):
    import time
    import threading
    from concurrent.futures import ThreadPoolExecutor
    original=journal.load
    def slow_load(path):
        data=original(path); time.sleep(.03); return data
    monkeypatch.setattr(journal,'load',slow_load)
    start=threading.Barrier(2)
    def write(date, legacy):
        with app.test_client() as local:
            start.wait()
            if legacy: return local.post('/journal/save',data={'date':date,'title':'Legacy','body':'old form'}).status_code
            return local.post('/journal/'+date+'/autosave',json={'body':'new form'}).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        a=pool.submit(write,'2026-09-08',True); b=pool.submit(write,'2026-09-09',False)
        assert a.result() == 302
        assert b.result() == 200
    assert {e['date'] for e in original(app.config['JOURNAL_FILE'])['entries']} == {'2026-09-08','2026-09-09'}


def test_older_mobile_client_keeps_document_and_task_tokens_consistent(client):
    store = integrations._empty(); _, token=integrations.create_mobile_device(store,'old phone');integrations.save(app.config['INTEGRATIONS_FILE'],store)
    first=client.post('/journal/2026-09-08/autosave',json={'document':[{'id':'p','type':'text','text':'Hello'}]}).json['entry']
    response=client.put('/api/mobile/journal/2026-09-08',json={'request_id':'old-1','base_updated':first['updated'],'body':'Hello\n[] buy tea'},headers={'Authorization':'Bearer '+token})
    assert response.status_code == 200
    entry=response.json['entry']
    import journal_media
    assert journal_media.document_body(entry['document']) == entry['body']


@pytest.mark.parametrize('value', [[], {}, False, 0])
def test_malformed_empty_text_cannot_erase_entry(client, value):
    before = client.post('/journal/2026-09-08/autosave', json={'body':'Keep this', 'title':'Day'}).json['entry']
    stored = journal.load(app.config['JOURNAL_FILE'])
    result = client.post('/journal/2026-09-08/autosave', json={'body':value, 'title':value, 'base_updated':before['updated']})
    assert result.status_code == 400
    assert journal.load(app.config['JOURNAL_FILE']) == stored


def test_invalid_new_tag_is_validation_error(client):
    result = client.post('/journal/2026-09-08/commit', json={'body':'A day', 'new_tags':[{'kind':'permanent', 'name':None}]})
    assert result.status_code == 400


def test_nonfinite_edit_layers_do_not_partially_save_stores(client):
    import journal_media
    from pathlib import Path
    root = Path(app.config['JOURNAL_FILE']).parent
    media = journal_media._empty(); media['assets']['a'*64] = {'id':'a'*64, 'rev':0}
    journal_media.save(root/'media.json', media)
    before = Path(app.config['JOURNAL_FILE']).read_bytes()
    result = client.post('/journal/media/state', json={'changes':[{'op_id':'nan-edit', 'kind':'assets', 'id':'a'*64, 'base_rev':0, 'patch':{'edit_layers':{'x':float('nan')}}}]})
    assert result.status_code == 400
    assert Path(app.config['JOURNAL_FILE']).read_bytes() == before
    assert journal_media.load(root/'media.json') == media


@pytest.mark.parametrize('path', ['state', 'tracking', 'maps', 'discord/config'])
def test_non_object_media_request_returns_validation_error(client, path):
    assert client.post('/journal/media/' + path, json=['invalid']).status_code == 400


@pytest.mark.parametrize('path', ['settings', 'discord/setup'])
def test_media_pages_keep_journal_brand_toggle(client, path):
    html = client.get('/journal/media/' + path).get_data(as_text=True)
    import re
    assert re.search(r'class="brand-toggle"\s+href="/"', html)
    assert '<span class="brand-switch">todo &rarr;</span>' in html
