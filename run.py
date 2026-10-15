"""Work Tracker with the Workflow module.

Run:  python run.py   (instead of Tracker/app.py) then open http://localhost:47474

The tracker is loaded as it is, nothing in its folder is changed; this module adds its board on
the same server and port.
"""
import os
import sys
import threading

sys.dont_write_bytecode = True  # keep the tracker folder untouched (no __pycache__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TRACKER_DIR = os.environ.get("TRACKER_DIR", os.path.join(BASE_DIR, "..", "Tracker"))
sys.path.insert(0, os.path.abspath(TRACKER_DIR))

import app as tracker  # noqa: E402  (Tracker/app.py)
import workflow  # noqa: E402

workflow.register(tracker)
app = tracker.app

if __name__ == "__main__":
    # Same start-up as Tracker/app.py.
    if sys.platform == "darwin" and os.environ.get("WAKE_PROMPT", "1") == "1":
        tracker.watcher_running = True
        threading.Thread(target=tracker.wake_watcher, daemon=True).start()
    app.run(host="localhost", port=int(os.environ.get("PORT", 47474)), debug=False)
