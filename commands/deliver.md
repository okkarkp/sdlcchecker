---
description: Deliver a user story end-to-end through the orchestrator pipeline (with build-verify-validate loop)
argument-hint: "<path-to-story-or-ticket> [ticket-id]"
---

# Deliver

Drive the requirement at **$1** through the full delivery pipeline by handing it to the
orchestrator. This is the one-shot entry point so you don't have to remember the wiring.

Do this:

1. **Resolve the source.** `$1` is the story/spec path (or a ticket id, or — if `$1` is empty —
   ask the user which document/section to work from; never assume a default).
2. **Pre-flight checks**, then tell the user the result in one line each:
   - Is a feature already in progress? `grep -l 'IN PROGRESS' artifacts/feature/*/progress.md 2>/dev/null`
     — if one matches this ticket, **resume** it instead of starting fresh.
   - Are you on a safe branch? If the repo is git and you're on the default branch (`main`/`master`/
     `development`), suggest `git checkout -b feature/<ticket>-<slug>` first — the pipeline writes code.
   - Is the audit-log write permission granted? If `artifacts/feature/**` isn't allowed in
     settings, warn that the orchestrator will prompt on each log write (see the plugin README).
3. **Hand off to the orchestrator** with the source path and the ticket id (`$2` if given, else
   derive one): spawn `@orchestrator deliver <source>` and let it run its pipeline —
   clarify → design → (UI) → implement → review → test → build → **verify-and-iterate loop** →
   AC cross-check. Surface the **blocking-question gate** to the user if it fires; do not answer
   blocking questions yourself.
4. **Report** where it stopped (gate, done, or escalated from the verify loop) and the
   `artifacts/feature/<ticket>/` path holding the audit trail.

Honesty rule: a feature is done only when the gates are green AND the AC cross-check confirms every
acceptance criterion against the authoritative spec. Report built / partial / blocked truthfully.
