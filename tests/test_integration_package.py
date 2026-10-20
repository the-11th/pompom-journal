"""Package imports and the deployed receiver work in fresh Python processes."""
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("name", [
    "oauth", "google_health", "rescuetime", "spotify", "health", "usage",
    "store", "music_history", "provider_sync", "discord_journal", "discord_setup",
])
def test_domain_module_imports_without_loading_http_layer(name):
    subprocess.run([
        sys.executable, "-c",
        "import importlib, sys; importlib.import_module(sys.argv[1]); "
        "assert 'flask' not in sys.modules; assert 'datapom.web.app' not in sys.modules",
        "datapom.integrations." + name,
    ], cwd=ROOT, check=True, capture_output=True, text=True)


def test_receiver_starts_with_only_the_dockerfile_sources(tmp_path):
    dockerfile = (ROOT / "deploy/discord-inbox/Dockerfile").read_text()
    for line in dockerfile.splitlines():
        if line.startswith("COPY "):
            *sources, destination = shlex.split(line)[1:]
            target = tmp_path / destination
            target.mkdir(parents=True, exist_ok=True)
            for source in sources:
                path = ROOT / source
                if path.is_dir():
                    shutil.copytree(path, target, dirs_exist_ok=True,
                                    ignore=shutil.ignore_patterns("__pycache__"))
                else:
                    shutil.copy2(path, target / path.name)
        elif line.startswith("CMD "):
            command = json.loads(line[4:])

    # Exercise the actual entry point without opening a network listener.
    probe = """
import runpy, sys
from unittest.mock import patch
calls = []
def serve(app, **options):
    calls.append(app)
    assert options == {'host': '0.0.0.0', 'port': 8080, 'threads': 4}
    assert app.test_client().get('/inbox').status_code == 401
with patch('waitress.serve', serve):
    if sys.argv[1] == '-m':
        runpy.run_module(sys.argv[2], run_name='__main__')
    else:
        runpy.run_path(sys.argv[1], run_name='__main__')
assert len(calls) == 1
"""
    subprocess.run([sys.executable, "-c", probe, *command[1:]],
                   cwd=tmp_path, check=True, capture_output=True, text=True,
                   env={**os.environ, "PYTHONPATH": "",
                        "DISCORD_PUBLIC_KEY": "ab" * 32, "DISCORD_USER_ID": "42",
                        "DATAPOM_INBOX_TOKEN": "synthetic-inbox-token-" + "x" * 32,
                        "DATAPOM_INBOX_DATA": str(tmp_path / "data"), "PORT": "8080"})
