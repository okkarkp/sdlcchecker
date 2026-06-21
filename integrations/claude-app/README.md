# Claude app (chat) integration

The `delivery-team` pipeline is a **Claude Code** plugin — it needs Claude Code (CLI or the
VS Code / JetBrains extension) to run for real (sub-agents, `/deliver`, automated gates, a
written audit trail). **The Claude *chat* app (claude.ai / desktop app) cannot install Claude
Code plugins** — it has no `/plugin` command; its "Directory" only adds Anthropic-partner
connectors and skills.

This folder is the **chat-app approximation** so you can still get the methodology's value
without Claude Code.

## How to use it

1. Open [`delivery-team.project.md`](delivery-team.project.md) and copy the whole file.
2. In the Claude app, create a **Project** and paste it into the Project's **custom
   instructions** (or, with no Project, paste it as the first message of a new chat).
3. (Optional) Add your codebase context as Project files, and a `CLAUDE.md` describing your
   stack, commands, and compliance bands.
4. Give it a user story. It runs clarify → design → implement → review → test → deploy and
   reports honestly.

## What you get vs. the real plugin

| | Claude app (this) | Claude Code plugin |
|---|---|---|
| Runs the stages | ✅ one model, in sequence | ✅ specialist sub-agents |
| `/deliver` command | ❌ (paste instructions) | ✅ |
| Independent adversarial reviewer | ⚠️ same model, different hat | ✅ separate agent |
| Runs your tests / harness gates | ❌ you run them, it reasons | ✅ executes them |
| Written audit trail (files) | ❌ chat sections + code blocks | ✅ `artifacts/feature/<id>/` |
| Compliance bands + honesty rules | ✅ | ✅ |

**Bottom line:** use this for the discipline and the deliverables in the chat app today; move to
**Claude Code** when you want the automated, multi-agent, file-backed pipeline.
