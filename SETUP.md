# Setup

## Running the app

Double-click **TodoPom** in your dock. It opens the browser, and the server
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

### 3. Install the TodoPup dock app (Automator)

The Automator app lives at `/Applications/TodoPom.app`. The workflow file is
stored in this repo at `docs/automator/document.wflow`.

**Option A — Install from the repo (quickest):**

Run this once; it copies the workflow into a fresh Automator app bundle:

```bash
bash docs/automator/install.sh
```

**Option B — Manual (Automator UI):**

1. Open **Automator** → **New Document** → choose **Application**
2. In the action library search for **Run Shell Script** and drag it in
3. Set Shell to `/bin/bash`, pass input to `stdin`
4. Paste the script below into the action, replacing any existing content:

```bash
cd /Users/<your-username>/projects/todo-journal

PORT=5001
URL="http://127.0.0.1:${PORT}"

EXISTING=$(lsof -ti "tcp:${PORT}" 2>/dev/null)
if [ -n "$EXISTING" ]; then
  kill $EXISTING 2>/dev/null
  sleep 1
  STILL=$(lsof -ti "tcp:${PORT}" 2>/dev/null)
  [ -n "$STILL" ] && kill -9 $STILL 2>/dev/null
fi

.venv/bin/python start_server.py

for i in $(seq 1 20); do
  sleep 0.5
  curl -s --max-time 1 "$URL" -o /dev/null && break
done
open "$URL"
```

5. **File → Save** → save as **TodoPom** to `/Applications/`
6. Open **System Settings → Dock** (or drag the app) to add it to your dock

---

## Updating the dock app after script changes

If the shell script inside the Automator app needs to change, update
`docs/automator/document.wflow` in the repo and re-run the install script:

```bash
bash docs/automator/install.sh
```

Or open `/Applications/TodoPom.app` in Automator, edit the script, and save.
Then commit the updated `docs/automator/document.wflow`:

```bash
cp /Applications/TodoPom.app/Contents/document.wflow docs/automator/document.wflow
git add docs/automator/document.wflow
git commit -m "Update Automator workflow script"
```

---

## How auto-quit works

- Every open browser tab pings `/heartbeat` every 10 seconds
- The Flask server has a watchdog thread (active when started via the dock app)
- If no heartbeat arrives for 30 seconds, the server shuts itself down cleanly
- Server logs are written to `data/server.log`

For Android journal/task sync, use the optional persistent server instead of
auto-quit dock mode. The Tailscale Serve, LaunchAgent, pairing, and disable steps
are documented in [`docs/PHONE_ACCESS.md`](docs/PHONE_ACCESS.md).
