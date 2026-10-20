import copy
import importlib.util
import json
from pathlib import Path
import stat
import warnings

import pytest

from datapom.integrations import discord_journal
from datapom.integrations import discord_setup


APP_ID = '1547087341162602516'
PUBLIC_KEY = 'ab' * 32
BOT_TOKEN = 'fake-bot-token-never-save'
APPLICATION = {'id': APP_ID, 'name': 'datapom', 'verify_key': PUBLIC_KEY,
               'owner': {'id': '42', 'username': 'private-owner'},
               'bot': {'token': BOT_TOKEN}, 'description': 'not part of setup metadata'}
COMMAND = {'id': '12345', 'application_id': APP_ID, 'name': discord_journal.COMMAND['name'], 'type': 3}
METADATA = {'application_id': APP_ID, 'application_name': 'datapom', 'public_key': PUBLIC_KEY,
            'user_id': '42', 'command_id': '12345'}


def fake_transport(application=None, command=None, get_status=200, post_status=201):
    calls = []

    def transport(method, url, headers, body):
        calls.append((method, url, headers, body))
        if method == 'GET':
            return get_status, copy.deepcopy(APPLICATION if application is None else application)
        return post_status, copy.deepcopy(COMMAND if command is None else command)

    return transport, calls


def test_identifies_personal_owner_before_registering_current_command():
    transport, calls = fake_transport()
    result = discord_setup.register(APP_ID, BOT_TOKEN, transport=transport)
    assert result == METADATA
    assert BOT_TOKEN not in json.dumps(result)
    assert calls[0] == ('GET', 'https://discord.com/api/v10/applications/@me',
                        {'Authorization': 'Bot ' + BOT_TOKEN, 'Content-Type': 'application/json'}, None)
    assert calls[1][:2] == ('POST', f'https://discord.com/api/v10/applications/{APP_ID}/commands')
    assert json.loads(calls[1][3]) == discord_journal.COMMAND


def test_wrong_application_never_posts_or_changes_setup_file(tmp_path):
    path = tmp_path / 'setup.json'
    path.write_text(json.dumps({'application_id': APP_ID, 'public_key': PUBLIC_KEY}))
    before = path.read_bytes()
    transport, calls = fake_transport(application={**APPLICATION, 'id': '99'})
    with pytest.raises(ValueError, match='different application'):
        discord_setup.register(APP_ID, BOT_TOKEN, transport=transport)
    assert [call[0] for call in calls] == ['GET']
    assert path.read_bytes() == before


@pytest.mark.parametrize('application', [[], {'id': APP_ID},
    {**APPLICATION, 'verify_key': 'bad'}, {**APPLICATION, 'owner': {'id': 'not-an-id'}},
    {**APPLICATION, 'team': {'id': 'team-owned'}}, {**APPLICATION, 'name': ''}])
def test_invalid_application_metadata_never_posts(application):
    transport, calls = fake_transport(application=application)
    with pytest.raises(ValueError):
        discord_setup.register(APP_ID, BOT_TOKEN, transport=transport)
    assert len(calls) == 1


@pytest.mark.parametrize('status', [401, 403, 429, 500])
def test_rejected_registration_returns_no_metadata(status):
    transport, calls = fake_transport(post_status=status)
    with pytest.raises(ValueError, match='registration'):
        discord_setup.register(APP_ID, BOT_TOKEN, transport=transport)
    assert len(calls) == 2


def test_rejected_lookup_never_posts_and_transport_errors_do_not_echo_token():
    transport, calls = fake_transport(get_status=401)
    with pytest.raises(ValueError, match='identify'):
        discord_setup.register(APP_ID, BOT_TOKEN, transport=transport)
    assert len(calls) == 1
    def failed(*_):
        raise RuntimeError('Debug data: ' + BOT_TOKEN)
    with pytest.raises(ValueError) as caught:
        discord_setup.register(APP_ID, BOT_TOKEN, transport=failed)
    assert BOT_TOKEN not in str(caught.value)


@pytest.mark.parametrize('command', [[], {}, {**COMMAND, 'application_id': '99'},
    {**COMMAND, 'name': 'Another action'}, {**COMMAND, 'type': 1}])
def test_bad_registration_response_is_not_reported_as_success(command):
    transport, _ = fake_transport(command=command)
    with pytest.raises(ValueError):
        discord_setup.register(APP_ID, BOT_TOKEN, transport=transport)


def test_setup_json_merges_atomically_with_private_permissions(tmp_path, monkeypatch):
    path = tmp_path / 'setup.json'
    path.write_text(json.dumps({'public_key': PUBLIC_KEY, 'receiver_url': 'https://private.example',
                                'cloudflare_account_id': 'keep-this'}))
    path.chmod(0o644)
    original_replace = discord_setup.os.replace
    replacements = []
    def checked_replace(source, target):
        assert stat.S_IMODE(source.stat().st_mode) == 0o600
        replacements.append((source, target))
        original_replace(source, target)
    monkeypatch.setattr(discord_setup.os, 'replace', checked_replace)
    result = discord_setup.save_info(path, METADATA)
    assert result == {**METADATA, 'receiver_url': 'https://private.example', 'cloudflare_account_id': 'keep-this'}
    assert json.loads(path.read_text()) == result
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert len(replacements) == 1
    assert BOT_TOKEN not in path.read_text()
    assert list(tmp_path.iterdir()) == [path]


def test_bad_existing_json_and_secret_metadata_are_not_overwritten(tmp_path):
    path = tmp_path / 'setup.json'
    path.write_text('not json')
    with pytest.raises(ValueError):
        discord_setup.save_info(path, METADATA)
    assert path.read_text() == 'not json'
    path.unlink()
    with pytest.raises(ValueError):
        discord_setup.save_info(path, {**METADATA, 'bot_token': BOT_TOKEN})
    assert not path.exists()


def test_failed_atomic_replace_keeps_original_and_removes_temporary_file(tmp_path, monkeypatch):
    path = tmp_path / 'setup.json'
    path.write_text('{"receiver_url":"keep"}')
    def fail(*_):
        raise OSError('replace failed')
    monkeypatch.setattr(discord_setup.os, 'replace', fail)
    with pytest.raises(OSError):
        discord_setup.save_info(path, METADATA)
    assert path.read_text() == '{"receiver_url":"keep"}'
    assert list(tmp_path.iterdir()) == [path]


def script_module():
    path = Path(__file__).resolve().parents[1] / 'scripts/register_discord_command.py'
    spec = importlib.util.spec_from_file_location('register_discord_command', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_cli_flags_use_one_private_token_prompt_and_write_only_metadata(tmp_path, monkeypatch, capsys):
    script = script_module()
    path = tmp_path / 'setup.json'
    path.write_text('{"receiver_url":"https://keep.example"}')
    prompts = []
    monkeypatch.setattr(script.getpass, 'getpass', lambda prompt: prompts.append(prompt) or BOT_TOKEN)
    def register(identity, token):
        assert (identity, token) == (APP_ID, BOT_TOKEN)
        return METADATA
    monkeypatch.setattr(script.discord_setup, 'register', register)
    assert script.main(['--application-id', APP_ID, '--setup-info', str(path)]) == 0
    assert len(prompts) == 1
    assert json.loads(path.read_text()) == {**METADATA, 'receiver_url': 'https://keep.example'}
    output = capsys.readouterr()
    assert BOT_TOKEN not in output.out + output.err + path.read_text()


def test_cli_refuses_getpass_echo_fallback_before_any_request(monkeypatch, capsys):
    script = script_module()
    def visible_prompt(_):
        warnings.warn('no private terminal', script.getpass.GetPassWarning)
        pytest.fail('getpass fallback must stop before reading visible text')
    monkeypatch.setattr(script.getpass, 'getpass', visible_prompt)
    monkeypatch.setattr(script.discord_setup, 'register', lambda *_: pytest.fail('no token was entered'))
    assert script.main(['--application-id', APP_ID]) == 1
    assert 'interactive terminal' in capsys.readouterr().err
