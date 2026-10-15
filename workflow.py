"""Workflow — a kanban board module for Work Tracker.

Registers its API and static files on the tracker's Flask app (see run.py). Board data lives in its
own SQLite file; cards are linked to tracker sessions by id, so time tracked on a card is ordinary
tracker time (today, week, overtime, heatmap) and the card shows the sum of its sessions.
"""
import json
import os
import sqlite3
from datetime import datetime

from flask import Blueprint, g, jsonify, request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("WORKFLOW_DB", os.path.join(BASE_DIR, "workflow.db"))

PRIORITIES = ("", "low", "medium", "high")
DEFAULT_COLUMNS = [("To do", 0), ("In progress", 0), ("Done", 1)]

bp = Blueprint("workflow", __name__, static_folder="static", static_url_path="/workflow/static")
T = None  # the tracker module (Tracker/app.py), set by register()


# ---------------------------------------------------------------- database

def wdb():
    if "wf_db" not in g:
        g.wf_db = sqlite3.connect(DB_PATH)
        g.wf_db.row_factory = sqlite3.Row
        g.wf_db.execute("PRAGMA foreign_keys = ON")
    return g.wf_db


@bp.teardown_app_request
def close_wdb(_exc):
    db = g.pop("wf_db", None)
    if db is not None:
        db.close()


def init_db():
    with sqlite3.connect(DB_PATH) as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS columns (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL,
                position   INTEGER NOT NULL,
                wip_limit  INTEGER NOT NULL DEFAULT 0,   -- 0 = no limit
                is_done    INTEGER NOT NULL DEFAULT 0    -- cards here count as finished
            );
            CREATE TABLE IF NOT EXISTS cards (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                column_id   INTEGER NOT NULL REFERENCES columns(id),
                position    INTEGER NOT NULL,
                title       TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                priority    TEXT NOT NULL DEFAULT '',    -- '' | low | medium | high
                due_date    TEXT,                        -- YYYY-MM-DD
                estimate    INTEGER NOT NULL DEFAULT 0,  -- seconds, 0 = none
                labels      TEXT NOT NULL DEFAULT '[]',  -- JSON list of strings
                checklist   TEXT NOT NULL DEFAULT '[]',  -- JSON list of {text, done}
                created_at  TEXT NOT NULL,
                done_at     TEXT,                        -- set while in a done column
                archived    INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_cards_column ON cards(column_id, position);
            -- Tracker sessions worked on a card (sessions live in tracker.db).
            CREATE TABLE IF NOT EXISTS card_sessions (
                session_id  INTEGER PRIMARY KEY,
                card_id     INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE
            );
            """
        )
        if not db.execute("SELECT 1 FROM columns").fetchone():
            db.executemany("INSERT INTO columns (name, position, is_done) VALUES (?, ?, ?)",
                           [(n, i, d) for i, (n, d) in enumerate(DEFAULT_COLUMNS)])


# ---------------------------------------------------------------- helpers

def now() -> str:
    return T.fmt(datetime.now())


def bad_request(msg: str):
    return jsonify({"error": msg}), 400


def not_found():
    return jsonify({"error": "Not found"}), 404


def column_dict(row) -> dict:
    return {"id": row["id"], "name": row["name"], "position": row["position"],
            "wip_limit": row["wip_limit"], "is_done": bool(row["is_done"])}


def card_dict(row, tracked=0, running=False) -> dict:
    return {
        "id": row["id"], "column_id": row["column_id"], "position": row["position"],
        "title": row["title"], "description": row["description"], "priority": row["priority"],
        "due_date": row["due_date"], "estimate": row["estimate"],
        "labels": json.loads(row["labels"]), "checklist": json.loads(row["checklist"]),
        "created_at": row["created_at"], "done_at": row["done_at"], "archived": bool(row["archived"]),
        "tracked_seconds": tracked, "running": running,
    }


def time_per_card() -> tuple:
    """({card_id: tracked seconds}, card id of the running tracker session or None)."""
    links = dict(wdb().execute("SELECT session_id, card_id FROM card_sessions").fetchall())
    totals, running_card = {}, None
    if links:
        ids = list(links)
        rows = T.get_db().execute(
            f"SELECT * FROM sessions WHERE id IN ({','.join('?' * len(ids))})", ids).fetchall()
        for r in rows:
            s = T.session_dict(r)
            cid = links[r["id"]]
            totals[cid] = totals.get(cid, 0) + s["seconds"]
            if s["running"]:
                running_card = cid
    return totals, running_card


def running_card_id():
    run = T.running_session()
    if not run:
        return None
    row = wdb().execute("SELECT card_id FROM card_sessions WHERE session_id = ?", (run["id"],)).fetchone()
    return row["card_id"] if row else None


def get_card(cid):
    return wdb().execute("SELECT * FROM cards WHERE id = ?", (cid,)).fetchone()


def card_response(cid):
    totals, running = time_per_card()
    return jsonify(card_dict(get_card(cid), totals.get(cid, 0), running == cid))


def renumber(column_id, ordered_ids):
    wdb().executemany("UPDATE cards SET position = ?, column_id = ? WHERE id = ?",
                      [(i, column_id, cid) for i, cid in enumerate(ordered_ids)])


def stop_tracker():
    """Stop the tracker timer (same as the tracker's Stop button)."""
    run = T.running_session()
    if run:
        T.get_db().execute("UPDATE sessions SET end_time = ? WHERE id = ?", (now(), run["id"]))
        T.get_db().commit()


# ---------------------------------------------------------------- board

@bp.get("/api/workflow/board")
def board():
    """Columns and all non-archived cards with their tracked time; the running tracker session."""
    db = wdb()
    totals, running = time_per_card()
    run = T.running_session()
    return jsonify({
        "now": now(),
        "today": datetime.now().date().isoformat(),
        "columns": [column_dict(r) for r in db.execute("SELECT * FROM columns ORDER BY position")],
        "cards": [card_dict(r, totals.get(r["id"], 0), running == r["id"])
                  for r in db.execute("SELECT * FROM cards WHERE archived = 0 ORDER BY column_id, position")],
        "archived_count": db.execute("SELECT COUNT(*) FROM cards WHERE archived = 1").fetchone()[0],
        "running": T.session_dict(run) if run else None,
        "running_card_id": running,
    })


@bp.get("/api/workflow/archive")
def archive():
    totals, _ = time_per_card()
    rows = wdb().execute("SELECT * FROM cards WHERE archived = 1 ORDER BY COALESCE(done_at, created_at) DESC")
    return jsonify([card_dict(r, totals.get(r["id"], 0)) for r in rows])


# ---------------------------------------------------------------- columns

@bp.post("/api/workflow/columns")
def add_column():
    name = str((request.get_json(silent=True) or {}).get("name", "")).strip()
    if not name:
        return bad_request("Give the column a name.")
    db = wdb()
    pos = db.execute("SELECT COALESCE(MAX(position) + 1, 0) FROM columns").fetchone()[0]
    cur = db.execute("INSERT INTO columns (name, position) VALUES (?, ?)", (name, pos))
    db.commit()
    return jsonify(column_dict(db.execute("SELECT * FROM columns WHERE id = ?", (cur.lastrowid,)).fetchone())), 201


@bp.patch("/api/workflow/columns/<int:col_id>")
def edit_column(col_id):
    data = request.get_json(silent=True) or {}
    db = wdb()
    col = db.execute("SELECT * FROM columns WHERE id = ?", (col_id,)).fetchone()
    if col is None:
        return not_found()
    name = str(data.get("name", col["name"])).strip()
    try:
        wip = int(data.get("wip_limit", col["wip_limit"]))
    except (TypeError, ValueError):
        return bad_request("The WIP limit must be a number (0 = no limit).")
    is_done = int(bool(data.get("is_done", col["is_done"])))
    if not name or wip < 0:
        return bad_request("Name required; WIP limit 0 or more.")
    db.execute("UPDATE columns SET name = ?, wip_limit = ?, is_done = ? WHERE id = ?", (name, wip, is_done, col_id))
    if is_done != col["is_done"]:  # cards already in it become done / not done now
        db.execute("UPDATE cards SET done_at = ? WHERE column_id = ?", (now() if is_done else None, col_id))
    db.commit()
    return jsonify(column_dict(db.execute("SELECT * FROM columns WHERE id = ?", (col_id,)).fetchone()))


@bp.post("/api/workflow/columns/order")
def order_columns():
    ids = (request.get_json(silent=True) or {}).get("ids", [])
    db = wdb()
    if sorted(ids) != sorted(r[0] for r in db.execute("SELECT id FROM columns")):
        return bad_request("Send all column ids in the new order.")
    db.executemany("UPDATE columns SET position = ? WHERE id = ?", [(i, cid) for i, cid in enumerate(ids)])
    db.commit()
    return "", 204


@bp.delete("/api/workflow/columns/<int:col_id>")
def delete_column(col_id):
    db = wdb()
    if db.execute("SELECT 1 FROM cards WHERE column_id = ? AND archived = 0", (col_id,)).fetchone():
        return bad_request("Move or archive the cards in this column first.")
    if db.execute("SELECT COUNT(*) FROM columns").fetchone()[0] <= 1:
        return bad_request("The board needs at least one column.")
    # Archived cards keep their history; park them in the first remaining column.
    first = db.execute("SELECT id FROM columns WHERE id != ? ORDER BY position LIMIT 1", (col_id,)).fetchone()[0]
    db.execute("UPDATE cards SET column_id = ? WHERE column_id = ?", (first, col_id))
    cur = db.execute("DELETE FROM columns WHERE id = ?", (col_id,))
    db.commit()
    return ("", 204) if cur.rowcount else not_found()


# ---------------------------------------------------------------- cards

def read_card_fields(data: dict, partial: bool):
    """Validated column values from a JSON body; only the keys present when partial."""
    out = {}
    if "title" in data or not partial:
        title = str(data.get("title", "")).strip()
        if not title:
            raise ValueError("The card needs a title.")
        out["title"] = title[:300]
    if "description" in data:
        out["description"] = str(data["description"])[:20000]
    if "priority" in data:
        if data["priority"] not in PRIORITIES:
            raise ValueError("Priority is low, medium, high or empty.")
        out["priority"] = data["priority"]
    if "due_date" in data:
        due = data["due_date"] or None
        if due:
            T.parse_day(due)  # ValueError if malformed
        out["due_date"] = due
    if "estimate" in data:
        est = int(data["estimate"] or 0)
        if est < 0:
            raise ValueError("The estimate can't be negative.")
        out["estimate"] = est
    if "labels" in data:
        labels = [str(l).strip()[:40] for l in data["labels"] if str(l).strip()]
        out["labels"] = json.dumps(list(dict.fromkeys(labels)))  # unique, order kept
    if "checklist" in data:
        out["checklist"] = json.dumps([{"text": str(i["text"]).strip()[:300], "done": bool(i.get("done"))}
                                       for i in data["checklist"] if str(i.get("text", "")).strip()])
    return out


@bp.post("/api/workflow/cards")
def add_card():
    data = request.get_json(silent=True) or {}
    db = wdb()
    col = db.execute("SELECT * FROM columns WHERE id = ?", (data.get("column_id"),)).fetchone()
    if col is None:
        return bad_request("Unknown column.")
    try:
        fields = read_card_fields(data, partial=False)
    except (TypeError, ValueError, KeyError) as e:
        return bad_request(str(e) or "Invalid card.")
    # New cards go on top of the column.
    db.execute("UPDATE cards SET position = position + 1 WHERE column_id = ?", (col["id"],))
    fields.update(column_id=col["id"], position=0, created_at=now(), done_at=now() if col["is_done"] else None)
    cur = db.execute(f"INSERT INTO cards ({', '.join(fields)}) VALUES ({', '.join('?' * len(fields))})",
                     list(fields.values()))
    db.commit()
    return card_response(cur.lastrowid), 201


@bp.patch("/api/workflow/cards/<int:cid>")
def edit_card(cid):
    if get_card(cid) is None:
        return not_found()
    data = request.get_json(silent=True) or {}
    try:
        fields = read_card_fields(data, partial=True)
    except (TypeError, ValueError, KeyError) as e:
        return bad_request(str(e) or "Invalid card.")
    if "archived" in data:
        fields["archived"] = int(bool(data["archived"]))
        if fields["archived"] and running_card_id() == cid:
            stop_tracker()
    if fields:
        db = wdb()
        db.execute(f"UPDATE cards SET {', '.join(k + ' = ?' for k in fields)} WHERE id = ?", [*fields.values(), cid])
        db.commit()
        if "title" in fields and running_card_id() == cid:  # keep the tracker note in step
            T.get_db().execute("UPDATE sessions SET note = ? WHERE end_time IS NULL", (fields["title"],))
            T.get_db().commit()
    return card_response(cid)


@bp.post("/api/workflow/cards/<int:cid>/move")
def move_card(cid):
    """Move a card to {column_id, position}. Into a done column: it's finished, its timer stops."""
    data = request.get_json(silent=True) or {}
    db = wdb()
    card = get_card(cid)
    if card is None:
        return not_found()
    col = db.execute("SELECT * FROM columns WHERE id = ?", (data.get("column_id"),)).fetchone()
    if col is None:
        return bad_request("Unknown column.")
    ids = [r[0] for r in db.execute(
        "SELECT id FROM cards WHERE column_id = ? AND archived = 0 AND id != ? ORDER BY position", (col["id"], cid))]
    pos = max(0, min(int(data.get("position", len(ids))), len(ids)))
    ids.insert(pos, cid)
    renumber(col["id"], ids)
    if card["column_id"] != col["id"]:
        rest = [r[0] for r in db.execute(
            "SELECT id FROM cards WHERE column_id = ? AND archived = 0 ORDER BY position", (card["column_id"],))]
        renumber(card["column_id"], rest)
        db.execute("UPDATE cards SET done_at = ? WHERE id = ?", (now() if col["is_done"] else None, cid))
        if col["is_done"] and running_card_id() == cid:
            stop_tracker()
    db.commit()
    return card_response(cid)


@bp.delete("/api/workflow/cards/<int:cid>")
def delete_card(cid):
    """Delete a card. Its tracked sessions stay in the tracker (only the link goes)."""
    db = wdb()
    cur = db.execute("DELETE FROM cards WHERE id = ?", (cid,))
    db.commit()
    return ("", 204) if cur.rowcount else not_found()


# ---------------------------------------------------------------- timer (tracker connection)

@bp.post("/api/workflow/cards/<int:cid>/start")
def start_card(cid):
    """Start the tracker timer for a card (note = card title). A timer for something else is stopped first."""
    card = get_card(cid)
    if card is None:
        return not_found()
    if running_card_id() == cid:
        return bad_request("The timer already runs for this card.")
    stop_tracker()
    tdb = T.get_db()
    cur = tdb.execute("INSERT INTO sessions (start_time, note) VALUES (?, ?)", (now(), card["title"]))
    tdb.commit()
    db = wdb()
    db.execute("INSERT OR REPLACE INTO card_sessions VALUES (?, ?)", (cur.lastrowid, cid))
    db.commit()
    return card_response(cid)


@bp.post("/api/workflow/cards/<int:cid>/link")
def link_running(cid):
    """Count the timer that is already running (started on the tracker page) towards this card;
    its note becomes the card title, as when the timer is started from the card."""
    card = get_card(cid)
    if card is None:
        return not_found()
    run = T.running_session()
    if not run:
        return bad_request("No timer is running.")
    db = wdb()
    db.execute("INSERT OR REPLACE INTO card_sessions VALUES (?, ?)", (run["id"], cid))
    db.commit()
    T.get_db().execute("UPDATE sessions SET note = ? WHERE id = ?", (card["title"], run["id"]))
    T.get_db().commit()
    return card_response(cid)


@bp.get("/api/workflow/cards/<int:cid>/sessions")
def card_sessions(cid):
    ids = [r[0] for r in wdb().execute("SELECT session_id FROM card_sessions WHERE card_id = ?", (cid,))]
    if not ids:
        return jsonify([])
    rows = T.get_db().execute(
        f"SELECT * FROM sessions WHERE id IN ({','.join('?' * len(ids))}) ORDER BY start_time DESC", ids).fetchall()
    return jsonify([T.session_dict(r) for r in rows])


@bp.delete("/api/workflow/sessions/<int:sid>")
def unlink_session(sid):
    """Stop counting a session towards its card (the session itself stays in the tracker)."""
    db = wdb()
    db.execute("DELETE FROM card_sessions WHERE session_id = ?", (sid,))
    db.commit()
    return "", 204


# ---------------------------------------------------------------- hook into the tracker

TAGS = ('<link rel="stylesheet" href="/workflow/static/workflow.css">\n'
        '<script src="/workflow/static/workflow.js" defer></script>\n')


def register(tracker):
    """Attach the module to the tracker's Flask app; its page gets the Workflow panel."""
    global T
    T = tracker
    init_db()
    tracker.app.register_blueprint(bp)

    def index():
        with open(os.path.join(tracker.app.static_folder, "index.html"), encoding="utf-8") as f:
            html = f.read()
        return html.replace("</head>", TAGS + "</head>", 1), 200, {"Content-Type": "text/html; charset=utf-8"}

    tracker.app.view_functions["index"] = index
