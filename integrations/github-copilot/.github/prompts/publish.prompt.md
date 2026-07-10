---
description: Publish a feature's .md artefacts as client-ready deliverables (Excel/Word/PDF). Read-only — renders the spine, never edits it.
mode: agent
---

# Publish

Render the markdown spine under `artifacts/feature/${input:ticket:Ticket id}/` into
**client-ready deliverables** in `artifacts/feature/<ticket>/deliverables/`. The `.md` files
stay the single source of truth — this only *renders* them, and **never edits the source**.
Re-run any time the `.md` changes.

Do this:
1. **Resolve the ticket.** If none given, list tickets under `artifacts/feature/` and ask.
2. **Pre-flight (one line each):** which artefacts are present; whether a client template
   exists in `templates/client/`; which conversion tier is available.
3. **Adopt the deliverables-packager chat mode's behaviour** (`.github/chatmodes/`): read the
   spine, map each section to its deliverable, apply the client template, write to
   `deliverables/`.
4. **Report** the files written, the tier used, and any single manual step for import-ready
   output.

## What maps to what

| Spine (`.md`) | Deliverable | Default format |
| --- | --- | --- |
| `00-stories.md` | User story register / backlog | Excel |
| `02-design.md` + ADRs | Design & decisions spec | Word / PDF |
| architecture + diagram | Architecture spec | Word / PDF |
| `03-ui-flow.md` | UI flow spec | Word / PDF |
| `06-test.md` | Test cases + results | Excel |
| requirement → story → design → code → test | Traceability matrix | Excel |
| `05-review.md` + IM8 / PDPA / WCAG mapping | Compliance evidence pack | Word / PDF |

Honesty rule: a deliverable reflects only what the `.md` actually contains — carry through
anything missing, open, or blocked. Never pad a document to look complete.
