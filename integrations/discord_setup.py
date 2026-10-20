"""Discord application verification and local setup metadata. No HTTP framework."""
import json
import os
from pathlib import Path
import re
import tempfile

from . import discord_journal


API = 'https://discord.com/api/v10'
FIELDS = frozenset(('application_id', 'application_name', 'public_key', 'user_id', 'command_id'))
PUBLIC_KEY = re.compile(r'^[a-fA-F0-9]{64}$')


def _metadata(value):
    if not isinstance(value, dict) or set(value) != FIELDS:
        raise ValueError('Setup metadata must contain only the verified application fields')
    result = dict(value)
    for field in ('application_id', 'user_id', 'command_id'):
        result[field] = discord_journal.snowflake(result[field])
    name = result['application_name']
    if not isinstance(name, str) or not name.strip() or len(name) > 100:
        raise ValueError('The Discord application name is missing or invalid')
    result['application_name'] = name.strip()
    key = result['public_key']
    if not isinstance(key, str) or not PUBLIC_KEY.fullmatch(key):
        raise ValueError('The Discord application public key is missing or invalid')
    result['public_key'] = key.lower()
    return result


def _request(transport, method, url, headers, body, purpose):
    try:
        status, value = transport(method, url, headers, body)
    except Exception as error:
        code = getattr(error, 'code', None)
        suffix = f' (HTTP {code})' if type(code) is int else ''
        # Transport exceptions can contain request headers; never surface them.
        raise ValueError(f'Discord could not {purpose}{suffix}. Check the application bot token and try again.') from None
    if status not in ((200,) if method == 'GET' else (200, 201)):
        code = f' (HTTP {status})' if type(status) is int else ''
        raise ValueError(f'Discord rejected {purpose}{code}. Check the application bot token and try again.')
    return value


def register(application_id, bot_token, transport=discord_journal.transport):
    """Verify the token's app, register the action, and return non-secret metadata."""
    identity = discord_journal.snowflake(application_id)
    if not isinstance(bot_token, str) or not bot_token.strip() or any(c.isspace() for c in bot_token.strip()):
        raise ValueError('Enter the application bot token at the private prompt')
    headers = {'Authorization': 'Bot ' + bot_token.strip(), 'Content-Type': 'application/json'}
    application = _request(transport, 'GET', API + '/applications/@me', headers, None, 'identify the application')
    if not isinstance(application, dict):
        raise ValueError('Discord returned invalid application information')
    if application.get('id') != identity:
        raise ValueError('This bot token belongs to a different application. Nothing was registered.')
    if application.get('team') is not None:
        raise ValueError('Use your personally owned Discord application for this private inbox')
    owner = application.get('owner')
    if not isinstance(owner, dict):
        raise ValueError('Discord did not include a personal application owner')
    # Validate every required setup field before performing the command mutation.
    metadata = _metadata({'application_id': identity, 'application_name': application.get('name'),
                          'public_key': application.get('verify_key'), 'user_id': owner.get('id'),
                          'command_id': '0'})
    command = _request(transport, 'POST', f'{API}/applications/{identity}/commands', headers,
                       json.dumps(discord_journal.COMMAND), 'command registration')
    if (not isinstance(command, dict) or command.get('application_id') != identity
            or command.get('name') != discord_journal.COMMAND['name'] or command.get('type') != 3):
        raise ValueError('Discord returned an unexpected command registration result')
    metadata['command_id'] = discord_journal.snowflake(command.get('id'))
    return metadata


def save_info(path, metadata):
    """Atomically merge the five allowed fields, preserving existing setup keys."""
    fields = _metadata(metadata)
    path = Path(path)
    try:
        existing = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        existing = {}
    except (ValueError, UnicodeError):
        raise ValueError('The setup-info file is not valid JSON; it was left unchanged') from None
    if not isinstance(existing, dict):
        raise ValueError('The setup-info file must contain a JSON object; it was left unchanged')
    merged = {**existing, **fields}
    encoded = json.dumps(merged, ensure_ascii=False, allow_nan=False, indent=2) + '\n'
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, filename = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    temporary = Path(filename)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return merged
