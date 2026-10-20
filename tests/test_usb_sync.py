from pathlib import Path
import os
import subprocess
import shutil
import time
import textwrap
from datapom.integrations import store as integration_store
import pytest


def _write_success_adb(path):
    path.write_text('#!/bin/sh\necho "$*" >> "${ADB_CALLS:-/dev/null}"\n'
                    'case "$*" in *get-state) printf "device\\n";; *"am start"*) printf "Status: ok\\n";; esac\n')
    path.chmod(0o755)


def _python_adapter(tmp_path, root):
    """Run helper Python; route HTTP in-process to an isolated Flask client."""
    wrapper = tmp_path / 'python-http-adapter'
    wrapper.write_text('#!' + str(root / '.venv/bin/python') + '\n' + textwrap.dedent('''
        import io, json, os, sys, time, urllib.request, urllib.error, urllib.parse
        from pathlib import Path
        sys.path.insert(0, os.environ['TEST_REPOSITORY'])
        from datapom.web import app as app_module
        folder = Path(os.environ['TODOPUP_INTEGRATIONS_FILE']).parent
        app_module.app.config.update(TESTING=True, INTEGRATIONS_FILE=os.environ['TODOPUP_INTEGRATIONS_FILE'],
            JOURNAL_FILE=str(folder/'journal.json'), DATA_FILE=str(folder/'tasks.json'))
        original_read = Path.read_text
        def read(path, *args, **kwargs):
            value = original_read(path, *args, **kwargs)
            if str(path) == os.environ['TODOPUP_USB_TOKEN_FILE'] and os.environ.get('PAUSE_READY'):
                ready, release = Path(os.environ['PAUSE_READY']), Path(os.environ['PAUSE_RELEASE'])
                if not ready.exists():
                    ready.write_text('paused')
                    deadline = time.monotonic() + 8
                    while not release.exists():
                        if time.monotonic() > deadline: raise RuntimeError('Synthetic helper was not released')
                        time.sleep(.01)
            return value
        Path.read_text = read
        def request_http(request, *args, **kwargs):
            with app_module.app.test_client() as client:
                response = client.open(urllib.parse.urlsplit(request.full_url).path,
                    method=request.method, data=request.data, headers=dict(request.header_items()),
                    environ_overrides={'REMOTE_ADDR': os.environ.get('TEST_REMOTE_ADDR', '127.0.0.1')})
            if response.status_code >= 400:
                raise urllib.error.HTTPError(request.full_url, response.status_code, 'Synthetic response', {}, io.BytesIO(response.data))
            return io.BytesIO(response.data)
        urllib.request.urlopen = request_http
        code = sys.argv[2]
        sys.argv = ['-c'] + sys.argv[3:]
        exec(compile(code, '<usb-helper>', 'exec'))
    '''))
    wrapper.chmod(0o755)
    return wrapper


@pytest.mark.parametrize('env_prefix', ['DATAPOM', 'TODOPUP'])
def test_usb_sync_creates_reverse_tunnel_and_triggers_full_sync(tmp_path, env_prefix):
    root = Path(__file__).parents[1]
    calls = tmp_path / "adb-calls"
    adb = tmp_path / "adb"
    _write_success_adb(adb)
    token = tmp_path / "usb-token"
    token.write_text("secret-device-token")
    integrations = tmp_path / "integrations.json"
    integrations.write_text("{}")
    env = os.environ.copy()
    env.update({
        "ADB": str(adb),
        "PYTHON": str(_python_adapter(tmp_path, root)),
        "TEST_REPOSITORY": str(root),
        "ADB_CALLS": str(calls),
        "TODOPUP_USB_TOKEN_FILE": str(token),
        "TODOPUP_INTEGRATIONS_FILE": str(integrations),
        "TODOPUP_SKIP_SERVER_CHECK": "1",
        "TODOPUP_USAGE_SYNC_WAIT_SECONDS": "0",
    })
    if env_prefix == 'DATAPOM':
        for key in ('USB_TOKEN_FILE', 'SKIP_SERVER_CHECK', 'USAGE_SYNC_WAIT_SECONDS'):
            env[f'DATAPOM_{key}'] = env[f'TODOPUP_{key}']
        # The new name wins when both are set; never write the old token path.
        env['TODOPUP_USB_TOKEN_FILE'] = str(tmp_path / 'unused-token')
        env['TODOPUP_USAGE_SYNC_WAIT_SECONDS'] = '30'

    result = subprocess.run(
        ["/bin/bash", str(root / "scripts" / "sync_android_usb.sh")],
        cwd=root, env=env, capture_output=True, text=True, timeout=10,
    )

    assert result.returncode == 0, result.stderr
    commands = calls.read_text().splitlines()
    assert "-d get-state" in commands
    assert "-d reverse tcp:5001 tcp:5001" in commands
    assert any("todopup://config?" in command for command in commands)
    assert any("integrations%2Fphone%2Fingest" in command or
               "integrations/phone/ingest" in command for command in commands)
    assert any("todopup://usage" in command for command in commands)
    assert any("todopup://sync" in command for command in commands)
    assert "secret-device-token" not in result.stdout
    assert not (tmp_path / 'unused-token').exists()


@pytest.mark.parametrize('valid', [True, False])
def test_usb_helper_refreshes_revoked_token_and_targets_one_device(tmp_path, valid):
    root = Path(__file__).parents[1]
    adb = tmp_path / 'adb'
    calls = tmp_path / 'calls'
    _write_success_adb(adb)
    data = integration_store._empty()
    device, old_token = integration_store.create_mobile_device(data, 'Synthetic phone')
    integration_store.set_token(data, 'phone', 'synthetic-usage')
    if not valid:
        integration_store.revoke_mobile_device(data, device['id'])
    store = tmp_path / 'integrations.json'
    integration_store.save(store, data)
    token_file = tmp_path / 'usb-token'
    token_file.write_text(old_token)
    env = dict(os.environ, ADB=str(adb), ADB_CALLS=str(calls), ANDROID_SERIAL='synthetic-phone',
               PYTHON=str(_python_adapter(tmp_path, root)), TEST_REPOSITORY=str(root),
               TODOPUP_USB_TOKEN_FILE=str(token_file), TODOPUP_INTEGRATIONS_FILE=str(store),
               TODOPUP_SKIP_SERVER_CHECK='1', TODOPUP_USAGE_SYNC_WAIT_SECONDS='0')
    result = subprocess.run(['/bin/bash', str(root / 'scripts/sync_android_usb.sh')], cwd=root,
                            env=env, capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    token = token_file.read_text().strip()
    assert (token == old_token) is valid
    assert integration_store.authenticate_mobile_device(integration_store.load(store), token) is not None
    assert all(command.startswith('-s synthetic-phone ') for command in calls.read_text().splitlines())
    assert token not in result.stdout and token not in result.stderr
    assert token_file.stat().st_mode & 0o777 == 0o600


@pytest.mark.parametrize('serial,fail_first,expected', [
    (None, True, ['synthetic-phone', 'synthetic-phone']),
    (None, False, ['synthetic-phone']),
    ('synthetic-other', False, ['synthetic-other']),
])
def test_usb_watcher_targets_physical_phone_and_retries_failed_start(tmp_path, serial, fail_first, expected):
    root = Path(__file__).parents[1]
    isolated = tmp_path / 'repo'
    scripts, binary = isolated / 'scripts', tmp_path / 'bin'
    scripts.mkdir(parents=True)
    binary.mkdir()
    (isolated / 'data').mkdir()
    shutil.copy2(root / 'scripts/watch_android_usb.sh', scripts / 'watch_android_usb.sh')
    sync = scripts / 'sync_android_usb.sh'
    sync.write_text('#!/bin/sh\nprintf "%s\\n" "${ANDROID_SERIAL:-missing}" >> "$SYNC_CALLS"\n'
                    'if [ "$FAIL_FIRST" = 1 ] && [ "$(wc -l < "$SYNC_CALLS")" -eq 1 ]; then exit 1; fi\n')
    sync.chmod(0o755)
    adb = binary / 'adb'
    adb.write_text('#!/bin/sh\nif [ "$1" = devices ]; then printf "%s\\n" "$ADB_DEVICES"; else printf "mtp,adb\\n"; fi\n')
    adb.chmod(0o755)
    sleep = binary / 'sleep'
    sleep.write_text('#!/bin/sh\nn=$(cat "$POLL_COUNT" 2>/dev/null || echo 0)\nn=$((n+1))\necho "$n" > "$POLL_COUNT"\n'
                     'if [ "$n" -ge 3 ]; then kill -TERM "$PPID"; fi\n')
    sleep.chmod(0o755)
    curl = binary / 'curl'; curl.write_text('#!/bin/sh\nexit 0\n'); curl.chmod(0o755)
    calls = tmp_path / 'sync-calls'
    env = dict(os.environ, ADB=str(adb), PATH=str(binary) + os.pathsep + os.environ['PATH'],
               SYNC_CALLS=str(calls), POLL_COUNT=str(tmp_path / 'polls'), FAIL_FIRST='1' if fail_first else '0',
               ADB_DEVICES='List of devices attached\nemulator-5554\tdevice\nsynthetic-phone\tdevice\nsynthetic-other\tdevice')
    env.pop('ANDROID_SERIAL', None)
    if serial:
        env['ANDROID_SERIAL'] = serial
    subprocess.run(['/bin/bash', str(scripts / 'watch_android_usb.sh')], cwd=isolated,
                   env=env, capture_output=True, text=True, timeout=5)
    assert calls.read_text().splitlines() == expected


@pytest.mark.parametrize('states,expected,fail_sync,failed_health', [
    (['adb', 'mtp,adb', 'adb,mtp', 'adb', 'mtp,adb'], [2, 5], False, 0),
    (['unreadable', 'mtp,adb', 'mtp,adb'], [2], False, 0),
    (['mtp,adb', 'disconnected', 'mtp,adb'], [1, 3], False, 0),
    (['notmtp,adb', 'ptp,adb', 'mtp,adb'], [3], False, 0),
    (['mtp,adb', 'unreadable', 'mtp,adb'], [1], False, 0),
    (['mtp,adb'] * 9, [1, 2, 4, 8], True, 0),
    (['mtp,adb'] * 5, [1, 3], False, 3),
])
def test_usb_watcher_waits_for_file_transfer_and_rearms_when_mode_changes(tmp_path, states, expected, fail_sync, failed_health):
    root = Path(__file__).parents[1]
    isolated, binary = tmp_path / 'repo', tmp_path / 'bin'
    scripts = isolated / 'scripts'
    scripts.mkdir(parents=True)
    binary.mkdir()
    shutil.copy2(root / 'scripts/watch_android_usb.sh', scripts / 'watch_android_usb.sh')
    sync = scripts / 'sync_android_usb.sh'
    sync.write_text('#!/bin/sh\ncat "$POLL_COUNT" >> "$SYNC_CALLS"\nexit "$SYNC_FAILURE"\n')
    sync.chmod(0o755)
    adb = binary / 'adb'
    adb.write_text('#!' + str(root / '.venv/bin/python') + '\n' + textwrap.dedent('''
        import json, os, sys
        from pathlib import Path
        path=Path(os.environ['POLL_COUNT'])
        states=json.loads(os.environ['USB_STATES'])
        poll=int(path.read_text()) if path.exists() else 0
        if sys.argv[1]=='devices':
            poll+=1; path.write_text(str(poll)+'\\n')
            print('List of devices attached')
            if states[poll-1]!='disconnected': print('synthetic-phone\\tdevice')
        elif states[poll-1]=='unreadable': sys.exit(1)
        else: print(states[poll-1])
    '''))
    adb.chmod(0o755)
    sleep = binary / 'sleep'
    sleep.write_text('#!/bin/sh\nif [ "$(cat "$POLL_COUNT")" -ge "$TOTAL_POLLS" ]; then kill -TERM "$PPID"; fi\n')
    sleep.chmod(0o755)
    curl = binary/'curl'
    curl.write_text('#!/bin/sh\ntest "$(cat "$POLL_COUNT")" != "$FAILED_HEALTH"\n')
    curl.chmod(0o755)
    calls = tmp_path / 'sync-calls'
    import json
    env = dict(os.environ, ADB=str(adb), PATH=str(binary)+os.pathsep+os.environ['PATH'],
               POLL_COUNT=str(tmp_path/'polls'), SYNC_CALLS=str(calls), USB_STATES=json.dumps(states), TOTAL_POLLS=str(len(states)),
               SYNC_FAILURE='1' if fail_sync else '0', FAILED_HEALTH=str(failed_health))
    env.pop('ANDROID_SERIAL', None)
    subprocess.run(['/bin/bash', str(scripts/'watch_android_usb.sh')], cwd=isolated, env=env,
                   capture_output=True, text=True, timeout=5)
    assert [int(value) for value in calls.read_text().splitlines()] == expected


def test_helper_does_not_replace_provider_credentials_saved_during_pairing(tmp_path, monkeypatch):
    from datapom.web import app as app_module
    root = Path(__file__).parents[1]
    adb = tmp_path / 'adb'
    _write_success_adb(adb)
    store, token_file = tmp_path / 'integrations.json', tmp_path / 'usb-token'
    integration_store.save(store, integration_store._empty())
    token_file.write_text('revoked-synthetic-token')
    ready, release = tmp_path / 'ready', tmp_path / 'release'
    env = dict(os.environ, ADB=str(adb), PYTHON=str(_python_adapter(tmp_path, root)), TEST_REPOSITORY=str(root),
               TODOPUP_USB_TOKEN_FILE=str(token_file), TODOPUP_INTEGRATIONS_FILE=str(store),
               TODOPUP_SKIP_SERVER_CHECK='1', TODOPUP_USAGE_SYNC_WAIT_SECONDS='0',
               PAUSE_READY=str(ready), PAUSE_RELEASE=str(release))
    monkeypatch.setitem(app_module.app.config, 'INTEGRATIONS_FILE', str(store))
    monkeypatch.setitem(app_module.app.config, 'TESTING', True)
    helper = subprocess.Popen(['/bin/bash', str(root / 'scripts/sync_android_usb.sh')], cwd=root,
                              env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        deadline = time.monotonic() + 5
        while not ready.exists() and helper.poll() is None and time.monotonic() < deadline:
            time.sleep(.01)
        assert ready.exists(), 'Helper did not reach the controlled pairing boundary'
        with app_module.app.test_client() as client:
            response = client.post('/integrations/google/credentials',
                data={'client_id': 'new-provider-id', 'client_secret': 'new-provider-secret'})
            assert response.status_code == 302
        release.write_text('continue')
        stdout, stderr = helper.communicate(timeout=10)
        assert helper.returncode == 0, stderr
    finally:
        release.write_text('continue')
        if helper.poll() is None:
            helper.kill()
            helper.communicate()
    saved = integration_store.load(store)
    assert saved['google']['client_id'] == 'new-provider-id'
    assert saved['google']['client_secret'] == 'new-provider-secret'
    assert integration_store.authenticate_mobile_device(saved, token_file.read_text().strip()) is not None


def test_failed_provisioning_preserves_cached_token_and_never_starts_pairing(tmp_path):
    root = Path(__file__).parents[1]
    calls, adb = tmp_path / 'calls', tmp_path / 'adb'
    _write_success_adb(adb)
    store, token_file = tmp_path / 'integrations.json', tmp_path / 'usb-token'
    integration_store.save(store, integration_store._empty())
    token_file.write_text('preserved-synthetic-token')
    before = store.read_bytes()
    env = dict(os.environ, ADB=str(adb), ADB_CALLS=str(calls), PYTHON=str(_python_adapter(tmp_path, root)),
               TEST_REPOSITORY=str(root), TEST_REMOTE_ADDR='192.0.2.1',
               TODOPUP_USB_TOKEN_FILE=str(token_file), TODOPUP_INTEGRATIONS_FILE=str(store),
               TODOPUP_SKIP_SERVER_CHECK='1', TODOPUP_USAGE_SYNC_WAIT_SECONDS='0')
    result = subprocess.run(['/bin/bash', str(root / 'scripts/sync_android_usb.sh')], cwd=root,
                            env=env, capture_output=True, text=True, timeout=5)
    assert result.returncode != 0
    assert 'Restart Datapom' in result.stderr
    assert 'preserved-synthetic-token' not in result.stderr + result.stdout
    assert token_file.read_text() == 'preserved-synthetic-token'
    assert store.read_bytes() == before
    assert calls.read_text().splitlines() == ['-d get-state']


@pytest.mark.parametrize('failure', ['offline', 'activity-error'])
def test_helper_retries_when_adb_is_unready_or_activity_start_reports_an_error(tmp_path, failure):
    root = Path(__file__).parents[1]
    adb, calls = tmp_path/'adb', tmp_path/'calls'
    adb.write_text('#!/bin/sh\necho "$*" >> "$ADB_CALLS"\n'
                  'case "$*" in\n'
                  ' *get-state) if [ "$ADB_FAILURE" = offline ]; then printf "offline\\n"; else printf "device\\n"; fi;;\n'
                  ' *"am start"*) if [ "$ADB_FAILURE" = activity-error ]; then printf "Error type 3\\nError: Activity class does not exist.\\n"; else printf "Status: ok\\n"; fi;;\n'
                  'esac\n')
    adb.chmod(0o755)
    store, token = tmp_path/'integrations.json', tmp_path/'token'
    integration_store.save(store, integration_store._empty())
    token.write_text('synthetic-cache')
    env = dict(os.environ, ADB=str(adb), ADB_CALLS=str(calls), ADB_FAILURE=failure,
               PYTHON=str(_python_adapter(tmp_path, root)), TEST_REPOSITORY=str(root),
               TODOPUP_USB_TOKEN_FILE=str(token), TODOPUP_INTEGRATIONS_FILE=str(store),
               TODOPUP_SKIP_SERVER_CHECK='1', TODOPUP_USAGE_SYNC_WAIT_SECONDS='0')
    result=subprocess.run(['/bin/bash',str(root/'scripts/sync_android_usb.sh')],cwd=root,env=env,
                          capture_output=True,text=True,timeout=10)
    assert result.returncode != 0, 'The watcher must retry an unstarted Android sync'
    assert 'todopup://sync' not in calls.read_text()
    assert 'synthetic-cache' not in result.stdout+result.stderr


@pytest.mark.parametrize('ready_after,data_exists', [(3, True), (1, False), (0, False), (99, False)])
def test_helper_starts_mac_once_and_waits_until_ready(tmp_path, ready_after, data_exists):
    root = Path(__file__).parents[1]
    isolated, binary = tmp_path/'repo', tmp_path/'bin'
    (isolated/'scripts').mkdir(parents=True)
    binary.mkdir()
    if data_exists: (isolated/'data').mkdir()
    shutil.copy2(root/'scripts/sync_android_usb.sh', isolated/'scripts/sync_android_usb.sh')
    adb = binary/'adb'; _write_success_adb(adb)
    curl = binary/'curl'
    curl.write_text('#!/bin/sh\nn=$(cat "$CURL_COUNT" 2>/dev/null || echo 0)\nn=$((n+1))\necho "$n" > "$CURL_COUNT"\n'
                    'test "$n" -gt "$READY_AFTER"\n')
    curl.chmod(0o755)
    python = binary/'python'
    python.write_text('#!/bin/sh\nif [ "$1" != -c ]; then printf "%s|%s\\n" "$PWD" "$*" >> "$SERVER_STARTS"; exit 0; fi\n'
                      'printf "%s\\n" "todopup://config?url=http%3A%2F%2F127.0.0.1%3A5001&token=synthetic" '
                      '"todopup://config?url=http%3A%2F%2F127.0.0.1%3A5001%2Fintegrations%2Fphone%2Fingest&token=synthetic"\n')
    python.chmod(0o755)
    sleep = binary/'sleep'; sleep.write_text('#!/bin/sh\nexit 0\n'); sleep.chmod(0o755)
    starts, calls = tmp_path/'starts', tmp_path/'calls'
    env = dict(os.environ, ADB=str(adb), ADB_CALLS=str(calls), PYTHON=str(python),
               PATH=str(binary)+os.pathsep+os.environ['PATH'], CURL_COUNT=str(tmp_path/'curl-count'),
               READY_AFTER=str(ready_after), SERVER_STARTS=str(starts), TODOPUP_USAGE_SYNC_WAIT_SECONDS='0')
    env.pop('TODOPUP_SKIP_SERVER_CHECK', None)
    env.pop('ANDROID_SERIAL', None)
    result=subprocess.run(['/bin/bash',str(isolated/'scripts/sync_android_usb.sh')],cwd=tmp_path,env=env,
                          capture_output=True,text=True,timeout=5)
    assert (result.returncode == 0) is (ready_after < 15), result.stderr
    assert starts.read_text().splitlines() == [f'{isolated}|-m datapom.runtime.phone_server'] if ready_after else not starts.exists()
    assert ('todopup://sync' in calls.read_text()) is (ready_after < 15)
    assert int((tmp_path/'curl-count').read_text()) <= 16
