# Settings (copy into the consuming project)

A plugin cannot ship a tool-permission allowlist — permissions are project/user level. These
two files are ready-to-merge starters.

| File | Where it goes | Purpose |
|---|---|---|
| `settings.json` | merge into `<project>/.claude/settings.json` (or `settings.local.json`) | Lets the orchestrator persist `artifacts/feature/**` + `docs/decisions/**` without an approval prompt on every write. |
| `settings.reviewer.json` | use as the settings for a **dedicated reviewer session** | Turns the Tier-2 "soft read-only" convention into a **hard guarantee** — denies source/test writes so `code-reviewer` / `security-reviewer` / `db-migration-engineer` physically cannot edit code, only their own `05-review.md`. **Edit the deny globs to match your source roots.** |

## Why the reviewer file matters for enterprise use
Tier-1 agents (requirements-analyst, solution-architect, frontend-designer) are hard read-only
via their `tools:` allow-list — that survives plugin packaging. Tier-2 reviewers need `Bash`
to run real scanners, so their "never edit source" is convention-only unless you back it with
a deny rule. For regulated/enterprise work, run reviewers in a session that loads
`settings.reviewer.json` so the guarantee is enforced, not trusted.
