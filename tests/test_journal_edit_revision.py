from copy import deepcopy
from datetime import datetime, timedelta

import pytest

from datapom.web import app as app_module
from datapom.integrations import store as integrations
from datapom.domain import journal
from datapom.domain import journal_media
from datapom.domain import todo


NOW = datetime(2026, 9, 10, 12)
DAY = '2026-09-10'


def test_provider_refresh_changes_timestamp_but_not_edit_revision():
    data = journal._empty()
    manual = journal.add_section(data, 'weight', 'numeric', '#e0a955')
    managed = journal.add_section(data, 'sleep', 'numeric', '#e0a955', managed='google')
    entry = journal.upsert_entry(data, DAY, 'Day', 'Before', numbers={manual['id']: 70}, now=NOW)
    baseline = journal.edit_revision(data, entry)
    journal.set_entry_sleep(data, DAY, {'minutes': 480}, now=NOW + timedelta(seconds=1))
    journal.set_entry_number(data, DAY, managed['id'], 8, now=NOW + timedelta(seconds=2))
    assert journal.edit_revision(data, entry) == baseline
    saved = journal.autosave_entry(data, DAY, {
        'title': 'Day', 'body': 'Phone edits', 'numbers': {manual['id']: 70},
        'base_updated': NOW.isoformat(), 'base_edit_revision': baseline,
    }, journal_media._empty(), now=NOW + timedelta(seconds=3))
    assert saved['body'] == 'Phone edits'
    assert saved['numbers'] == {manual['id']: 70, managed['id']: 8}
    assert saved['sleep'] == {'minutes': 480}
    assert journal.edit_revision(data, saved) != baseline


@pytest.mark.parametrize('field,value', [
    ('title', 'Changed'), ('body', 'Other words'), ('mood', 4),
    ('audio_transcript', 'Voice'), ('tags', {'archived': ['old']}),
    ('numbers', {'archived': 3}),
    ('document', [{'type': 'text', 'id': 'block', 'text': 'Other words'}]),
])
def test_real_user_change_conflicts_even_if_timestamp_is_unchanged(field, value):
    data = journal._empty()
    entry = journal.upsert_entry(data, DAY, 'Day', 'Before', now=NOW)
    baseline = journal.edit_revision(data, entry)
    entry[field] = value
    before = deepcopy(entry)
    with pytest.raises(journal.EntryConflictError):
        journal.autosave_entry(data, DAY, {'body': 'Draft', 'base_updated': entry['updated'],
                                         'base_edit_revision': baseline}, journal_media._empty())
    assert entry == before


def test_empty_date_revision_survives_provider_placeholder():
    data = journal._empty()
    baseline = journal.edit_revision(data, None)
    entry = journal.set_entry_usage(data, DAY, {'total_seconds': 60}, now=NOW)
    assert journal.edit_revision(data, journal.get_entry_by_date(data, DAY)) == baseline
    saved = journal.autosave_entry(data, DAY, {'body': 'First words', 'base_updated': None,
        'base_edit_revision': baseline}, journal_media._empty(), now=NOW + timedelta(seconds=1))
    assert saved['body'] == 'First words'
    assert saved['usage'] == {'total_seconds': 60}


@pytest.mark.parametrize('body', ['Draft', ''])
def test_deleted_nonempty_entry_cannot_be_recreated_or_silently_acknowledged(body):
    data = journal._empty()
    entry = journal.upsert_entry(data, DAY, 'Day', 'Before', now=NOW)
    baseline = journal.edit_revision(data, entry)
    journal.delete_entry(data, entry['id'])
    with pytest.raises(journal.EntryConflictError):
        journal.autosave_entry(data, DAY, {'body': body, 'base_updated': entry['updated'],
            'base_edit_revision': baseline}, journal_media._empty())
    assert not data['entries']


def test_legacy_timestamp_only_requests_still_conflict_after_provider_refresh():
    data = journal._empty()
    entry = journal.upsert_entry(data, DAY, 'Day', 'Before', now=NOW)
    journal.set_entry_usage(data, DAY, {'total_seconds': 60}, now=NOW + timedelta(seconds=1))
    with pytest.raises(journal.EntryConflictError):
        journal.autosave_entry(data, DAY, {'body': 'Draft', 'base_updated': NOW.isoformat()}, journal_media._empty())


@pytest.mark.parametrize('mobile', [False, True])
def test_routes_project_revision_on_reads_ack_and_conflicts_without_storing_it(tmp_path, mobile):
    app = app_module.app
    app.config.update(TESTING=True, JOURNAL_FILE=str(tmp_path / 'journal.json'),
                      DATA_FILE=str(tmp_path / 'tasks.json'), INTEGRATIONS_FILE=str(tmp_path / 'integrations.json'))
    data = journal._empty()
    original = journal.upsert_entry(data, DAY, 'Day', 'Before', now=NOW)
    journal.save(app.config['JOURNAL_FILE'], data)
    todo.save(app.config['DATA_FILE'], todo._empty())
    credentials = integrations._empty()
    _, token = integrations.create_mobile_device(credentials, 'revision-test')
    integrations.save(app.config['INTEGRATIONS_FILE'], credentials)
    headers = {'Authorization': 'Bearer ' + token} if mobile else {}
    get_path = f'/api/mobile/journal/{DAY}' if mobile else f'/journal/media/entry/{DAY}'
    put_path = f'/api/mobile/journal/{DAY}' if mobile else f'/journal/{DAY}/autosave'
    with app.test_client() as client:
        initial = client.get(get_path, headers=headers).json['entry']
        assert initial['edit_revision'] == journal.edit_revision(data, original)
        assert f'data-entry-edit-revision="{initial["edit_revision"]}"' in client.get(f'/journal/{DAY}').text
        payload = {'request_id': 'first', 'body': 'New words', 'autosave': True,
                   'base_updated': initial['updated'], 'base_edit_revision': initial['edit_revision']}
        saved = client.open(put_path, method='PUT' if mobile else 'POST', headers=headers, json=payload)
        assert saved.status_code == 200
        assert saved.json['entry']['edit_revision'] != initial['edit_revision']
        failed = client.open(put_path, method='PUT' if mobile else 'POST', headers=headers,
                             json={**payload, 'request_id': 'second', 'body': 'Stale'})
        assert failed.status_code == 409
        assert failed.json['current']['edit_revision'] == saved.json['entry']['edit_revision']
    stored = journal.load(app.config['JOURNAL_FILE'])['entries'][0]
    assert 'edit_revision' not in stored
