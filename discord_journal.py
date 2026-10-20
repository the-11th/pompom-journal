"""Selected Discord message capture and private inbox sync. No Flask dependency."""
from datetime import datetime, timezone
from contextlib import nullcontext
import hmac
import json
import math
from pathlib import Path
import re
import urllib.parse
import urllib.request
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
import journal_media


COMMAND = {"name": "Add to Datapom", "type": 3, "integration_types": [1], "contexts": [0, 1, 2]}
SNOWFLAKE = re.compile(r"^[0-9]{1,24}$")
RECEIPT_RETENTION_SECONDS = 660


def _empty():
    return {"receiver_url": "", "receiver_token": "", "application_id": "", "last_sync": None}


def load(path):
    path = Path(path)
    if not path.exists():
        return _empty()
    try:
        value = json.loads(path.read_text())
        if not isinstance(value, dict):
            raise ValueError()
        return {**_empty(), **value}
    except (ValueError, TypeError):
        path.replace(path.with_suffix(path.suffix + '.bak'))
        return _empty()


def verify(body, signature, timestamp, public_key, now=None):
    try:
        now = now or datetime.now(timezone.utc)
        if abs(now.timestamp() - int(timestamp)) > 300:
            return False
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_key)).verify(bytes.fromhex(signature), timestamp.encode() + body)
        return True
    except (ValueError, TypeError, InvalidSignature):
        return False


def snowflake(value):
    if not isinstance(value, str) or not SNOWFLAKE.fullmatch(value):
        raise ValueError('Invalid Discord message identifier')
    return value


def validate_receiver_config(public_key, allowed_user, inbox_token):
    if not isinstance(public_key, str) or not re.fullmatch(r'[a-fA-F0-9]{64}', public_key):
        raise ValueError('Use the Discord application public key (64 hexadecimal characters)')
    Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_key))
    snowflake(allowed_user)
    if (not isinstance(inbox_token, str) or len(inbox_token) < 32 or
            any(ord(c) < 33 or ord(c) > 126 for c in inbox_token)):
        raise ValueError('Use a random receiver token of at least 32 visible ASCII characters')


def receiver_environment(env):
    """Read current deployment names while preserving existing receiver installs."""
    config = {
        'root': env.get('DATAPOM_INBOX_DATA', env.get('TODOPUP_INBOX_DATA', '/data')),
        'public_key': env.get('DISCORD_PUBLIC_KEY'),
        'allowed_user': env.get('DISCORD_USER_ID'),
        'inbox_token': env.get('DATAPOM_INBOX_TOKEN', env.get('TODOPUP_INBOX_TOKEN')),
    }
    validate_receiver_config(config['public_key'], config['allowed_user'], config['inbox_token'])
    return config


def _empty_inbox():
    return {'messages': {}, 'seen': {}}


def load_inbox(path, now=None):
    path = Path(path)
    if not path.exists():
        return _empty_inbox()
    try:
        data = _object(json.loads(path.read_text()))
        messages = _object(data.get('messages', {}))
        seen = _object(data.get('seen', {}))
        stamp = (now or datetime.now(timezone.utc)).timestamp()
        # Old receipts have no timestamp. Keep their replay protection for one
        # final retention window when the migrated store is next saved.
        seen = {identity: stamp if value is True else value for identity, value in seen.items()
                if isinstance(identity, str) and SNOWFLAKE.fullmatch(identity) and
                (value is True or (type(value) in (int, float) and math.isfinite(value)))}
        return {'messages': messages, 'seen': seen}
    except (ValueError, TypeError):
        path.replace(path.with_suffix(path.suffix + '.bak'))
        return _empty_inbox()


def queue_message(data, interaction_id, message, now=None):
    identity = snowflake(interaction_id)
    stamp = (now or datetime.now(timezone.utc)).timestamp()
    # A request signed 300 seconds in the future remains valid 600 seconds
    # after first receipt. Expiring from the signature's age alone is unsafe.
    data['seen'] = {key: at for key, at in data['seen'].items()
                    if stamp - RECEIPT_RETENTION_SECONDS < at <= stamp}
    if identity in data['seen']:
        return 'duplicate'
    if message['id'] in data['messages']:
        data['seen'][identity] = stamp
        return 'duplicate'
    if len(data['messages']) >= 1000:
        return 'full'
    data['messages'][message['id']] = message
    data['seen'][identity] = stamp
    return 'saved'


def acknowledge_inbox(data, value):
    ids = _object(value).get('ids')
    if not isinstance(ids, list) or len(ids) > 1000:
        raise ValueError('Invalid acknowledgement')
    identities = [snowflake(identity) for identity in ids]
    for identity in identities:
        data['messages'].pop(identity, None)
    return data


def _object(value):
    if not isinstance(value, dict):
        raise ValueError('Expected a JSON object')
    return value


def selected_message(interaction, allowed_user, now=None):
    interaction = _object(interaction)
    if type(interaction.get('type')) is not int or interaction['type'] != 2:
        raise ValueError('Choose a message action')
    user = _object(interaction.get('user') or _object(interaction.get('member', {})).get('user', {}))
    if user.get('id') != allowed_user:
        raise ValueError('This journal inbox belongs to another user')
    data = _object(interaction.get('data', {}))
    if data.get('type') != 3 or data.get('name') != COMMAND['name']:
        raise ValueError('Choose Add to Datapom on a message')
    target = snowflake(data.get('target_id'))
    message = _object(_object(data.get('resolved', {})).get('messages', {})).get(target)
    if not isinstance(message, dict) or message.get('id') != target:
        raise ValueError('The selected message was not included by Discord')
    channel = snowflake(message.get('channel_id') or interaction.get('channel_id'))
    guild = snowflake(interaction['guild_id']) if interaction.get('guild_id') else '@me'
    author = _object(message.get('author', {}))
    return clean_message({
        'id': target, 'author_id': author.get('id', ''),
        'author_name': author.get('global_name') or author.get('username') or 'Discord user',
        'content': message.get('content', ''), 'timestamp': message.get('timestamp'),
        'source_url': f'https://discord.com/channels/{guild}/{channel}/{target}',
        'attachments': message.get('attachments', []),
        'captured_at': (now or datetime.now(timezone.utc)).isoformat(), 'rev': 0,
    })


def clean_message(raw):
    raw = _object(raw)
    identity = snowflake(raw.get('id'))
    stamp = datetime.fromisoformat(raw.get('timestamp', ''))
    if stamp.tzinfo is None:
        raise ValueError('Message timestamp needs a timezone')
    source = raw.get('source_url', '')
    if not re.fullmatch(r'https://discord\.com/channels/(?:@me|\d{1,24})/\d{1,24}/\d{1,24}', source):
        raise ValueError('Invalid Discord message link')
    attachments = raw.get('attachments', [])
    if not isinstance(attachments, list):
        raise ValueError('Invalid message attachments')
    cleaned_attachments = []
    for attachment in attachments[:10]:
        attachment = _object(attachment)
        try:
            size = max(0, int(attachment.get('size', 0)))
        except (ValueError, TypeError, OverflowError) as error:
            raise ValueError('Invalid attachment size') from error
        cleaned_attachments.append({'filename': journal_media._text(attachment.get('filename', 'attachment'), 300), 'size': size})
    return {'id': identity, 'rev': 0, 'author_id': journal_media._text(raw.get('author_id', ''), 30),
            'author_name': journal_media._text(raw.get('author_name', 'Discord user'), 100),
            'content': journal_media._text(raw.get('content', ''), 100000),
            'timestamp': stamp.isoformat(), 'source_url': source,
            'attachments': cleaned_attachments,
            'captured_at': raw.get('captured_at')}


def configure(data, receiver_url, token, application_id):
    parsed = urllib.parse.urlsplit(receiver_url.strip())
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('Use the HTTPS address of your private Discord receiver')
    if not isinstance(token, str) or not token.strip():
        raise ValueError('The receiver token is required')
    snowflake(application_id)
    data.update(receiver_url=receiver_url.strip().rstrip('/'), receiver_token=token.strip(), application_id=application_id)
    return data


def status(data):
    return {'connected': bool(data.get('receiver_url') and data.get('receiver_token')),
            'receiver_url': data.get('receiver_url', ''), 'application_id': data.get('application_id', ''),
            'last_sync': data.get('last_sync'),
            'install_url': ('https://discord.com/oauth2/authorize?' + urllib.parse.urlencode({
                'client_id': data['application_id'], 'scope': 'applications.commands', 'integration_type': '1'})) if data.get('application_id') else None}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Receiver redirected; check its HTTPS address')


def transport(method, url, headers, body):
    req = urllib.request.Request(url, data=body.encode() if isinstance(body, str) else body, headers=headers, method=method)
    with urllib.request.build_opener(_NoRedirect()).open(req, timeout=20) as response:
        return response.status, json.loads(response.read(20_000_000).decode())


def pull(root, config, transport=transport, now=None, store_lock=None):
    root = Path(root)
    if not status(config)['connected']:
        raise ValueError('Connect your private Discord receiver first')
    headers = {'Authorization': 'Bearer ' + config['receiver_token'], 'Content-Type': 'application/json'}
    code, body = transport('GET', config['receiver_url'] + '/inbox', headers, None)
    if code != 200 or not isinstance(body.get('messages'), list):
        raise ValueError('Could not open the Discord inbox')
    messages = [clean_message(m) for m in body['messages'][:1000]]
    with store_lock or nullcontext():
        data = journal_media.load(root / 'media.json')
        added = 0
        for message in messages:
            if message['id'] not in data['messages']:
                data['messages'][message['id']] = message
                added += 1
        journal_media.save(root / 'media.json', data)
    if messages:
        code, acknowledgement = transport('POST', config['receiver_url'] + '/inbox/ack', headers, json.dumps({'ids': [m['id'] for m in messages]}))
        if code != 200 or not isinstance(acknowledgement, dict) or acknowledgement.get('ok') is not True:
            raise ValueError('Messages saved locally; inbox acknowledgement will retry')
    config['last_sync'] = (now or datetime.now(timezone.utc)).isoformat()
    return added
