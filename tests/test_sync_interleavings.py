"""Seeded protocol interleavings over saved/reopened synthetic stores."""
from copy import deepcopy
from datetime import datetime, timedelta
import random

import pytest

from datapom.web import app as app_module
from datapom.integrations import store as integrations
from datapom.domain import journal
from datapom.domain import journal_media
from datapom.domain import todo


@pytest.mark.parametrize('seed', [11, 29, 47, 83, 131, 197])
def test_task_field_conflicts_and_lost_acknowledgements_after_reopen(tmp_path, seed):
    rng = random.Random(seed)
    app = app_module.app
    app.config.update(TESTING=True, DATA_FILE=str(tmp_path / 'tasks.json'),
                      JOURNAL_FILE=str(tmp_path / 'journal.json'),
                      INTEGRATIONS_FILE=str(tmp_path / 'integrations.json'))
    journal.save(app.config['JOURNAL_FILE'], journal._empty())
    credentials = integrations._empty()
    _, token = integrations.create_mobile_device(credentials, 'seeded-device')
    integrations.save(app.config['INTEGRATIONS_FILE'], credentials)
    headers = {'Authorization': 'Bearer ' + token}
    values = {
        'title': ['Original', 'Mac title', 'Phone title'],
        'notes': ['Original notes', 'Mac notes', 'Phone notes'],
        'due': [None, '2030-09-11T09:30', '2030-09-12T23:59'],
        'tags': [[], ['mac'], ['phone']],
        'subtasks': [[], [{'text': 'Mac item', 'done': True}], [{'text': 'Phone item', 'done': False}]],
    }
    with app.test_client() as client:
        for index in range(40):
            store = todo._empty()
            todo.add_task(store, 'Original', now=datetime(2026, 9, 10, 12))
            task = store['active'][0]
            task.update({field: deepcopy(items[0]) for field, items in values.items()})
            identity = task['id']; path = '/api/mobile/tasks/' + identity
            todo.save(app.config['DATA_FILE'], store)
            baseline = client.get('/api/mobile/tasks', headers=headers).json['tasks'][0]
            mac_field, phone_field = rng.choices(list(values), k=2)
            same_value = rng.choice([False, False, True])
            mac_value = deepcopy(values[mac_field][1])
            phone_value = deepcopy(values[phone_field][1 if same_value else 2])
            mac = client.patch(path, headers=headers, json={
                'request_id': f'{seed}-{index}-mac', mac_field: mac_value})
            assert mac.status_code == 200
            request_id = f'{seed}-{index}-phone'
            payload = {'request_id': request_id, phone_field: phone_value,
                       'base': {'status': 'active', phone_field: baseline.get(phone_field)}}
            phone = client.patch(path, headers=headers, json=payload)
            overlaps = mac_field == phone_field and mac_value != phone_value
            assert phone.status_code == (409 if overlaps else 200), (seed, index, payload, phone.json)
            reopened = todo.mobile_task_view(todo.load(app.config['DATA_FILE']), identity)
            assert reopened[mac_field] == (phone_value if mac_field == phone_field and not overlaps else mac_value)
            assert reopened[phone_field] == (mac_value if overlaps else phone_value)
            # Simulate a lost response, a process restart, and a replay with a
            # accidentally changed body: the immutable receipt must win.
            replay = client.patch(path, headers=headers, json={**payload, phone_field: values[phone_field][0]})
            assert replay.status_code == phone.status_code and replay.json == phone.json
            assert todo.mobile_task_view(todo.load(app.config['DATA_FILE']), identity) == reopened
            deletion = client.delete(path, headers=headers, json={
                'request_id': f'{seed}-{index}-delete',
                'base': {field: baseline.get(field) for field in todo._MOBILE_TASK_FIELDS}})
            assert deletion.status_code == 409
            assert todo.mobile_task_view(todo.load(app.config['DATA_FILE']), identity) == reopened


@pytest.mark.parametrize('seed', [17, 37, 71, 113, 173, 251])
def test_provider_and_user_journal_interleavings_preserve_both_after_reopen(tmp_path, seed):
    rng = random.Random(seed)
    path = str(tmp_path / 'journal.json')
    day = '2026-09-10'; now = datetime(2026, 9, 10, 12)
    for index in range(50):
        data = journal._empty()
        manual = journal.add_section(data, 'weight', 'numeric', '#e0a955')
        managed = journal.add_section(data, 'sleep', 'numeric', '#e0a955', managed='google')
        entry = journal.upsert_entry(data, day, 'Original', 'Original text', mood=3,
                                    numbers={manual['id']: 70}, now=now)
        payload = deepcopy(entry)
        payload.update(base_updated=entry['updated'], base_edit_revision=journal.edit_revision(data, entry))
        journal.save(path, data)
        for refresh in range(rng.randint(1, 5)):
            data = journal.load(path)
            journal.set_entry_usage(data, day, {'total_seconds': refresh * 100}, now=now + timedelta(seconds=refresh + 1))
            journal.set_entry_number(data, day, managed['id'], refresh + 5, now=now + timedelta(seconds=refresh + 1))
            journal.save(path, data)
        data = journal.load(path)
        current = journal.get_entry_by_date(data, day)
        conflict = rng.choice([True, False])
        if conflict:
            field = rng.choice(['title', 'body', 'mood', 'audio_transcript'])
            current[field] = 6 if field == 'mood' else f'Mac changed {field} {index}'
            journal.save(path, data)
        before = deepcopy(current)
        data = journal.load(path)
        payload['body'] = f'Phone text {seed}:{index}'
        if conflict:
            with pytest.raises(journal.EntryConflictError):
                journal.autosave_entry(data, day, payload, journal_media._empty(), now=now + timedelta(minutes=1))
            assert journal.get_entry_by_date(data, day) == before
        else:
            saved = journal.autosave_entry(data, day, payload, journal_media._empty(), now=now + timedelta(minutes=1))
            journal.save(path, data)
            reopened = journal.get_entry_by_date(journal.load(path), day)
            assert reopened['body'] == payload['body']
            assert reopened['usage'] == before['usage']
            assert reopened['numbers'][managed['id']] == before['numbers'][managed['id']]
            assert reopened['numbers'][manual['id']] == 70
            assert journal.edit_revision(data, saved) != payload['base_edit_revision']
