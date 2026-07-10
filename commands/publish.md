---
description: Publish a feature's .md artefacts as client-ready deliverables (Excel/Word/PDF). Read-only — renders the spine, never edits it.
argument-hint: "<ticket> [--only stories|design|architecture|tests|traceability|compliance|all] [--format docx|pdf|xlsx]"
---

# Publish

Render the markdown spine under `artifacts/feature/$1/` into **client-ready deliverables** in
`artifacts/feature/$1/deliverables/`. The `.md` files remain the single source of truth — this
command only *renders* them into Office/PDF formats, and **never edits the source**. Re-run it
any time the `.md` changes to refresh the deliverables.

Do this:

1. **Resolve the ticket.** `$1` is the ticket id (folder under `artifacts/feature/`). If `$1`
   is empty, list the available tickets and ask which one; never assume.
2. **Pre-flight, reported in one line each:**
   - Which artefacts are present (`00-stories.md`, `02-design.md`, `03-ui-flow.md`,
     `06-test.md`, `05-review.md`, ADRs). Missing ones are skipped, not invented.
   - Is a client template present in `templates/client/`? If so, deliverables inherit it.
   - Which conversion tier is available (see the packager) — polished or import-ready.
3. **Hand off to the packager.** Spawn `@deliverables-packager` with the ticket, the `--only`
   selection (default `all`) and any `--format` override.
4. **Report** the files written under `deliverables/`, the tier used, and — if it fell back to
   import-ready output — the one manual step to get the polished version.

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

Honesty rule: a deliverable reflects only what the `.md` actually contains. If a section is
missing or marked open/blocked, carry that through — never pad the document to look complete.
