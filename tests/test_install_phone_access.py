from pathlib import Path


def test_installer_removes_empty_mktemp_file_before_plistbuddy():
    script = (Path(__file__).parents[1] / "scripts" /
              "install_phone_access.sh").read_text()

    created = script.index('TMP="$(mktemp)"')
    removed = script.index('\nrm -f "$TMP"\n', created)
    first_plistbuddy = script.index("/usr/libexec/PlistBuddy", created)

    assert created < removed < first_plistbuddy
