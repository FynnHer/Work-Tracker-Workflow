---
name: workflow
description: Pull a card from the user's Workflow kanban board (Work Tracker) into the session and keep it in step while working on it, or add plans, ideas and bugs to the board as cards with description and checklist. Use for "/workflow", "/workflow <card>", "what's on my board", "work on card X", "add this plan to workflow", "put this on my board", or when the user names a board card.
argument-hint: "[card id or name | list [text] | start | move | check | add ...]"
---

The board runs locally (`python run.py` in Work-Tracker-Workflow, http://localhost:47474). Use the
script next to this file for everything; never edit `workflow.db` directly.

```sh
python3 <this-skill-dir>/wf.py list [text]               # open cards by column
python3 <this-skill-dir>/wf.py show <card>               # full card as markdown
python3 <this-skill-dir>/wf.py start <card>              # tracker timer on the card
python3 <this-skill-dir>/wf.py stop
python3 <this-skill-dir>/wf.py move <card> <column>      # e.g. move 12 done
python3 <this-skill-dir>/wf.py check <card> <item>       # item number or text
python3 <this-skill-dir>/wf.py add "<title>" "[description]"
python3 <this-skill-dir>/wf.py add - <<'EOF'              # rich card(s), see below
[{"title": "...", "description": "...", "checklist": ["step 1", "step 2"], "phase": "Cleanup"}]
EOF
python3 <this-skill-dir>/wf.py phases                    # phase names to use in "phase"
python3 <this-skill-dir>/wf.py phase "<name>" [YYYY-MM-DD]
```

`<card>` is an id (`12`, `#12`) or part of the title; if it matches several, the script lists them.

`add -` takes one card object or a list. Keys: `title` (required), `description` (markdown),
`checklist` (list of strings), `type` (task|bug|issue), `priority` (low|medium|high), `phase` and
`column` (part of the name; default: first open column), `labels` (list), `due_date` (YYYY-MM-DD),
`estimate_hours`. Every card is checked before any is added, so a bad phase adds nothing.

## What to do with the arguments

- **No arguments**: run `list`, show the board briefly and ask which card to work on.
- **A card id or name**: run `show <card>`. Treat its title, description and checklist as the task
  for this session: restate it in a line or two, then work through it. Ask before `start`ing the
  timer unless the user said so.
- **A subcommand** (`list`, `start`, `move`, ...): run it as given.
- **"Add this plan / this / X to workflow"**: turn it into cards with `add -` (below).

## Adding a plan or idea

Use what's in the conversation (a plan you wrote, a discussed fix, a bug you found):

- Small plan, one deliverable → **one card**: the goal as title, context and acceptance criteria in
  the description, each step as a checklist item.
- Bigger plan with separate deliverables → **one card per deliverable**, each with its own
  checklist, in plan order. Prefix titles with "Step n:" only if the order matters.
- Description must stand alone: a later session reads only the card, so include file paths,
  decisions made and why, not "as discussed".
- Run `phases` first and set `phase` if one clearly fits; if the plan is a new milestone, ask before
  creating a phase. Set `type` bug/issue, `priority`, `labels` only when the context says so.
- Then report the new card ids in one line each. No confirmation step needed when the user asked.

## While working on a card

- When a checklist item is done, tick it with `check` (say so in one line).
- When the whole card is done, ask before moving it to the done column (`move <card> done`).
- Found a separate bug or follow-up? Offer to `add` it as a card rather than doing it unasked.
- If the server isn't reachable, tell the user to start it (`python run.py`); don't work around it.
  In Codex, the sandbox blocks localhost too: first rerun the same command with escalated
  permissions (outside the sandbox) and only if that fails too, say the server is down.
