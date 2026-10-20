from datetime import datetime, timedelta, timezone
import json
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
import discord_journal as discord

NOW = datetime(2026, 9, 8, 12, tzinfo=timezone.utc)


def test_receiver_environment_uses_datapom_names_and_preserves_legacy_config():
    key = Ed25519PrivateKey.generate().public_key().public_bytes_raw().hex()
    legacy = {'DISCORD_PUBLIC_KEY': key, 'DISCORD_USER_ID': '42',
              'TODOPUP_INBOX_TOKEN': 'a' * 43, 'TODOPUP_INBOX_DATA': '/legacy'}
    assert discord.receiver_environment(legacy)['root'] == '/legacy'
    modern = {**legacy, 'DATAPOM_INBOX_TOKEN': 'b' * 43, 'DATAPOM_INBOX_DATA': '/modern'}
    config = discord.receiver_environment(modern)
    assert config == {'root': '/modern', 'public_key': key,
                      'allowed_user': '42', 'inbox_token': 'b' * 43}
    with pytest.raises(ValueError):
        discord.receiver_environment({**modern, 'DATAPOM_INBOX_TOKEN': ''})
INBOX_TOKEN = 'private-test-token-' + 'x' * 32


def interaction(user='42'):
    return {'id': '444', 'type': 2, 'user': {'id': user}, 'channel_id': '22', 'data': {
        'name': 'Add to Datapom', 'type': 3, 'target_id': '33', 'resolved': {'messages': {'33': {
            'id': '33', 'channel_id': '22', 'author': {'id': '7', 'username': 'alex'},
            'content': 'Tea later?', 'timestamp': '2026-09-08T04:05:06+00:00', 'attachments': []}}}}}


def test_signed_selected_message_only():
    key = Ed25519PrivateKey.generate(); stamp = str(int(NOW.timestamp())); body = json.dumps(interaction()).encode()
    signature = key.sign(stamp.encode() + body).hex()
    assert discord.verify(body, signature, stamp, key.public_key().public_bytes_raw().hex(), now=NOW)
    assert not discord.verify(body + b' ', signature, stamp, key.public_key().public_bytes_raw().hex(), now=NOW)
    assert not discord.verify(body, signature, str(int(stamp)-601), key.public_key().public_bytes_raw().hex(), now=NOW)
    message = discord.selected_message(interaction(), '42', now=NOW)
    assert message['content'] == 'Tea later?'
    assert message['timestamp'] == '2026-09-08T04:05:06+00:00'
    assert message['source_url'] == 'https://discord.com/channels/@me/22/33'
    with pytest.raises(ValueError): discord.selected_message(interaction('43'), '42')


def test_receiver_refuses_unsigned_and_other_users(tmp_path):
    from discord_receiver import create_app
    key = Ed25519PrivateKey.generate()
    app = create_app(tmp_path, key.public_key().public_bytes_raw().hex(), '42', INBOX_TOKEN, now=lambda: NOW)
    client = app.test_client()
    assert client.post('/interactions', json=interaction()).status_code == 401
    def send(value):
        body = json.dumps(value).encode(); stamp = str(int(NOW.timestamp()))
        return client.post('/interactions', data=body, headers={'X-Signature-Timestamp':stamp, 'X-Signature-Ed25519':key.sign(stamp.encode()+body).hex()})
    assert send({'type':1}).json == {'type':1}
    assert send(interaction()).json['data']['flags'] == 64
    assert send(interaction()).status_code == 200
    assert send(interaction('43')).status_code == 403
    assert client.get('/inbox').status_code == 401
    auth = {'Authorization':'Bearer ' + INBOX_TOKEN}
    queue = client.get('/inbox', headers=auth).json['messages']
    assert len(queue) == 1
    assert client.post('/inbox/ack', json={'ids':['33']}, headers=auth).json['ok']
    assert client.get('/inbox', headers=auth).json['messages'] == []


def test_receiver_url_requires_https_and_no_credentials():
    for value in ['http://example.com','https://user:pass@example.com','file:///tmp']:
        with pytest.raises(ValueError): discord.configure({}, value, 'token', '123')


def test_pull_saves_before_acknowledging(tmp_path):
    import journal_media
    calls=[]
    def transport(method,url,headers,body):
        calls.append((method,url))
        if url.endswith('/ack'):
            assert journal_media.load(tmp_path/'media.json')['messages']['33']['content'] == 'Tea later?'
            return 200, {'ok':True}
        return 200, {'messages':[discord.selected_message(interaction(),'42',now=NOW)]}
    config = {'receiver_url':'https://inbox.example.com','receiver_token':'token'}
    assert discord.pull(tmp_path,config,transport=transport,now=NOW) == 1
    assert calls[-1][1].endswith('/ack')


@pytest.mark.parametrize('reply', [None, [], {}, {'ok': False}, {'ok': 'true'}])
def test_pull_requires_an_explicit_successful_ack_and_keeps_the_saved_message(tmp_path, reply):
    import journal_media
    message = discord.selected_message(interaction(), '42', now=NOW)
    config = {'receiver_url': 'https://inbox.example.com', 'receiver_token': 'token', 'last_sync': 'previous'}

    def transport(method, url, headers, body):
        return (200, reply) if method == 'POST' else (200, {'messages': [message]})

    with pytest.raises(ValueError, match='acknowledgement will retry'):
        discord.pull(tmp_path, config, transport=transport, now=NOW)
    assert journal_media.load(tmp_path / 'media.json')['messages']['33']['content'] == message['content']
    assert config['last_sync'] == 'previous'


def test_pull_lost_ack_replay_keeps_local_message_edits(tmp_path):
    import journal_media
    message = discord.selected_message(interaction(), '42', now=NOW)
    config = {'receiver_url': 'https://inbox.example.com', 'receiver_token': 'token'}
    def interrupted(method, url, headers, body):
        if method == 'POST':
            raise OSError('Lost acknowledgement response')
        return 200, {'messages': [message]}
    with pytest.raises(OSError):
        discord.pull(tmp_path, config, transport=interrupted, now=NOW)
    saved = journal_media.load(tmp_path / 'media.json')
    journal_media.apply_changes(saved, [{'kind': 'messages', 'id': '33', 'op_id': 'local-note',
                                       'base_rev': 0, 'patch': {'caption': 'Keep this note', 'hidden': True}}])
    journal_media.save(tmp_path / 'media.json', saved)
    def replay(method, url, headers, body):
        return (200, {'ok': True}) if method == 'POST' else (200, {'messages': [message]})
    assert discord.pull(tmp_path, config, transport=replay, now=NOW) == 0
    result = journal_media.load(tmp_path / 'media.json')['messages']['33']
    assert result['caption'] == 'Keep this note' and result['hidden'] is True
    assert result['rev'] == 1


@pytest.fixture
def receiver(tmp_path):
    from discord_receiver import create_app
    key = Ed25519PrivateKey.generate()
    clock = [NOW]
    app = create_app(tmp_path, key.public_key().public_bytes_raw().hex(), '42', INBOX_TOKEN, now=lambda: clock[0])
    app.testing = True
    client = app.test_client()

    def send(value, signed_at=None):
        body = json.dumps(value).encode()
        stamp = str(int((signed_at or clock[0]).timestamp()))
        return client.post('/interactions', data=body, headers={
            'X-Signature-Timestamp': stamp,
            'X-Signature-Ed25519': key.sign(stamp.encode() + body).hex(),
        })
    return client, send, clock, {'Authorization': 'Bearer ' + INBOX_TOKEN}


def test_receiver_preserves_first_queued_snapshot_until_ack(receiver):
    client, send, _, auth = receiver
    assert send(interaction()).status_code == 200
    first_snapshot = client.get('/inbox', headers=auth).json['messages']
    recapture = interaction()
    recapture['id'] = '445'
    recapture['data']['resolved']['messages']['33']['content'] = 'Changed after the Mac read its snapshot'
    response = send(recapture)
    assert 'Already in your Datapom inbox' in response.json['data']['content']
    assert client.get('/inbox', headers=auth).json['messages'] == first_snapshot
    assert client.post('/inbox/ack', json={'ids': ['33']}, headers=auth).status_code == 200
    # Replaying either acknowledged interaction never requeues it.
    assert send(interaction()).status_code == 200
    assert send(recapture).status_code == 200
    assert client.get('/inbox', headers=auth).json['messages'] == []
    recapture['id'] = '446'
    assert send(recapture).status_code == 200
    assert client.get('/inbox', headers=auth).json['messages'][0]['content'].startswith('Changed')


def test_receiver_receipts_cover_future_signature_window_and_expire(receiver, tmp_path):
    client, send, clock, auth = receiver
    signed_at = NOW + timedelta(seconds=300)
    assert send(interaction(), signed_at).status_code == 200
    assert client.post('/inbox/ack', json={'ids': ['33']}, headers=auth).status_code == 200
    clock[0] = NOW + timedelta(seconds=600)
    assert send(interaction(), signed_at).status_code == 200
    assert client.get('/inbox', headers=auth).json['messages'] == []
    receipts = json.loads((tmp_path / 'inbox.json').read_text())['seen']
    assert receipts['444'] == NOW.timestamp()
    clock[0] = NOW + timedelta(seconds=660)
    next_capture = interaction(); next_capture['id'] = '445'
    assert send(next_capture).status_code == 200
    receipts = json.loads((tmp_path / 'inbox.json').read_text())['seen']
    assert '444' not in receipts
    assert receipts['445'] == clock[0].timestamp()


@pytest.mark.parametrize('value', [None, [], 3, 'message', {'type': 2, 'user': []},
                                      {'type': 2, 'user': {'id': '42'}, 'data': []}])
def test_receiver_rejects_signed_non_object_or_malformed_interactions(receiver, value):
    _, send, _, _ = receiver
    assert send(value).status_code == 403


@pytest.mark.parametrize('value', [None, [], {}, {'ids': None}, {'ids': '33'},
                                      {'ids': ['33', []]}, {'ids': ['33', 'bad']},
                                      {'ids': ['33', 44]}, {'ids': ['33', '٣٣']}])
def test_receiver_rejects_bad_ack_atomically(receiver, value):
    client, send, _, auth = receiver
    send(interaction())
    before = client.get('/inbox', headers=auth).json
    assert client.post('/inbox/ack', json=value, headers=auth).status_code == 400
    assert client.get('/inbox', headers=auth).json == before


def test_receiver_inbox_responses_cannot_be_cached(receiver):
    client, _, _, auth = receiver
    for response in [client.get('/inbox'), client.get('/inbox', headers=auth),
                     client.post('/inbox/ack', json={'ids': []}, headers=auth),
                     client.post('/inbox/ack', json=[], headers=auth)]:
        assert response.headers['Cache-Control'] == 'no-store'


@pytest.mark.parametrize(('field', 'bad'), [('public_key', ''), ('public_key', '00' * 31),
    ('public_key', 'zz' * 32), ('public_key', None), ('allowed_user', None),
    ('allowed_user', 'bad'), ('allowed_user', '٣٣'), ('allowed_user', 42),
    ('inbox_token', ''), ('inbox_token', 'x' * 31), ('inbox_token', None)])
def test_receiver_fails_closed_with_invalid_configuration(tmp_path, field, bad):
    from discord_receiver import create_app
    values = {'public_key': Ed25519PrivateKey.generate().public_key().public_bytes_raw().hex(),
              'allowed_user': '42', 'inbox_token': INBOX_TOKEN}
    values[field] = bad
    with pytest.raises(ValueError):
        create_app(tmp_path, **values)


def test_receiver_migrates_old_receipts_and_recovers_invalid_store(tmp_path):
    path = tmp_path / 'inbox.json'
    path.write_text(json.dumps({'messages': {}, 'seen': {'444': True}}))
    data = discord.load_inbox(path, now=NOW)
    assert data == {'messages': {}, 'seen': {'444': NOW.timestamp()}}
    path.write_text('[]')
    assert discord.load_inbox(path) == {'messages': {}, 'seen': {}}
    assert path.with_suffix('.json.bak').read_text() == '[]'
