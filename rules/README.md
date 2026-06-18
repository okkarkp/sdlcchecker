# Path-scoped rules (starters)

These are **generic starter rules** to copy into a consuming project's `.claude/rules/`.
They are *not* loaded from the plugin — Claude Code loads path-scoped rules from the
project's own `.claude/rules/` directory, on demand when a matching file is touched.

| File | Scope | Use |
|---|---|---|
| `general.md` | `**/*` (all code) | Universal engineering defaults — read-before-write, code-is-source-of-truth, smallest-correct-change, never-log-secrets, entity+migration lockstep, evidence-over-assertion. Apply this everywhere. |
| `backend.md` | one backend module | Coding/api standards, scoped builds, entity + migration together. Edit the `paths:` glob. |
| `frontend.md` | one frontend app | Component/design-token reuse, design-system alignment. Edit the `paths:` glob. |
| `auth.md` | `**/security/**`, `**/auth/**` | Public vs internal path separation, CSRF, token-expiry, no secret logging. |

**To apply `general.md` across *all* your projects by default** (not just per-project): its
guidance is stack-agnostic, so put the same content in your **user-level `~/.claude/CLAUDE.md`**,
which Claude Code loads in every project. (A user-level `.claude/rules/` directory is not a
guaranteed load path; user `CLAUDE.md` is.) Keep the per-area rules (`backend`/`frontend`/`auth`)
per-project, since their globs and doc links are project-specific.

To use (per project):

1. Copy the rule files you want into `<your-project>/.claude/rules/`.
2. Edit the `paths:` globs to match your repo's module/directory layout.
3. Replace the placeholder doc links with your project's real standards docs.

The rules are intentionally thin — their job is to point the agents at the project's
authoritative docs for the paths in question, plus a few "read before you write" reminders.
In a polyrepo or multi-module repo, add one rule file per area (backend / frontend / auth /
…) and scope each `paths:` glob to that area's directories.
