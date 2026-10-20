#!/usr/bin/env python3
"""Launch the Flask dev server as a fully detached daemon.

Uses the UNIX double-fork technique so the calling process (e.g. a macOS
Shortcut) exits the instant the first fork returns — no file-descriptor
inheritance, no job-table tracking, no waiting.
"""
import os
import sys
from datapom.paths import ROOT

APP_DIR = str(ROOT)
LOG_FILE = os.path.join(APP_DIR, "data", "server.log")
PYTHON   = os.path.join(APP_DIR, ".venv", "bin", "python")
PORT     = "5001"

# ── First fork ────────────────────────────────────────────────────────────────
# Parent exits immediately → the calling shell (and macOS Shortcuts) is done.
pid = os.fork()
if pid > 0:
    sys.exit(0)

# ── Child: become a new session leader ────────────────────────────────────────
os.setsid()

# ── Second fork ───────────────────────────────────────────────────────────────
# Grandchild can never re-acquire a controlling terminal (it's not a session
# leader). This is the process that will actually run Flask.
pid = os.fork()
if pid > 0:
    sys.exit(0)

# ── Grandchild is a true daemon ───────────────────────────────────────────────
os.chdir(APP_DIR)

# Redirect all stdio so no inherited pipes keep the caller's Shortcut action
# open or cause console noise.
devnull = os.open(os.devnull, os.O_RDONLY)
logfd   = os.open(LOG_FILE, os.O_WRONLY | os.O_CREAT | os.O_APPEND)
os.dup2(devnull, 0)   # stdin  → /dev/null
os.dup2(logfd,   1)   # stdout → server.log
os.dup2(logfd,   2)   # stderr → server.log
os.close(devnull)
os.close(logfd)

os.environ["AUTO_QUIT"] = "1"
os.execv(PYTHON, [PYTHON, "-m", "flask", "--app", "datapom.web.app", "run", "--port", PORT])
