# Workflow — kanban module for Work Tracker

A kanban board that slides in from the right edge of the Work Tracker page. Cards are connected to
the tracker's timer: start the timer on a card and the time counts as normal tracker time (today,
week, overtime, heatmap) and adds up on the card.

The module doesn't change anything in the tracker. It loads `Tracker/app.py` as it is, adds its API
and panel to the same server, and keeps its board in its own database file.

## Run

```sh
python run.py          # instead of Tracker/app.py — same port, http://localhost:47474
```

Use the tracker's virtualenv if you have one (`../Tracker/.venv/bin/python run.py`, Windows:
`..\Tracker\.venv\Scripts\python run.py`). No extra dependencies besides Flask.

Don't run `Tracker/app.py` at the same time; both use port 47474. On macOS, `autostart.sh` still
starts `app.py`, so point the LaunchAgent at `Workflow/run.py` if you want the board after a login.

## Use

Open the board with the **Workflow** tab on the right edge of the page or press **W**. Close it
with **Esc** or ✕; **↔** switches to full width. The panel remembers whether it was open.

| Feature | How |
|---|---|
| **Cards & columns** | **+ Add card** (Enter adds the next one right away), **+ Add column**; drag cards within and between columns |
| **Card details** | Click a card: description, priority, due date, estimate, labels, checklist, column |
| **Timer on a card** | ▶ on the card (or **Start timer** in its details). The tracker timer starts with the card title as its note; a timer running for something else is stopped first |
| **Timer started on the tracker page** | The bar at the top offers **Count it towards a card…**, or use **Link running timer** in a card |
| **Tracked vs. estimate** | Cards show tracked time / estimate, red when over; the details list every session (**Unlink** removes one from the card, not from the tracker) |
| **WIP limits** | Column menu (⋯) → WIP limit; the column turns red when it has more cards than that |
| **Done column** | Column menu → *Done column*. Cards in it are finished (crossed out, no overdue warning), and moving the running card there stops the timer |
| **Due dates** | Amber for today and tomorrow, red when overdue |
| **Search & filters** | Search title, description, labels and checklist; filter by label and priority |
| **Archive** | **Archive** in a card or *Archive all cards* in a column menu; **Archive** in the header lists archived cards to restore or delete |

Renaming the running card also updates the tracker note. Deleting or archiving a card never deletes
tracked time; the sessions stay in the tracker.

## How it connects

```text
Browser ── /            → tracker page + workflow.css/js injected
        ── /api/*       → tracker API (unchanged)
        ── /api/workflow/* → this module ── workflow.db
                                         └─ reads/writes sessions in tracker.db (start, stop, link)
```

- `run.py` imports the tracker, registers the module, and starts the server the same way
  `app.py` does (including the come-back watcher on macOS). It doesn't write bytecode into the tracker folder.
- `workflow.py` holds the API and the `workflow.db` schema: `columns`, `cards`, and `card_sessions`
  (tracker session id → card).
- `static/workflow.js` builds the tab, panel and card dialog and uses the tracker's CSS variables
  and buttons, so it follows its light and dark theme. After a timer change it calls the tracker
  page's `refreshAll()`, so the clock and tiles update immediately.

| Setting | Environment variable | Default |
|---|---|---|
| Board database | `WORKFLOW_DB` | `workflow.db` next to `run.py` |
| Tracker folder | `TRACKER_DIR` | `../Tracker` |
| Port, tracker database, watcher | `PORT`, `TRACKER_DB`, `WAKE_PROMPT` | as in the tracker |

## Known limits (first version)

- **Adding a break** (on the tracker page) to a card's session splits it in two, and the second part
  isn't linked to the card. Link it again from the card (**Link running timer** while it runs).
- Columns are reordered with *Move left / right* in the column menu (no column drag yet).
- One board.
