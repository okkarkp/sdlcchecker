# scripts/ — maintainer-only, never required to use the plugin

**Nobody using the `delivery-team` plugin ever needs Python.** The plugin itself is pure
markdown (11 agents + 2 commands + templates); Claude Code and GitHub Copilot both run it
with no interpreter, no build step, and no dependency to install. The verify/build stage
always runs the *consuming project's own* build/test/lint commands directly.

| Script | What it does | Who runs it |
|---|---|---|
| `validate_plugin.py` | Validates this repo's own structure — agent frontmatter, tool names, cross-references, template scaffold — before a change to `delivery-team` itself is merged. | **This repo's CI only** (`.github/workflows/validate.yml`). It never ships to, or runs for, anyone installing the plugin. |
| `test_validate_plugin.py`, `test_copilot_integration.py` | The test suite for the validator above (`python3 -m pytest scripts/ -q`). | Same — CI/maintainer only. |

If you're installing or using the plugin, you can ignore this folder entirely — it has no
effect on the pipeline. If you're contributing a change to this repo, run
`python3 scripts/validate_plugin.py` (needs `pip install pyyaml`) before opening a PR.
