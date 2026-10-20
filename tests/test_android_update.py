from pathlib import Path
import os
import subprocess
import tarfile
import shutil
import pytest


def _fake_adb(tmp_path, replace_succeeds):
    adb = tmp_path / "adb"
    adb.write_text(
        "#!/bin/sh\n"
        "echo \"$*\" >> \"$ADB_CALLS\"\n"
        "if [ \"$1 $2 $3\" = \"shell pm path\" ]; then echo package:/data/app/base.apk; fi\n"
        "if [ \"$1 $2 $4\" = \"exec-out run-as tar\" ]; then cat \"$ADB_BACKUP\"; fi\n"
        "if [ \"$1 $2 $4\" = \"exec-out run-as cat\" ]; then cat \"$ADB_SOURCE/$5\"; fi\n"
        "if [ \"$1 $2\" = \"install -r\" ] && [ \"$REPLACE_SUCCEEDS\" != 1 ]; then echo \"$INSTALL_FAILURE\" >&2; exit 1; fi\n"
        "exit 0\n"
    )
    adb.chmod(0o755)
    return adb


def _run(tmp_path, replace_succeeds, failure="Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package com.todopup.usage signatures do not match newer version; ignoring!]", extra_file=None):
    root = Path(__file__).parents[1]
    isolated = tmp_path / 'repo'
    (isolated / 'scripts').mkdir(parents=True)
    shutil.copy2(root / 'scripts' / 'push_android_update.sh', isolated / 'scripts' / 'push_android_update.sh')
    apk = tmp_path / "update.apk"
    apk.write_bytes(b"apk")
    source = tmp_path / "source"
    prefs = source / "shared_prefs"
    prefs.mkdir(parents=True)
    for name in ("todopup_journal_outbox.xml", "todopup_mobile_ui.xml",
                 "todopup_task_outbox.xml", "todopup_usage.xml"):
        (prefs / name).write_text(f"<map><string name=\"value\">{name}</string></map>")
    backup = tmp_path / "backup.tar"
    with tarfile.open(backup, "w") as archive:
        archive.add(prefs, arcname="shared_prefs")
        if extra_file:
            extra = source / extra_file
            extra.parent.mkdir(parents=True, exist_ok=True)
            extra.write_text('preserve this local file')
            archive.add(extra, arcname=extra_file)
    calls = tmp_path / "calls"
    env = os.environ.copy()
    env.update({
        "ADB": str(_fake_adb(tmp_path, replace_succeeds)),
        "ADB_CALLS": str(calls),
        "ADB_BACKUP": str(backup),
        "ADB_SOURCE": str(source),
        "REPLACE_SUCCEEDS": "1" if replace_succeeds else "0",
        "INSTALL_FAILURE": failure,
    })
    result = subprocess.run(
        ["/bin/bash", str(isolated / "scripts" / "push_android_update.sh"), str(apk)],
        cwd=root, env=env, capture_output=True, text=True, timeout=10,
    )
    return result, calls.read_text().splitlines()


def test_android_update_uses_in_place_install_when_signature_matches(tmp_path):
    result, calls = _run(tmp_path, replace_succeeds=True)

    assert result.returncode == 0, result.stderr
    assert any(call.startswith("exec-out run-as com.todopup.usage") for call in calls)
    assert any(call.startswith("install -r ") for call in calls)
    assert not any(call == "uninstall com.todopup.usage" for call in calls)


def test_android_update_restores_entries_after_one_time_signature_migration(tmp_path):
    result, calls = _run(tmp_path, replace_succeeds=False)

    assert result.returncode == 0, result.stderr
    assert "preserved" in result.stdout.lower()
    assert "uninstall com.todopup.usage" in calls
    assert any(call.startswith("install ") and not call.startswith("install -r") for call in calls)
    assert any(call.startswith("push ") for call in calls)
    assert any(call.startswith("shell run-as com.todopup.usage cp ") for call in calls)
    assert not any("tar -xf" in call for call in calls)


def test_android_update_backs_up_media_and_tracking_files(tmp_path):
    result, calls = _run(tmp_path, replace_succeeds=True)
    assert result.returncode == 0
    assert any('tar -cf - shared_prefs files' in call for call in calls)


@pytest.mark.parametrize('failure', ['INSTALL_FAILED_INSUFFICIENT_STORAGE',
    'INSTALL_FAILED_VERSION_DOWNGRADE', 'device offline', 'INSTALL_FAILED_INVALID_APK',
    'INSTALL_FAILED_UPDATE_INCOMPATIBLE',
    'adb: failed to install /tmp/INSTALL_FAILED_UPDATE_INCOMPATIBLE com.todopup.usage update.apk: Failure [INSTALL_FAILED_INVALID_APK: parse error]',
    'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package com.todopup.usage.qa signatures do not match newer version; ignoring!]'])
def test_unrelated_install_failure_never_uninstalls_the_saved_app(tmp_path, failure):
    result, calls = _run(tmp_path, replace_succeeds=False, failure=failure)
    assert result.returncode != 0
    assert 'uninstall com.todopup.usage' not in calls
    assert not any(call.startswith('install ') and not call.startswith('install -r ') for call in calls)
    assert 'preserved' not in result.stdout.lower()


@pytest.mark.parametrize('filename', ['files/photo:original.jpg', 'app_webview/Local Storage/a\nb.log'])
def test_unrecoverable_filename_stops_migration_before_uninstall(tmp_path, filename):
    result, calls = _run(tmp_path, replace_succeeds=False, extra_file=filename)
    assert result.returncode != 0
    assert 'uninstall com.todopup.usage' not in calls
    assert not any(call.startswith('install ') and not call.startswith('install -r ') for call in calls)
