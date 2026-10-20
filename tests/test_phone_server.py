"""Persistent server configuration, without starting a server or loading user data."""

import runpy
import sys
from types import SimpleNamespace

import pytest


@pytest.mark.parametrize('current,legacy,expected', [
    (None, None, '127.0.0.1:5001'),
    ('127.0.0.1:5002', None, '127.0.0.1:5002'),
    (None, '127.0.0.1:5003', '127.0.0.1:5003'),
    ('127.0.0.1:5002', '127.0.0.1:5003', '127.0.0.1:5002'),
])
def test_listen_setting_supports_datapom_and_legacy_name(monkeypatch, current, legacy, expected):
    for key, value in [('DATAPOM_LISTEN', current), ('TODOPUP_LISTEN', legacy)]:
        monkeypatch.delenv(key, raising=False)
        if value is not None:
            monkeypatch.setenv(key, value)
    monkeypatch.setenv('AUTO_QUIT', '1')
    application, calls = object(), []
    monkeypatch.setitem(sys.modules, 'datapom.web.app', SimpleNamespace(app=application))
    monkeypatch.setitem(sys.modules, 'waitress', SimpleNamespace(
        serve=lambda app, **kwargs: calls.append((app, kwargs))))

    runpy.run_module('datapom.runtime.phone_server', run_name='__main__')

    assert calls == [(application, {
        'listen': expected, 'threads': 4, 'clear_untrusted_proxy_headers': True,
    })]
