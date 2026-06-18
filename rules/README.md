# Path-scoped rules (starters)

These are **generic starter rules** to copy into a consuming project's `.claude/rules/`.
They are *not* loaded from the plugin — Claude Code loads path-scoped rules from the
project's own `.claude/rules/` directory, on demand when a matching file is touched.

To use:

1. Copy the rule files you want into `<your-project>/.claude/rules/`.
2. Edit the `paths:` globs to match your repo's module/directory layout.
3. Replace the placeholder doc links with your project's real standards docs.

The rules are intentionally thin — their job is to point the agents at the project's
authoritative docs for the paths in question, plus a few "read before you write" reminders.
In a polyrepo or multi-module repo, add one rule file per area (backend / frontend / auth /
…) and scope each `paths:` glob to that area's directories.
