from pathlib import Path
import os
import subprocess
import plistlib
import pytest
import importlib.util


@pytest.mark.parametrize('name', ['Datapom.command', 'TodoPup.command'])
def test_dock_launcher_reuses_healthy_persistent_server(tmp_path, name):
    root = Path(__file__).parents[1]
    for source in ['Datapom.command', 'TodoPup.command']:
        target = tmp_path / source
        target.write_text((root / source).read_text())
        target.chmod(0o755)
    launcher = tmp_path / name
    (tmp_path / ".venv" / "bin").mkdir(parents=True)

    calls = tmp_path / "calls"
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    for name, exit_code in (("curl", 0), ("open", 0), ("lsof", 0)):
        command = fake_bin / name
        command.write_text(
            "#!/bin/sh\n"
            f"echo {name} >> \"$CALLS\"\n"
            f"exit {exit_code}\n"
        )
        command.chmod(0o755)

    env = os.environ.copy()
    env["CALLS"] = str(calls)
    env["PATH"] = f"{fake_bin}:/usr/bin:/bin"
    result = subprocess.run(
        ["/bin/bash", str(launcher)],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=5,
    )

    assert result.returncode == 0
    assert calls.read_text().splitlines() == ["curl", "open"]


def test_datapom_installer_migrates_bundle_without_losing_custom_resources(tmp_path):
    root = Path(__file__).parents[1]
    apps = tmp_path / 'Applications'; old = apps / 'TodoPom.app'
    resources = old / 'Contents' / 'Resources'; resources.mkdir(parents=True)
    (resources / 'TodoPom.icns').write_bytes(b'custom icon')
    (resources / 'custom-note.txt').write_text('keep me')
    (old / 'Contents' / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleIconFile': 'TodoPom.icns'}))
    original_inode = old.stat().st_ino
    stub = tmp_path / 'Stub.app'; (stub / 'Contents' / 'MacOS').mkdir(parents=True)
    (stub / 'Contents' / 'MacOS' / 'Automator Application Stub').write_text('stub')
    (stub / 'Contents' / 'PkgInfo').write_text('APPL????')
    fake_bin = tmp_path / 'bin'; fake_bin.mkdir()
    for name in ['codesign', 'plutil']:
        script = fake_bin / name; script.write_text('#!/bin/sh\nexit 0\n'); script.chmod(0o755)
    env = {**os.environ, 'DATAPOM_APPLICATIONS_DIR': str(apps),
           'DATAPOM_AUTOMATOR_STUB': str(stub), 'PATH': f'{fake_bin}:/usr/bin:/bin:/usr/sbin:/sbin'}
    result = subprocess.run(['/bin/bash', str(root / 'docs/automator/install.sh')], env=env,
                            capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    renamed = apps / 'Datapom.app'
    assert not old.exists()
    assert renamed.stat().st_ino == original_inode
    assert (renamed / 'Contents/Resources/Datapom.icns').read_bytes() == b'custom icon'
    assert (renamed / 'Contents/Resources/custom-note.txt').read_text() == 'keep me'
    info = plistlib.loads((renamed / 'Contents/Info.plist').read_bytes())
    assert info['CFBundleName'] == info['CFBundleDisplayName'] == 'Datapom'
    assert info['CFBundleIdentifier'] == 'com.apple.automator.TodoPom'


def test_dock_rename_changes_only_matching_tile_and_keeps_its_position():
    root = Path(__file__).parents[1]
    spec = importlib.util.spec_from_file_location('rename_dock', root / 'docs/automator/rename_dock.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    other = {'GUID': 1, 'tile-data': {'file-label': 'Other', 'file-data': {'_CFURLString': 'file:///Applications/Other.app/'}}}
    old = {'GUID': 2, 'tile-data': {'file-label': 'TodoPom', 'book': b'old bookmark',
        'custom': 'keep', 'bundle-identifier': 'com.apple.automator.TodoPom',
        'file-data': {'_CFURLStringType': 15, '_CFURLString': 'file:///Applications/TodoPom.app/'}}}
    result = module.renamed_tiles([other, old])
    assert result[0] == other
    assert result[1]['GUID'] == 2
    tile = result[1]['tile-data']
    assert tile['file-label'] == 'Datapom'
    assert tile['file-data']['_CFURLString'] == 'file:///Applications/Datapom.app/'
    assert tile['custom'] == 'keep'
    assert tile['bundle-identifier'] == 'com.apple.automator.TodoPom'
    assert 'book' not in tile
    assert old['tile-data']['file-label'] == 'TodoPom'
    assert module.renamed_tiles(result) == result
