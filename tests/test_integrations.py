# tests/test_integrations.py
import json
import integrations as I


def test_empty_has_three_providers():
    d = I._empty()
    assert set(d) == {"fitbit", "rescuetime", "spotify"}
    assert d["fitbit"] == {}


def test_load_missing_file_returns_empty(tmp_path):
    d = I.load(str(tmp_path / "nope.json"))
    assert d == I._empty()


def test_save_then_load_roundtrip(tmp_path):
    p = str(tmp_path / "i.json")
    d = I._empty()
    I.set_credentials(d, "fitbit", "CID", "SECRET")
    I.save(p, d)
    assert I.load(p)["fitbit"]["client_id"] == "CID"


def test_corrupt_file_backed_up(tmp_path):
    p = tmp_path / "i.json"
    p.write_text("{not json")
    d = I.load(str(p))
    assert d == I._empty()
    assert (tmp_path / "i.json.bak").exists()


def test_set_tokens_and_is_connected(tmp_path):
    d = I._empty()
    assert I.is_connected(d, "fitbit") is False
    I.set_tokens(d, "fitbit", {"access_token": "A", "refresh_token": "R"})
    assert I.is_connected(d, "fitbit") is True


def test_clear_provider_keeps_key(tmp_path):
    d = I._empty()
    I.set_tokens(d, "fitbit", {"access_token": "A", "refresh_token": "R"})
    I.clear_provider(d, "fitbit")
    assert I.is_connected(d, "fitbit") is False
    assert "fitbit" in d


def test_last_sync_roundtrip():
    d = I._empty()
    assert I.last_sync(d, "fitbit") is None
    I.set_last_sync(d, "fitbit", "2026-06-29T08:00:00")
    assert I.last_sync(d, "fitbit") == "2026-06-29T08:00:00"


def test_clear_provider_removes_oauth_state():
    """clear_provider must pop oauth_state so no ghost CSRF token remains."""
    d = I._empty()
    p = I.get_provider(d, "fitbit")
    p["oauth_state"] = "some-csrf-token"
    I.set_tokens(d, "fitbit", {"access_token": "A", "refresh_token": "R"})
    I.clear_provider(d, "fitbit")
    assert "oauth_state" not in d["fitbit"]
    assert I.is_connected(d, "fitbit") is False


def test_set_api_key_and_is_connected():
    d = I._empty()
    assert I.is_connected(d, "rescuetime") is False
    I.set_api_key(d, "rescuetime", "KEY123")
    assert I.get_provider(d, "rescuetime")["api_key"] == "KEY123"
    assert I.is_connected(d, "rescuetime") is True


def test_clear_provider_removes_key():
    d = I._empty()
    I.set_api_key(d, "rescuetime", "KEY123")
    I.clear_provider(d, "rescuetime")
    assert I.is_connected(d, "rescuetime") is False
    assert "api_key" not in I.get_provider(d, "rescuetime")
