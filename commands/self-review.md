---
description: Self-review branch changes against project standards before raising a PR
argument-hint: "[base-branch] (default: main)"
---

# Self-Review

You are reviewing the user's branch changes against the **host project's** standards. Be
specific, scoped, and honest — do not invent issues to look thorough.

## Step 1 — Establish context

Before running any git commands, confirm two things with the user:

1. **Which repo to review.** The session may be running from a temporary worktree
   (`*_worktree/...`) rather than the user's main feature-branch checkout. Check your current
   working directory and confirm with the user if it's not obvious which repo is the target.

2. **Which scope to review.** Common options — pick the right one with the user:
   - Staged changes only (pre-commit review)
   - Staged + unstaged uncommitted changes
   - The full branch diff against a base (pre-PR review — default base is `main`, accept `$1` as override)

Once the repo and scope are agreed, decide the right git commands to fetch the diff, file
list, and commit history for that scope. Read the diff in full — do not skim. If the diff is
empty, stop and tell the user there is nothing to review.

## Step 2 — Load the right context

For every changed file, identify which module it belongs to and read that module's
`CLAUDE.md` once (do not re-read it for subsequent files in the same module). Then read the
project's standards docs that the diff touches — discover them from the root `CLAUDE.md`
(common names: coding-standards, api-standards, security-rules, testing-guide,
architectural-principles, a dev checklist). Cross-reference by what the diff changes:

| If the diff includes... | Read |
|------------------------|------|
| New or changed API endpoints / DTOs | the project's API-standards doc |
| New entities, repositories, services, enums, constants | the coding-standards doc |
| Auth, tokens, session, access-control, logging | the security-rules doc |
| New test files or test changes | the testing-guide |
| Any new architectural decision (new module split, new pattern) | the architecture doc |

**Code is the source of truth.** Before flagging a doc violation, open the actual nearby code
in the same package and confirm the pattern is what the doc claims. If code and doc disagree,
follow the code and note the doc drift.

## Step 3 — Review against the project's checklist

Apply the project's "while coding" checklist to the diff (find it via `CLAUDE.md`; if the
project has none, use this generic baseline):

- Magic strings → enum/constant?
- Hardcoded credentials, URLs, secrets?
- Commented-out / dead code?
- `TODO` / `FIXME` without a tracking reference?
- Doc comments on new public types and methods?
- Logging at the appropriate level; no secrets / PII / tokens in logs?
- Entity rules followed (base class / audit columns, FK conventions)?
- Schema migration present for schema changes; existing migrations untouched?
- New config keys present in every environment config file?
- New endpoints documented (operation + schema annotations)?
- DTOs/contracts versioned per the project's convention?
- New UI components have the project's required stories/tests?
- Inputs validated and encoded at boundaries?

## Step 4 — Report

Produce a punch list in this exact format:

```
## Self-Review Report
Base: <base-branch> → HEAD (<commit-count> commits, <file-count> files changed)

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

If there are no findings in a section, write "None" — do not omit the section.

## Rules

- **Do not propose changes outside the diff.** If you spot an unrelated issue while reading
  neighbouring code, mention it once in a final "Out of scope, but noticed" line — do not
  turn it into a punch list item.
- **Do not invent issues.** If the diff is clean, say so. A short clean report is better than
  a padded one.
- **Cite, don't paraphrase.** Every finding must reference a specific file/line in the diff
  or a specific rule in the docs.
- **If a rule is ambiguous, follow the existing code** in the same package and note the
  ambiguity in the report.
