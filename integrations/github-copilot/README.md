# delivery-team for GitHub Copilot

A port of the `delivery-team` delivery pipeline to **GitHub Copilot** (Copilot Chat in VS Code).
Same gates, same verify-loop, same honesty rules — adapted to Copilot's customization model.

## What maps cleanly, and what doesn't

The Claude Code plugin and Copilot solve the same problem with different building blocks. This
port is faithful where the platforms align and honest where they don't.

| Claude `delivery-team` | GitHub Copilot equivalent | Fidelity |
|---|---|---|
| Shared engineering rules (`rules/`) | `.github/copilot-instructions.md` | **Full** — applied to every request |
| `/deliver`, `/self-review` commands | `.github/prompts/*.prompt.md` (run as `/deliver`) | **Full** — reusable prompt files |
| 11 specialist agents | `.github/chatmodes/*.chatmode.md` personas | **Partial** — see below |
| Orchestrator spawns sub-agents **in parallel**, each in its own context | One agent session at a time; personas are walked **sequentially** | **Adapted** |
| Read-only tiers enforced by withholding write tools | `tools:` allowlist per chat mode (omit `editFiles`) | **Full** — read-only personas have no edit tool |
| Per-feature audit log under `artifacts/feature/<id>/` | Same — the prompt writes the same files | **Full** |

**The one real difference:** Copilot does not auto-spawn a fleet of sub-agents. The `delivery-team`
orchestrator fans out to independent agents (e.g. three reviewers in parallel, each with a clean
context). In Copilot, `/deliver` drives the **same stages in a single session**, adopting each
persona in turn. The pipeline, gates, blocking-question hard-stop, 3-cycle verify-loop, and the
independent AC cross-check are all preserved — only the concurrency is lost. For a deep
single-role pass, switch to that chat mode directly (e.g. the **security-reviewer** mode for an
adversarial probe).

## Install

Copy the `.github/` tree from this folder into the **root of your target repository**:

```
your-repo/
  .github/
    copilot-instructions.md       # global rules — applied to every Copilot request
    prompts/
      deliver.prompt.md           # /deliver — the full pipeline
      self-review.prompt.md       # /self-review — pre-PR review
    chatmodes/
      orchestrator.chatmode.md
      requirements-analyst.chatmode.md
      solution-architect.chatmode.md
      code-reviewer.chatmode.md
      security-reviewer.chatmode.md
      db-migration-engineer.chatmode.md
      test-engineer.chatmode.md
```

Then in VS Code enable prompt/instruction files (Settings → search
`chat.promptFiles` / `github.copilot.chat.codeGeneration.useInstructionFiles` → on).
Reload the window. `.github/copilot-instructions.md` is picked up automatically.

## Use

1. Open Copilot Chat in your repo.
2. Run the pipeline on a story:
   ```
   /deliver  story=docs/stories/ABC-123.md  ticket=ABC-123
   ```
   (or just `/deliver` and paste the requirement when asked).
3. Copilot walks clarify → design → implement → review → test → build → verify, hard-stopping at
   any BLOCKING question and writing the audit trail to `artifacts/feature/ABC-123/`.
4. Before a PR, run `/self-review`.
5. For a focused deep dive, pick a persona from the chat-mode dropdown (e.g. **security-reviewer**)
   and ask it directly.

## Honesty (carried over verbatim)

- **Gate-green ≠ requirement-complete** — done only when the independent AC cross-check confirms
  every acceptance criterion against the authoritative spec.
- **The authoritative spec governs** — flag spec-vs-code drift; never silently follow the weaker
  source.
- Absent tooling (coverage, SAST) is reported "N/A — not configured", never faked.

> **Status: prototype.** The files are real and load in VS Code Copilot Chat. The end-to-end
> pipeline has been exercised on Python/SQLite features under the Claude plugin; the Copilot
> sequential-session port has not yet been run through a full multi-stack feature. Treat it as a
> working starting point, not a proven-at-scale tool.
