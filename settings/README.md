# Settings (copy into the consuming project)

A plugin cannot ship a tool-permission allowlist — permissions are project/user level. These
files are ready-to-merge starters.

| File | Where it goes | Purpose |
|---|---|---|
| `install.settings.json` | commit as `<project>/.claude/settings.json` (merge if it exists) | **One-click install for a team.** Everyone who opens the project (CLI, **desktop app**, or IDE extension) gets a single "trust + install" prompt — the plugin is then auto-enabled with **no `/plugin` commands**. Commands appear as `/delivery-team:deliver` / `/delivery-team:self-review`. |
| `settings.json` | merge into `<project>/.claude/settings.json` (or `settings.local.json`) | Lets the orchestrator persist `artifacts/feature/**` + `docs/decisions/**` without an approval prompt on every write. |
| `settings.reviewer.json` | use as the settings for a **dedicated reviewer session** | Turns the Tier-2 "soft read-only" convention into a **hard guarantee** — denies source/test writes so `code-reviewer` / `security-reviewer` / `db-migration-engineer` physically cannot edit code, only their own `05-review.md`. **Edit the deny globs to match your source roots.** |

## Easiest install paths (least → most friction)

1. **One-click for a team (recommended).** Commit `install.settings.json` as the project's
   `.claude/settings.json`. Teammates open the repo → click **Trust** once → done. Nothing to
   type. (Merge the orchestrator `allow` block from `settings.json` into the same file.)
2. **Desktop GUI.** Click the **+** next to the prompt box → **Plugins** → add marketplace
   `okkarkp/sdlcchecker` → install `delivery-team` → choose scope → `/reload-plugins`.
3. **Slash commands (manual).** `/plugin marketplace add okkarkp/sdlcchecker` then
   `/plugin install delivery-team@acnhps-agents` then `/reload-plugins`.
4. **Vendor — zero install, bare commands.** Copy the plugin's `agents/` and `commands/` into
   `<project>/.claude/agents/` and `.claude/commands/` and commit. Commands then appear with
   **no namespace** (`/deliver`, `/self-review`) and no install step — at the cost of manual
   updates (re-copy to upgrade).

## Why the reviewer file matters for enterprise use
Tier-1 agents (requirements-analyst, solution-architect, frontend-designer) are hard read-only
via their `tools:` allow-list — that survives plugin packaging. Tier-2 reviewers need `Bash`
to run real scanners, so their "never edit source" is convention-only unless you back it with
a deny rule. For regulated/enterprise work, run reviewers in a session that loads
`settings.reviewer.json` so the guarantee is enforced, not trusted.
