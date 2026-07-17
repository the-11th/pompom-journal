#!/usr/bin/env python3
"""Run TodoPup's persistent, localhost-only phone-sync server.

Tailscale Serve terminates private HTTPS and proxies to this listener. Keeping
the WSGI server on loopback is intentional: neither the Flask development
server nor a LAN-visible port is needed for phone access.
"""

import os

# app.py starts its close-the-last-tab watchdog while it is imported. Persistent
# phone mode must disable that before importing the application object.
os.environ.pop("AUTO_QUIT", None)

from waitress import serve  # noqa: E402

from app import app  # noqa: E402


if __name__ == "__main__":
    serve(
        app,
        listen=os.environ.get("TODOPUP_LISTEN", "127.0.0.1:5001"),
        threads=4,
        clear_untrusted_proxy_headers=True,
    )
