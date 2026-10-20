"""Package boundaries and resource paths must survive moving the Python code."""
from pathlib import Path
import os
import runpy
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize('name', [
    'todo', 'journal', 'journal_commands', 'journal_media', 'map_packs', 'places',
])
def test_domain_import_does_not_load_http_layer(name):
    subprocess.run([
        sys.executable, '-c',
        'import importlib, sys; importlib.import_module(sys.argv[1]); '
        'assert "flask" not in sys.modules; assert "datapom.web.app" not in sys.modules',
        'datapom.domain.' + name,
    ], cwd=ROOT, check=True, capture_output=True, text=True)


def test_web_package_uses_existing_data_and_resources(tmp_path):
    # A fresh import verifies production defaults independently of route-test config.
    probe = '''
from pathlib import Path
import sys
from datapom.web.app import app
root = Path(sys.argv[1])
assert Path(app.root_path) == root
for key, filename in [('DATA_FILE', 'tasks.json'), ('JOURNAL_FILE', 'journal.json'),
                      ('INTEGRATIONS_FILE', 'integrations.json')]:
    assert Path(app.config[key]) == root / 'data' / filename
    app.config[key] = str(Path.cwd() / filename)
app.config['TESTING'] = True
with app.test_client() as client:
    for url in ['/', '/journal', '/journal/search', '/journal/sections',
                '/journal/analytics', '/journal/media/settings']:
        response = client.get(url)
        assert response.status_code == 200, url
        assert b'<title>Datapom</title>' in response.data
    assert client.get('/static/style.css').data == (root / 'static/style.css').read_bytes()
    assert client.get('/journal/media/discord/setup.md').data == (root / 'docs/DISCORD_INBOX.md').read_bytes()
'''
    env = {key: value for key, value in os.environ.items() if key != 'AUTO_QUIT'}
    subprocess.run([sys.executable, '-c', probe, str(ROOT)], cwd=tmp_path,
                   check=True, capture_output=True, text=True,
                   env={**env, 'PYTHONPATH': str(ROOT)})


def test_flask_cli_finds_packaged_routes():
    result = subprocess.run([
        sys.executable, '-m', 'flask', '--app', 'datapom.web.app', 'routes',
    ], cwd=ROOT, check=True, capture_output=True, text=True,
       env={key: value for key, value in os.environ.items() if key != 'AUTO_QUIT'})
    assert '/journal/<date>/autosave' in result.stdout
    assert '/api/mobile/tasks' in result.stdout


def test_daemon_resolves_environment_and_logs_from_repository(monkeypatch):
    calls = {}
    monkeypatch.setattr(os, 'fork', lambda: 0)
    monkeypatch.setattr(os, 'setsid', lambda: None)
    monkeypatch.setattr(os, 'chdir', lambda path: calls.update(cwd=path))
    monkeypatch.setattr(os, 'open', lambda path, *args: calls.setdefault('opened', []).append(path) or 9)
    monkeypatch.setattr(os, 'dup2', lambda *args: None)
    monkeypatch.setattr(os, 'close', lambda *args: None)
    monkeypatch.setattr(os, 'execv', lambda path, argv: calls.update(executable=path, argv=argv))
    monkeypatch.setenv('AUTO_QUIT', '')

    runpy.run_module('datapom.runtime.start_server', run_name='__main__')

    assert calls['cwd'] == str(ROOT)
    assert calls['opened'] == [os.devnull, str(ROOT / 'data/server.log')]
    python = str(ROOT / '.venv/bin/python')
    assert calls['executable'] == python
    assert calls['argv'] == [python, '-m', 'flask', '--app', 'datapom.web.app', 'run', '--port', '5001']
