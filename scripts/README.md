# scripts/ — optional power-ups (not required)

**The pipeline does not need anything in this folder.** The delivery-team plugin is pure
markdown (agents + commands); Claude Code runs it with no Python and no build step. These
scripts are optional conveniences — use them if they help, skip them otherwise.

| Script | What it does | Needed? |
|---|---|---|
| `harness.py` | One command that runs your project's gates from `.harness.json` and returns RED/GREEN. | **Optional.** Without it, the devops agent just runs your project's own verify command (`make verify` / `dotnet test` / `npm run check`) directly. |
| `mutation_gate.py` | Checks your *tests* are strong (edits code, confirms a test fails). | **Optional.** Prefer mutmut / Stryker / Pitest at scale. |
| `validate_plugin.py` | Validates the plugin's own structure. | **Maintainer / CI only.** |

All three need **Python 3**. If a machine has no Python (e.g. a BA laptop), you can still use the
full pipeline — just let the verify step run the project's existing test/build command instead of
`harness.py`. The harness is a uniform wrapper, not a dependency.
