import hashlib
import io
import zipfile
import pytest
from scripts import install_map_tools


def archive():
    value = io.BytesIO()
    with zipfile.ZipFile(value, "w") as z:
        z.writestr("pmtiles", b"official-tool")
    return value.getvalue()


def test_installer_uses_real_darwin_release_name_and_verified_digest(tmp_path, monkeypatch):
    body = archive()
    requests = []
    def download(url, timeout):
        requests.append(url)
        return io.BytesIO(body)
    monkeypatch.setattr(install_map_tools.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(install_map_tools.platform, "machine", lambda: "arm64")
    monkeypatch.setattr(install_map_tools.urllib.request, "urlopen", download)
    monkeypatch.setitem(install_map_tools.DIGESTS, "arm64", hashlib.sha256(body).hexdigest())
    install_map_tools.install(tmp_path)
    assert requests == ["https://github.com/protomaps/go-pmtiles/releases/download/v1.31.2/go-pmtiles-1.31.2_Darwin_arm64.zip"]
    assert (tmp_path / "tools" / "pmtiles").read_bytes() == b"official-tool"
    assert (tmp_path / "tools" / "pmtiles").stat().st_mode & 0o100


def test_failed_verification_preserves_existing_downloader(tmp_path, monkeypatch):
    target = tmp_path / "tools" / "pmtiles"
    target.parent.mkdir()
    target.write_bytes(b"working-tool")
    monkeypatch.setattr(install_map_tools.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(install_map_tools.platform, "machine", lambda: "arm64")
    monkeypatch.setattr(install_map_tools.urllib.request, "urlopen", lambda *a, **k: io.BytesIO(archive()))
    with pytest.raises(SystemExit, match="checksum"):
        install_map_tools.install(tmp_path)
    assert target.read_bytes() == b"working-tool"
