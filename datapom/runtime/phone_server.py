#!/usr/bin/env python3
"""Run Datapom's persistent, localhost-only USB phone-sync server.

The WSGI server stays on loopback and the attached phone reaches it only through
an ADB reverse tunnel; no LAN-visible port is needed.
"""

import os

# app.py starts its close-the-last-tab watchdog while it is imported. Persistent
# phone mode must disable that before importing the application object.
os.environ.pop("AUTO_QUIT", None)

from waitress import serve  # noqa: E402

from datapom.web.app import app  # noqa: E402


if __name__ == "__main__":
    serve(
        app,
        listen=os.environ.get("DATAPOM_LISTEN", os.environ.get("TODOPUP_LISTEN", "127.0.0.1:5001")),
        threads=4,
        clear_untrusted_proxy_headers=True,
    )
