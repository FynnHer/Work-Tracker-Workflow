#!/usr/bin/env python3
"""Workflow board from the command line, for Claude Code and Codex (see SKILL.md).

Talks to the running server (python run.py), so the timer rules stay the same as on the page.

  wf.py list [text]               open cards by column (done columns only count), filtered by text
  wf.py show <card>               everything about a card, as markdown
  wf.py start <card> | stop       timer on a card / stop the tracker timer
  wf.py move <card> <column>      e.g. move 12 done
  wf.py check <card> <item>       tick a checklist item (number or text)
  wf.py add <title> [description] new card in the first non-done column
  wf.py add - < cards.json        card(s) from JSON: {title, description, checklist: [str], type,
                                  priority, phase, column, labels: [str], due_date, estimate_hours}
  wf.py phases | phase <name> [YYYY-MM-DD]   list phases / add one

<card> is an id (12 or #12) or part of the title; <column> is part of a column name.
"""
import json
import os
import sys
import urllib.error
import urllib.request

URL = f"http://localhost:{os.environ.get('PORT', 47474)}"


def api(method, path, body=None):
    req = urllib.request.Request(URL + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        sys.exit(f"Error: {json.loads(e.read() or '{}').get('error', e.reason)}")
    except urllib.error.URLError:
        sys.exit(f"Workflow server not reachable at {URL}. Start it with: python run.py")


def find(items, query, what):
    """One item by id or by (part of) its name; exits with the candidates when it's ambiguous."""
    q = query.lstrip("#").strip().lower()
    key = "title" if what == "card" else "name"
    if q.isdigit() and any(i["id"] == int(q) for i in items):
        return next(i for i in items if i["id"] == int(q))
    hits = [i for i in items if i[key].lower() == q] or [i for i in items if q in i[key].lower()]
    if len(hits) == 1:
        return hits[0]
    if not hits:
        sys.exit(f"No {what} matches '{query}'.")
    sys.exit(f"'{query}' matches several {what}s, use the id:\n" + "\n".join(f"  #{i['id']} {i[key]}" for i in hits))


def hm(seconds):
    return f"{seconds // 3600}h{seconds % 3600 // 60:02d}" if seconds else "0h00"


def line(c, phases):
    bits = [c["type"] if c["type"] != "task" else "", c["priority"], phases.get(c["phase_id"], ""),
            f"due {c['due_date']}" if c["due_date"] else "", " ".join("#" + l for l in c["labels"]),
            "▶ running" if c["running"] else ""]
    done = sum(i["done"] for i in c["checklist"])
    if c["checklist"]:
        bits.append(f"{done}/{len(c['checklist'])} ✓")
    return f"  #{c['id']} {c['title']}" + "".join(f" · {b}" for b in bits if b)


def cmd_list(board, text=""):
    phases = {p["id"]: p["name"] for p in board["phases"]}
    q = text.lower()
    for col in board["columns"]:
        cards = [c for c in board["cards"] if c["column_id"] == col["id"]
                 and q in (c["title"] + c["description"] + " ".join(c["labels"])).lower()]
        if col["is_done"]:
            print(f"{col['name']} (done): {len(cards)} cards")
            continue
        print(f"{col['name']} ({len(cards)})")
        for c in cards:
            print(line(c, phases))


def cmd_show(board, card):
    c = find(board["cards"], card, "card")
    col = next(x["name"] for x in board["columns"] if x["id"] == c["column_id"])
    phase = next((p["name"] for p in board["phases"] if p["id"] == c["phase_id"]), "–")
    print(f"# #{c['id']} {c['title']}\n")
    print(f"- Column: {col}\n- Type: {c['type']}\n- Phase: {phase}\n- Priority: {c['priority'] or '–'}")
    print(f"- Due: {c['due_date'] or '–'}\n- Tracked / estimate: {hm(c['tracked_seconds'])} / {hm(c['estimate'])}")
    print(f"- Labels: {', '.join(c['labels']) or '–'}" + ("\n- Timer: running" if c["running"] else ""))
    if c["description"]:
        print(f"\n## Description\n\n{c['description']}")
    if c["checklist"]:
        print("\n## Checklist\n")
        for n, i in enumerate(c["checklist"], 1):
            print(f"{n}. [{'x' if i['done'] else ' '}] {i['text']}")


def cmd_move(board, card, column):
    c = find(board["cards"], card, "card")
    col = find(board["columns"], column, "column")
    api("POST", f"/api/workflow/cards/{c['id']}/move", {"column_id": col["id"], "position": 0})
    print(f"#{c['id']} {c['title']} → {col['name']}")


def cmd_start(board, card):
    c = find(board["cards"], card, "card")
    api("POST", f"/api/workflow/cards/{c['id']}/start")
    print(f"Timer running on #{c['id']} {c['title']}")


def cmd_stop(board):
    api("POST", "/api/stop")
    print("Timer stopped.")


def cmd_check(board, card, item):
    c = find(board["cards"], card, "card")
    items = c["checklist"]
    if item.isdigit() and 1 <= int(item) <= len(items):
        hit = items[int(item) - 1]
    else:
        hit = find([dict(i, id=-1, name=i["text"]) for i in items], item, "checklist item")
        hit = next(i for i in items if i["text"] == hit["text"])
    hit["done"] = True
    api("PATCH", f"/api/workflow/cards/{c['id']}", {"checklist": items})
    print(f"✓ {hit['text']}")


def card_body(board, spec):
    """API body for one card from the stdin JSON of `add -` (phase and column by name)."""
    spec = dict(spec)
    col = find(board["columns"], spec.pop("column"), "column") if "column" in spec else \
        next(x for x in board["columns"] if not x["is_done"])
    body = {"column_id": col["id"]}
    if "phase" in spec:
        body["phase_id"] = find(board["phases"], spec.pop("phase"), "phase")["id"]
    if "checklist" in spec:
        body["checklist"] = [{"text": t, "done": False} for t in spec.pop("checklist")]
    if "estimate_hours" in spec:
        body["estimate"] = round(float(spec.pop("estimate_hours")) * 3600)
    unknown = set(spec) - {"title", "description", "type", "priority", "labels", "due_date"}
    if unknown or not spec.get("title"):
        sys.exit(f"Card needs a title; unknown keys: {', '.join(unknown) or '–'}")
    return col, {**body, **spec}


def cmd_add(board, title, description=""):
    """add "<title>" [description], or add - with a JSON card or list of cards on stdin."""
    specs = json.load(sys.stdin) if title == "-" else {"title": title, "description": description}
    cards = [card_body(board, s) for s in (specs if isinstance(specs, list) else [specs])]  # all valid first
    for col, body in reversed(cards):  # new cards go on top, so the first ends up first
        c = api("POST", "/api/workflow/cards", body)
        print(f"Added #{c['id']} {c['title']} to {col['name']}")


def cmd_phases(board):
    for p in board["phases"]:
        state = "released" if p.get("released_at") else f"target {p['target_date']}" if p.get("target_date") else ""
        print(f"  #{p['id']} {p['name']}" + (f" · {state}" if state else ""))


def cmd_phase(board, name, target_date=""):
    p = api("POST", "/api/workflow/phases", {"name": name, "target_date": target_date})
    print(f"Added phase #{p['id']} {name}")


if __name__ == "__main__":
    cmd, *args = sys.argv[1:] or ["list"]
    fn = globals().get(f"cmd_{cmd}")
    if fn is None:
        sys.exit(__doc__)
    try:
        fn(api("GET", "/api/workflow/board"), *args)
    except TypeError:
        sys.exit(__doc__)
