# Setup

## Running the app

Double-click **Datapom** in your dock. It opens the browser, and the server
auto-quits ~30 seconds after you close the last tab.

To run manually from a terminal:

```bash
source .venv/bin/activate
flask --app app run --port 5001
```

---

## First-time machine setup

### 1. Clone the repo

```bash
git clone https://github.com/the-11th/pompom-journal.git ~/projects/todo-journal
cd ~/projects/todo-journal
```

### 2. Create the virtual environment

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 3. Install the Datapom dock app (Automator)

The Automator app lives at `/Applications/Datapom.app`. The workflow file is
stored in this repo at `docs/automator/document.wflow`.

**Option A — Install from the repo (quickest):**

Run this once; it updates the existing launcher to **Datapom**, preserving its
custom icon and Dock bookmark, or creates a new bundle on a fresh machine:

```bash
bash docs/automator/install.sh
```

If a pinned Dock shortcut still shows the previous name after the rename, refresh
that shortcut in its existing position:

```bash
.venv/bin/python docs/automator/rename_dock.py
```

**Option B — Manual (Automator UI):**

1. Open **Automator** → **New Document** → choose **Application**
2. In the action library search for **Run Shell Script** and drag it in
3. Set Shell to `/bin/bash`, pass input to `stdin`
4. Paste the script below into the action, replacing any existing content:

```bash
cd /Users/<your-username>/projects/todo-journal
exec /bin/bash Datapom.command
```

5. **File → Save** → save as **Datapom** to `/Applications/`
6. Open **System Settings → Dock** (or drag the app) to add it to your dock

---

## Updating the dock app after script changes

If the shell script inside the Automator app needs to change, update
`docs/automator/document.wflow` in the repo and re-run the install script:

```bash
bash docs/automator/install.sh
```

Or open `/Applications/Datapom.app` in Automator, edit the script, and save.
Then commit the updated `docs/automator/document.wflow`:

```bash
cp /Applications/Datapom.app/Contents/document.wflow docs/automator/document.wflow
git add docs/automator/document.wflow
git commit -m "Update Automator workflow script"
```

---

## How auto-quit works

- Every open browser tab pings `/heartbeat` every 10 seconds
- The Flask server has a watchdog thread (active when started via the dock app)
- If no heartbeat arrives for 30 seconds, the server shuts itself down cleanly
- Server logs are written to `data/server.log`

For Android journal/task sync, use the USB helper documented in
[`docs/PHONE_ACCESS.md`](docs/PHONE_ACCESS.md). It starts the localhost-only
server when needed; the dock app reuses a healthy server without stopping it.
