"""USB helper credentials are provisioned within the server transaction."""
from copy import deepcopy
from datetime import datetime
from threading import Event, Thread

import pytest

from datapom.web import app as app_module
from datapom.integrations import store as integrations

NOW = datetime(2026, 9, 10, 12)


def test_provisioning_reuses_current_credentials_without_mutating_store():
    data = integrations._empty()
    _, token = integrations.create_mobile_device(data, 'Synthetic phone', now=NOW)
    integrations.set_token(data, 'phone', 'synthetic-usage')
    before = deepcopy(data)
    result = integrations.provision_usb(data, token, now=NOW)
    assert result == {'token': token, 'usage_token': 'synthetic-usage'}
    assert data == before


def test_provisioning_replaces_revoked_mobile_token_and_retains_other_connections():
    data = integrations._empty()
    integrations.set_credentials(data, 'google', 'keep-id', 'keep-secret')
    result = integrations.provision_usb(data, 'revoked-token', now=NOW)
    assert result['token'] != 'revoked-token'
    assert integrations.authenticate_mobile_device(data, result['token'], now=NOW)
    assert integrations.get_token(data, 'phone') == result['usage_token']
    assert data['google']['client_id'] == 'keep-id'


@pytest.mark.parametrize('payload,remote,origin,status', [
    ({'token': ''}, '127.0.0.1', None, 200),
    ({'token': ''}, '::1', None, 200),
    ({'token': ''}, '192.0.2.1', None, 403),
    ({'token': ''}, '127.0.0.1', 'https://untrusted.example', 403),
    ({'token': ''}, '127.0.0.1', 'null', 403),
    ({'token': []}, '127.0.0.1', None, 400),
    (['not an object'], '127.0.0.1', None, 400),
])
def test_provisioning_route_requires_local_json_and_preserves_failed_requests(tmp_path, monkeypatch, payload, remote, origin, status):
    path = tmp_path / 'integrations.json'
    integrations.save(path, integrations._empty())
    before = path.read_bytes()
    monkeypatch.setitem(app_module.app.config, 'INTEGRATIONS_FILE', str(path))
    headers = {'Origin': origin} if origin is not None else {}
    with app_module.app.test_client() as client:
        result = client.post('/integrations/mobile/usb', json=payload, headers=headers,
                             environ_overrides={'REMOTE_ADDR': remote})
    assert result.status_code == status
    if status != 200:
        assert path.read_bytes() == before
    else:
        assert result.json['ok'] is True
        assert result.json['token'] and result.json['usage_token']
        assert result.headers['Cache-Control'] == 'no-store'


@pytest.mark.parametrize('remote,headers', [
    ('192.0.2.1', {'X-Forwarded-For': '127.0.0.1'}),
    ('::ffff:127.0.0.1', {}),
    ('127.0.0.1', {'Sec-Fetch-Site': 'cross-site'}),
    ('127.0.0.1', {'Sec-Fetch-Site': 'same-site'}),
])
def test_provisioning_rejects_forwarded_or_browser_cross_site_requests(tmp_path, monkeypatch, remote, headers):
    path = tmp_path / 'integrations.json'
    integrations.save(path, integrations._empty())
    before = path.read_bytes()
    monkeypatch.setitem(app_module.app.config, 'INTEGRATIONS_FILE', str(path))
    with app_module.app.test_client() as client:
        result = client.post('/integrations/mobile/usb', json={}, headers=headers,
                             environ_overrides={'REMOTE_ADDR': remote})
    assert result.status_code == 403
    assert result.headers['Cache-Control'] == 'no-store'
    assert path.read_bytes() == before


def test_provisioning_rejects_form_posts_without_writing(tmp_path, monkeypatch):
    path = tmp_path / 'integrations.json'
    integrations.save(path, integrations._empty())
    before = path.read_bytes()
    monkeypatch.setitem(app_module.app.config, 'INTEGRATIONS_FILE', str(path))
    with app_module.app.test_client() as client:
        result = client.post('/integrations/mobile/usb', data={'token': ''})
    assert result.status_code == 400
    assert path.read_bytes() == before


def test_provisioning_and_provider_save_share_one_transaction(tmp_path, monkeypatch):
    path = tmp_path / 'integrations.json'
    integrations.save(path, integrations._empty())
    monkeypatch.setitem(app_module.app.config, 'INTEGRATIONS_FILE', str(path))
    entered, release, saving = Event(), Event(), Event()
    original = integrations.provision_usb
    responses = {}

    def paused(data, cached_token, now=None):
        entered.set()
        assert release.wait(3)
        return original(data, cached_token, now)

    def provision():
        with app_module.app.test_client() as client:
            responses['usb'] = client.post('/integrations/mobile/usb', json={})

    def save_provider():
        saving.set()
        with app_module.app.test_client() as client:
            responses['provider'] = client.post('/integrations/google/credentials',
                data={'client_id': 'concurrent-id', 'client_secret': 'concurrent-secret'})

    monkeypatch.setattr(integrations, 'provision_usb', paused)
    usb_thread = Thread(target=provision)
    provider_thread = Thread(target=save_provider)
    usb_thread.start()
    try:
        assert entered.wait(2)
        provider_thread.start()
        assert saving.wait(2)
    finally:
        release.set()
        usb_thread.join(3)
        if provider_thread.ident is not None:
            provider_thread.join(3)
    assert responses['usb'].status_code == 200
    assert responses['provider'].status_code == 302
    saved = integrations.load(path)
    assert saved['google']['client_id'] == 'concurrent-id'
    assert saved['google']['client_secret'] == 'concurrent-secret'
    assert integrations.authenticate_mobile_device(saved, responses['usb'].json['token'])
    assert saved['phone']['token'] == responses['usb'].json['usage_token']
