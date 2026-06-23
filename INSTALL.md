# Install — for a new user

Three ways to get the delivery-team agents + commands, from easiest to most universal.
Pick by **where you run Claude Code**.

| Your environment | Use |
|---|---|
| Local CLI / IDE extension / Desktop **Code** tab, on a team | **A — one-click** |
| Local, just yourself | **B — `/plugin`** |
| Cloud session, Chat/Cowork tab, or `/plugin` not available | **C — vendor** |

---

## A — One-click team install ⭐ (new user does nothing)

Commit this file into any project as `.claude/settings.json` (the exact content also ships at
[`settings/install.settings.json`](settings/install.settings.json)):

```json
{
  "extraKnownMarketplaces": {
    "acnhps-agents": {
      "source": { "source": "github", "repo": "okkarkp/sdlcchecker" }
    }
  },
  "enabledPlugins": { "delivery-team@acnhps-agents": true }
}
```

When a teammate opens that repo in Claude Code, it fetches the plugin from GitHub automatically
(one *"Trust this folder + install?"* prompt). Commands appear **namespaced**:
`/delivery-team:deliver`, `/delivery-team:self-review`. Nobody clones or downloads anything.

## B — Manual marketplace install (individual)

In a **local/SSH** Claude Code session (not the Chat/Cowork tab):

```
/plugin marketplace add okkarkp/sdlcchecker
/plugin install delivery-team@acnhps-agents
/reload-plugins
```

Or via the UI: `/plugin` → **Marketplaces** tab → add `okkarkp/sdlcchecker` → install
**delivery-team**.

> ⚠️ `/plugin` only works in **local/SSH** sessions — not in cloud sessions and not in the
> Chat/Cowork tabs. If you see *"/plugin isn't available in this environment,"* use Option C.

## C — Vendoring (universal fallback, zero install)

Works **everywhere** — cloud, web, managed-policy, older builds. Copy the agents + commands
straight into the project:

```bash
mkdir -p .claude
cp -r agents     .claude/agents
cp -r commands   .claude/commands
cp -r templates  .claude/templates   # so the orchestrator can scaffold features
```

Commands then appear as **bare** `/deliver`, `/self-review` with no install step. (This is what
the leadership demo project uses — that's why it needs no `/plugin`.)

---

## Verify it worked (any option)

1. Type `@` → the **11 agents** appear in the picker (requirements-analyst, solution-architect,
   frontend-designer, backend-developer, frontend-developer, db-migration-engineer, code-reviewer,
   security-reviewer, test-engineer, devops-engineer, orchestrator).
2. Type `/` → `deliver` and `self-review` appear (bare for C, `delivery-team:`-prefixed for A/B).
3. Smoke test: `/deliver docs/stories/<your-story>.md <TICKET>`

## Command naming, so you're not surprised

- **A / B (marketplace):** slash commands are **prefixed** → `/delivery-team:deliver`.
- **C (vendored):** slash commands are **bare** → `/deliver`.
- **Agents** are invoked by name (`@code-reviewer`, or *"Use the code-reviewer agent to…"*)
  regardless of how you installed.
