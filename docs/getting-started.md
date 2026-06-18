# Getting started

A clear, end-to-end guide: the mental model, two ways to install, how to use it day to day, and
per-project tuning. If you read nothing else, read §1 and §3.

## 1. Mental model (read this first)

There are three separate things. Don't conflate them:

| Thing | What it is | Scope |
|---|---|---|
| **The plugin** | The engine: 11 agents + `/self-review` command + templates | **Install once.** Works in every project. |
| **Per-project tuning** (optional) | A `CLAUDE.md` + `.claude/rules/` in a project so agents learn *that* project's stack | Per project. Optional — agents still work without it. |
| **Permissions** (optional) | A few `settings.json` allow rules so the orchestrator writes its log without prompting | Once globally, or per project. |

You install the **engine once**. Everything else is optional sharpening.

## 2. Install — pick ONE of two ways

### Way A — Marketplace plugin (clean, updatable; uses the `/plugin` UI)
In a Claude Code session:
```
/plugin marketplace add /path/to/this/repo        (or:  your-org/your-repo on GitHub)
/plugin install delivery-team@<marketplace-name>
```
Installs at the **user level** — available in every project. To update, re-pull the repo.

### Way B — Vendored (works immediately, no UI step)
Copy the engine into a project's `.claude/`:
```bash
P=/path/to/this/repo
mkdir -p .claude/agents .claude/commands .claude/templates
cp "$P"/agents/*.md       .claude/agents/
cp "$P"/commands/*.md     .claude/commands/
cp -R "$P"/templates/feature .claude/templates/feature
cp "$P"/templates/ADR-TEMPLATE.md .claude/templates/
```
Project-level agents load automatically. `.claude/templates/feature` is the fallback path the
orchestrator uses when `${CLAUDE_PLUGIN_ROOT}` isn't set (i.e. when vendored).

> **Don't do both.** If you vendor AND marketplace-install, you get duplicate agent names. Pick one.

## 3. Use it — day to day

**Start a new session** so the agents load. Then:

```
# Full pipeline — route a requirement through the orchestrator (the entry point):
@orchestrator deliver the feature described in <path-to-story-or-spec>

# One specialist, one-off (no full pipeline):
@requirements-analyst clarify <path-to-story>
@solution-architect propose a design for <X>
@code-reviewer review the current change

# Slash command:
/self-review
```

What the orchestrator does: runs **clarify → design → (UI) → implement → (schema review) →
review → test → build → AC cross-check**, spawning one specialist per step. It copies
`templates/feature/` into `artifacts/feature/<ticket>/` and keeps a running `progress.md` +
`00`–`06` logs — the audit trail.

**Blocking-question gate.** After clarify, if requirements are ambiguous the pipeline **stops**
and asks you. Answer, then continue. It will not guess past a blocking question.

**Resume after an interruption:**
```
@orchestrator resume <ticket>
```
It greps the `IN PROGRESS` marker in `progress.md` and continues from the first unchecked step.

## 4. Permissions (optional but smoother)

So the orchestrator persists its audit log without an approval prompt each time, add these to the
project's `.claude/settings.json` (or once, globally, in `~/.claude/settings.json`):
```json
{ "permissions": { "allow": [
  "Write(artifacts/feature/**)", "Edit(artifacts/feature/**)",
  "Write(docs/decisions/**)",   "Edit(docs/decisions/**)"
] } }
```
For a **dedicated reviewer session** with enforced read-only, use `settings/settings.reviewer.json`
(deny source writes). See [`../settings/`](../settings/).

## 5. Per-project tuning (optional)

To make the agents sharp for a specific project:
1. Copy [`../templates/CLAUDE.md`](../templates/CLAUDE.md) to the project root, fill in §0
   (stack, commands, test framework).
2. Copy the rule starters from [`../rules/`](../rules/) into `<project>/.claude/rules/` and edit
   the `paths:` globs to your layout. (`general.md` applies everywhere; `backend`/`frontend`/`auth`
   are per-area.)

The orchestrator reads all this in its pre-brief and passes it downstream.

## 6. First run — do this, not a big feature

The advisory half (clarify/design) is well-exercised; the implement→review→test→build half is
newer. For your first run: pick **one small, low-risk story**, run it on a **throwaway git
worktree/branch**, and watch the hand-offs. Treat it as a shakedown, then scale up. See
[`enterprise.md`](enterprise.md) for what's enforced vs. still owed.
