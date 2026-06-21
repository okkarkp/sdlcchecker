# scripts/ — optional power-ups (not required)

**The pipeline does not need anything in this folder.** The delivery-team plugin is pure
markdown (agents + commands); Claude Code runs it with no Python and no build step. These
scripts are optional conveniences — use them if they help, skip them otherwise.

| Script | What it does | Needed? |
|---|---|---|
| `harness.py` | One command that runs your project's gates from `.harness.json` and returns RED/GREEN. | **Optional.** Without it, the devops agent just runs your project's own verify command (`make verify` / `dotnet test` / `npm run check`) directly. |
| `mutation_gate.py` | Checks your *tests* are strong (edits code, confirms a test fails). | **Optional.** Prefer mutmut / Stryker / Pitest at scale. |
| `secret_scan.py` | Fails the build if a credential looks committed (cloud keys, private keys, provider tokens, high-entropy secrets). | **Optional.** Prefer gitleaks / trufflehog at scale; this is the zero-setup default. |
| `property_fuzz.py` | A tiny dependency-free property-based / fuzz tester with shrinking — `import for_all, ints, lists, text` in your tests. | **Optional.** Graduate to Hypothesis for stateful/model-based testing. |
| `ac_contract.py` | Makes "done" decidable: every acceptance criterion must be referenced by a test **and** the suite must pass, else RED. | **Optional but recommended** — mechanises the "gate-green ≠ requirement-complete" rule. |
| `validate_plugin.py` | Validates the plugin's own structure. | **Maintainer / CI only.** |

All of these need **Python 3**. If a machine has no Python (e.g. a BA laptop), you can still use the
full pipeline — just let the verify step run the project's existing test/build command instead of
`harness.py`. The harness is a uniform wrapper, not a dependency. The assurance gates above plug
into `.harness.json` (see `templates/harness.example.json` → `_assurance_gates`); keep them
`required: false` until the suite is mature, then promote.
