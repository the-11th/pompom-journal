"""Third-party integration credential/token store. Zero Flask imports.

Same forgiving-load / atomic-save pattern as journal.py and todo.py. Each
top-level key is a provider; values hold credentials + OAuth tokens + sync
bookkeeping. Shaped so rescuetime/spotify slot in with no schema change.
"""
import json
import os
import tempfile

_PROVIDERS = ("fitbit", "rescuetime", "spotify")


def _empty():
    return {name: {} for name in _PROVIDERS}


def load(path):
    """Read the store. Missing file -> empty. Corrupt -> backed up to .bak +
    empty. Missing provider keys defaulted."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            parsed = json.load(f)
    except FileNotFoundError:
        return _empty()
    except json.JSONDecodeError:
        try:
            os.replace(path, path + ".bak")
        except OSError:
            pass
        return _empty()
    if not isinstance(parsed, dict):
        try:
            os.replace(path, path + ".bak")
        except OSError:
            pass
        return _empty()
    for name in _PROVIDERS:
        if not isinstance(parsed.get(name), dict):
            parsed[name] = {}
    return parsed


def save(path, data):
    """Atomic write (temp file + os.replace)."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def get_provider(data, name):
    return data.setdefault(name, {})


def set_credentials(data, name, client_id, client_secret):
    p = get_provider(data, name)
    p["client_id"] = client_id
    p["client_secret"] = client_secret
    return data


def set_tokens(data, name, tokens):
    get_provider(data, name)["tokens"] = tokens
    return data


def clear_provider(data, name):
    p = get_provider(data, name)
    p.pop("tokens", None)
    p.pop("last_sync", None)
    return data


def is_connected(data, name):
    tokens = get_provider(data, name).get("tokens")
    return bool(tokens and tokens.get("access_token"))


def last_sync(data, name):
    return get_provider(data, name).get("last_sync")


def set_last_sync(data, name, when):
    get_provider(data, name)["last_sync"] = when
    return data
