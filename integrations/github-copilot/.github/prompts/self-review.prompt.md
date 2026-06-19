---
description: Self-review the current branch changes against the project's standards before raising a PR.
mode: agent
---

# Self-Review

Review the user's branch changes against the **host project's** standards. Be specific,
scoped, and honest — do not invent issues to look thorough.

## Inputs
- `${input:base:Base branch to diff against (default: main)}`

## Step 1 — Establish context
Confirm with the user **which scope** to review before running git:
- Staged changes only (pre-commit)
- Staged + unstaged uncommitted changes
- Full branch diff against the base (pre-PR — default base `main`, or the value above)

Then fetch the diff, file list, and commit history for that scope and read the diff in full —
do not skim. If the diff is empty, stop and say there is nothing to review.

## Step 2 — Load the right context
For each changed file, read its module's `CLAUDE.md`/`AGENTS.md` once, then the standards docs
the diff touches (discover them from the repo root; common names: coding-standards,
api-standards, security-rules, testing-guide, architecture). **Code is the source of truth** —
before flagging a doc violation, open the nearby code and confirm; if code and doc disagree,
follow the code and note the drift.

## Step 3 — Review against the checklist
Apply the project's "while coding" checklist (or this baseline if it has none): magic strings →
constant? hardcoded secrets/URLs? dead/commented-out code? `TODO`/`FIXME` without a reference?
doc comments on new public types? logging level + no secrets in logs? schema migration present
for schema changes, existing migrations untouched? new config keys in every environment?
inputs validated/encoded at boundaries? tests for new code?

## Step 4 — Report
```
## Self-Review Report
Base: <base> → HEAD (<n> commits, <m> files changed)

### Blockers (must fix before PR)
- <file>:<line> — <rule violated> — <suggested fix>

### Warnings (should fix, justify if not)
- <file>:<line> — <issue> — <suggestion>

### Doc drift (code is right, doc needs updating)
- <doc>:<section> — <what disagrees with code>

### Coverage
- Tests added for new code: yes / no / partial
- Areas without test coverage: <list>

### Verdict
- READY / NEEDS WORK
```
If a section has no findings, write "None" — do not omit it.

## Rules
Do not propose changes outside the diff (note unrelated issues once in an "Out of scope, but
noticed" line). Do not invent issues — a short clean report beats a padded one. Cite specific
file/line or rule; don't paraphrase. If a rule is ambiguous, follow the existing code and note it.
