"""A slow provider must not block or overwrite a local save or disconnect."""
from threading import Event, Thread

import pytest

import app as app_module
import integrations
import journal
import todo


@pytest.mark.parametrize('provider', ['google', 'rescuetime', 'spotify'])
@pytest.mark.parametrize('operation', ['save', 'disconnect', 'credentials', 'delete'])
def test_provider_fetch_releases_store_lock_and_reconciles_latest_store(tmp_path, monkeypatch, provider, operation):
    app = app_module.app
    app.config.update(TESTING=True, DATA_FILE=str(tmp_path / 'tasks.json'),
                      JOURNAL_FILE=str(tmp_path / 'journal.json'),
                      INTEGRATIONS_FILE=str(tmp_path / 'integrations.json'))
    journal.save(app.config['JOURNAL_FILE'], journal._empty())
    todo.save(app.config['DATA_FILE'], todo._empty())
    credentials = integrations._empty()
    for name in ['google', 'spotify']:
        integrations.set_tokens(credentials, name, {'access_token': 'synthetic', 'expires_at': 9e9})
    integrations.set_api_key(credentials, 'rescuetime', 'synthetic')
    integrations.save(app.config['INTEGRATIONS_FILE'], credentials)
    entered, release, completed = Event(), Event(), Event()
    results = {}; errors = []
    day = journal.today_iso()
    if operation == 'delete':
        data = journal.load(app.config['JOURNAL_FILE'])
        entry = journal.upsert_entry(data, day, 'Delete this day', 'Original words')
        journal.save(app.config['JOURNAL_FILE'], data)
    def wait_for_provider(*args, **kwargs):
        entered.set()
        assert release.wait(5), 'Synthetic provider was not released'
        return {}
    if provider == 'google':
        monkeypatch.setattr('google_health.fetch_sleep', wait_for_provider)
        monkeypatch.setattr('google_health.parse_sleep', lambda raw, now=None: {'duration_min': 480})
    elif provider == 'rescuetime':
        def summary(*args):
            wait_for_provider()
            return [{'date': day, 'total_hours': 2}]
        monkeypatch.setattr('rescuetime.fetch_daily_summary', summary)
        monkeypatch.setattr('rescuetime.fetch_activities', lambda *args: {})
        monkeypatch.setattr('rescuetime.parse_activities', lambda *args: [])
    else:
        monkeypatch.setattr('spotify.fetch_recently_played', wait_for_provider)
        monkeypatch.setattr('spotify.parse_recently_played', lambda raw: [])
        monkeypatch.setattr('spotify.fetch_top', lambda *args: {'items': []})
    def syncing():
        try:
            with app.test_client() as client:
                results['sync'] = client.post(f'/integrations/{provider}/sync?days=1')
        except BaseException as error:
            errors.append(error)
    def local_change():
        try:
            with app.test_client() as client:
                if operation == 'save':
                    results['local'] = client.post(f'/journal/{day}/autosave', json={'body': 'Typed while provider was waiting'})
                elif operation == 'disconnect':
                    results['local'] = client.post(f'/integrations/{provider}/disconnect')
                elif operation == 'delete':
                    results['local'] = client.post(f'/journal/entry/{entry["id"]}/delete')
                elif provider == 'rescuetime':
                    results['local'] = client.post('/integrations/rescuetime/key', data={'api_key': 'replacement-key'})
                else:
                    results['local'] = client.post(f'/integrations/{provider}/credentials', data={
                        'client_id': 'replacement-client', 'client_secret': 'replacement-secret'})
        except BaseException as error:
            errors.append(error)
        finally:
            completed.set()
    sync_thread = Thread(target=syncing, daemon=True); sync_thread.start()
    assert entered.wait(2)
    local_thread = Thread(target=local_change, daemon=True); local_thread.start()
    try:
        assert completed.wait(1), 'Local operation was blocked for at least 1 second by provider network I/O'
    finally:
        release.set(); sync_thread.join(5); local_thread.join(5)
    assert not errors
    assert not sync_thread.is_alive() and not local_thread.is_alive()
    if operation == 'save':
        assert results['local'].status_code == 200
        saved = journal.get_entry_by_date(journal.load(app.config['JOURNAL_FILE']), day)
        assert saved['body'] == 'Typed while provider was waiting'
        if provider != 'spotify':
            assert saved['sleep' if provider == 'google' else provider]
    elif operation == 'disconnect':
        assert results['local'].status_code == 302
        assert not integrations.is_connected(integrations.load(app.config['INTEGRATIONS_FILE']), provider)
        assert results['sync'].json['connected'] is False
    elif operation == 'delete':
        assert results['local'].status_code == 302
        assert journal.get_entry_by_date(journal.load(app.config['JOURNAL_FILE']), day) is None
    else:
        assert results['local'].status_code == 302
        latest = integrations.get_provider(integrations.load(app.config['INTEGRATIONS_FILE']), provider)
        assert latest['api_key' if provider == 'rescuetime' else 'client_id'] == (
            'replacement-key' if provider == 'rescuetime' else 'replacement-client')
        assert results['sync'].json['errors'] == ['Connection changed during sync. Run sync again.']
