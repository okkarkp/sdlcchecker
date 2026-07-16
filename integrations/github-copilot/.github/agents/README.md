# SDLC Agent Suite — GitHub Copilot CLI custom agents

These thirteen `*.agent.md` files are the Copilot **CLI** port of the suite (the terminal `copilot`
command). They are the counterpart to `../chatmodes/` (which is for **VS Code Copilot Chat** — the
CLI has no chat-mode dropdown).

> **New (July 2026):** All agents have been enriched to match the comprehensive Claude agent specs
> while remaining fully GitHub Copilot compatible. See `ENRICHMENT-SUMMARY.md` for details on what
> changed: deeper process guidance, compliance-aware checklists, structured output formats, and
> hard safety gates (e.g. "never claim a pass you didn't run").

## Install

Copy the agents into one of the two locations Copilot CLI reads:

```bash
# repository-level (commit these so the whole team gets them)
mkdir -p .github/agents && cp *.agent.md .github/agents/

# …or user-level (available in every repo)
mkdir -p ~/.copilot/agents && cp *.agent.md ~/.copilot/agents/
```

Put the shared engineering rules, gates and honesty rules in **`.github/copilot-instructions.md`**
(or `AGENTS.md`) at the repo root — Copilot CLI discovers it automatically. Use the
`../copilot-instructions.md` from this bundle as the starting point.

## Use

```bash
copilot                 # start, then: /agent  → pick a persona → prompt it
copilot --agent orchestrator -p "deliver docs/stories/PROJ-1.md" --allow-all-tools
```

Drive the pipeline through `orchestrator`; for a deep single-role pass run that agent directly
(e.g. `--agent security-reviewer`). Copilot CLI runs one agent at a time — the stages are walked
sequentially (no parallel sub-agents), but the gates, the blocking-question hard-stop, the verify
loop and the independent acceptance-criteria cross-check are all preserved.

## Read-only tiers (enforced by the `tools` allowlist)

CLI tool ids: `read`, `edit`, `search`, `execute`, `agent`.

| Agents | tools | Can edit source? |
|---|---|---|
| requirements-analyst · solution-architect · frontend-designer | `read, search` | **No** (Tier-1 read-only) |
| code-reviewer · security-reviewer · db-migration-engineer | `read, search, execute` | **No** (run scanners, report only) |
| backend/frontend-developer · test-engineer · devops-engineer · deliverables-packager | `read, search, edit, execute` | Yes |
| orchestrator | `read, search, edit, execute, agent` | Yes (+ invokes specialists) |

## Sovereign / air-gapped

Point the CLI at the agency's own model and these agents run entirely inside the boundary:

```bash
export COPILOT_PROVIDER_BASE_URL=http://localhost:11434   # local model server
export COPILOT_MODEL=<your-coding-model>
export COPILOT_OFFLINE=true                               # full network isolation
```
