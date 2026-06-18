#!/usr/bin/env python3
"""Structural validator for the delivery-team Claude Code plugin.

This plugin ships no executable code — its "feature" is the set of agent
prompts, manifests, templates, and rules. This script is the quality gate that
keeps the *artifact itself* shippable: it fails CI (exit 1) if any manifest is
malformed, any agent frontmatter is invalid, a tool name is unknown, a
cross-reference dangles, or the template scaffold drifts from what the agents
and README promise.

Run locally:   python3 scripts/validate_plugin.py
Dependencies:  PyYAML (pip install pyyaml)

Exit codes: 0 = all checks pass (warnings allowed), 1 = one or more errors.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

try:
    import yaml  # type: ignore
except ImportError:  # pragma: no cover - dependency hint
    sys.stderr.write(
        "ERROR: PyYAML is required to validate agent frontmatter.\n"
        "       Install it with:  pip install pyyaml\n"
    )
    sys.exit(2)

REPO_ROOT = Path(__file__).resolve().parent.parent

# Canonical Claude Code tool names an agent may declare. Anything outside this
# set is almost always a typo (e.g. "Wrtie") that silently disables the agent.
KNOWN_TOOLS = {
    "Agent",
    "Task",
    "Bash",
    "Glob",
    "Grep",
    "Read",
    "Edit",
    "MultiEdit",
    "Write",
    "NotebookEdit",
    "WebFetch",
    "WebSearch",
    "TodoWrite",
}

ALLOWED_MODELS = {"inherit", "sonnet", "opus", "haiku", "fable"}
ALLOWED_MEMORY = {"project", "local"}
REQUIRED_AGENT_KEYS = ("name", "description", "tools", "model")

# The audit-log scaffold every feature run copies. The orchestrator and README
# promise each of these exists; a missing one breaks a live pipeline mid-run.
REQUIRED_FEATURE_FILES = (
    "progress.md",
    "00-clarifications.md",
    "00-stories.md",
    "01-assumptions.md",
    "02-prebrief.md",
    "02-design.md",
    "03-ui-flow.md",
    "04-implementation.md",
    "05-review.md",
    "06-test.md",
)


@dataclass
class Report:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def error(self, msg: str) -> None:
        self.errors.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)


def split_frontmatter(text: str) -> tuple[dict | None, str]:
    """Return (parsed_frontmatter, error_message). frontmatter is None on error."""
    if not text.startswith("---"):
        return None, "no YAML frontmatter (file must start with '---')"
    # Match the first fenced block: --- ... ---
    match = re.match(r"^---\s*\n(.*?)\n---\s*\n", text, re.DOTALL)
    if not match:
        return None, "frontmatter block is not closed with a '---' line"
    try:
        data = yaml.safe_load(match.group(1))
    except yaml.YAMLError as exc:  # pragma: no cover - exercised by malformed input
        return None, f"frontmatter is not valid YAML: {exc}"
    if not isinstance(data, dict):
        return None, "frontmatter did not parse to a mapping"
    return data, ""


def parse_tools(raw) -> list[str]:
    """Agent `tools:` may be a comma-separated string or a YAML list."""
    if isinstance(raw, str):
        return [t.strip() for t in raw.split(",") if t.strip()]
    if isinstance(raw, list):
        return [str(t).strip() for t in raw if str(t).strip()]
    return []


def validate_json_manifests(report: Report) -> dict | None:
    plugin_json = REPO_ROOT / ".claude-plugin" / "plugin.json"
    marketplace_json = REPO_ROOT / ".claude-plugin" / "marketplace.json"

    plugin = None
    if not plugin_json.exists():
        report.error(f"{plugin_json.relative_to(REPO_ROOT)}: missing")
    else:
        try:
            plugin = json.loads(plugin_json.read_text())
        except json.JSONDecodeError as exc:
            report.error(f"{plugin_json.relative_to(REPO_ROOT)}: invalid JSON — {exc}")
        else:
            for key in ("name", "version", "description"):
                if not plugin.get(key):
                    report.error(f"plugin.json: missing or empty '{key}'")
            ver = plugin.get("version", "")
            if ver and not re.match(r"^\d+\.\d+\.\d+", str(ver)):
                report.warn(f"plugin.json: version '{ver}' is not semver-shaped")
            if not plugin.get("keywords"):
                report.warn("plugin.json: no keywords (hurts marketplace discovery)")

    if not marketplace_json.exists():
        report.error(f"{marketplace_json.relative_to(REPO_ROOT)}: missing")
        return plugin

    try:
        market = json.loads(marketplace_json.read_text())
    except json.JSONDecodeError as exc:
        report.error(f"marketplace.json: invalid JSON — {exc}")
        return plugin

    plugins = market.get("plugins")
    if not isinstance(plugins, list) or not plugins:
        report.error("marketplace.json: 'plugins' must be a non-empty list")
        return plugin

    names_in_market = set()
    for entry in plugins:
        name = entry.get("name")
        names_in_market.add(name)
        source = entry.get("source", "")
        if not source:
            report.error(f"marketplace.json: plugin '{name}' has no source")
        else:
            src_path = (REPO_ROOT / source).resolve()
            if not src_path.exists():
                report.error(
                    f"marketplace.json: plugin '{name}' source '{source}' does not exist"
                )

    if plugin and plugin.get("name") not in names_in_market:
        report.error(
            f"marketplace.json: no plugin entry matches plugin.json name "
            f"'{plugin.get('name')}' (found {sorted(names_in_market)})"
        )

    return plugin


def validate_agents(report: Report) -> set[str]:
    agents_dir = REPO_ROOT / "agents"
    agent_names: set[str] = set()
    if not agents_dir.is_dir():
        report.error("agents/ directory is missing")
        return agent_names

    files = sorted(agents_dir.glob("*.md"))
    if not files:
        report.error("agents/ contains no agent definitions")
        return agent_names

    seen: dict[str, Path] = {}
    for path in files:
        rel = path.relative_to(REPO_ROOT)
        fm, err = split_frontmatter(path.read_text())
        if fm is None:
            report.error(f"{rel}: {err}")
            continue

        for key in REQUIRED_AGENT_KEYS:
            if key not in fm or fm[key] in (None, ""):
                report.error(f"{rel}: missing required frontmatter key '{key}'")

        name = fm.get("name")
        if name:
            agent_names.add(name)
            if name != path.stem:
                report.error(
                    f"{rel}: frontmatter name '{name}' does not match filename '{path.stem}'"
                )
            if name in seen:
                report.error(
                    f"{rel}: duplicate agent name '{name}' (also in {seen[name].name})"
                )
            seen[name] = path

        for tool in parse_tools(fm.get("tools")):
            if tool not in KNOWN_TOOLS:
                report.error(
                    f"{rel}: unknown tool '{tool}' "
                    f"(known: {', '.join(sorted(KNOWN_TOOLS))})"
                )

        model = fm.get("model")
        if model and model not in ALLOWED_MODELS and not str(model).startswith("claude-"):
            report.error(
                f"{rel}: model '{model}' is not one of "
                f"{sorted(ALLOWED_MODELS)} or a 'claude-*' id"
            )

        memory = fm.get("memory")
        if memory and memory not in ALLOWED_MEMORY:
            report.error(f"{rel}: memory '{memory}' must be one of {sorted(ALLOWED_MEMORY)}")

    return agent_names


def validate_commands(report: Report) -> None:
    commands_dir = REPO_ROOT / "commands"
    if not commands_dir.is_dir():
        return
    for path in sorted(commands_dir.glob("*.md")):
        rel = path.relative_to(REPO_ROOT)
        fm, err = split_frontmatter(path.read_text())
        if fm is None:
            report.error(f"{rel}: {err}")
            continue
        if not fm.get("description"):
            report.error(f"{rel}: slash command missing 'description' frontmatter")


def validate_cross_references(report: Report, agent_names: set[str]) -> None:
    """Every @agent referenced in the orchestrator must resolve to a real agent."""
    orchestrator = REPO_ROOT / "agents" / "orchestrator.md"
    if not orchestrator.exists():
        report.error("agents/orchestrator.md is missing — it is the pipeline entry point")
        return
    text = orchestrator.read_text()
    mentioned = set(re.findall(r"@([a-z][a-z0-9-]+)", text))
    for ref in sorted(mentioned):
        if ref not in agent_names:
            report.error(
                f"orchestrator.md references @{ref}, which is not a defined agent"
            )


def validate_readme(report: Report, agent_names: set[str]) -> None:
    readme = REPO_ROOT / "README.md"
    if not readme.exists():
        report.error("README.md is missing")
        return
    text = readme.read_text()

    match = re.search(r"roster \((\d+) agents\)", text)
    if match:
        claimed = int(match.group(1))
        if claimed != len(agent_names):
            report.error(
                f"README roster claims {claimed} agents but {len(agent_names)} "
                f"agent files exist"
            )
    else:
        report.warn("README has no '## The roster (N agents)' header to cross-check")

    for name in sorted(agent_names):
        if name not in text:
            report.warn(f"README does not mention agent '{name}'")


def validate_templates(report: Report) -> None:
    feature_dir = REPO_ROOT / "templates" / "feature"
    if not feature_dir.is_dir():
        report.error("templates/feature/ is missing — the audit-log scaffold")
        return
    for name in REQUIRED_FEATURE_FILES:
        path = feature_dir / name
        if not path.exists():
            report.error(f"templates/feature/{name}: missing scaffold file")
        elif not path.read_text().strip():
            report.error(f"templates/feature/{name}: is empty")

    progress = feature_dir / "progress.md"
    if progress.exists():
        body = progress.read_text()
        if "IN PROGRESS" not in body:
            report.error(
                "templates/feature/progress.md: missing the 'IN PROGRESS' resume marker"
            )

    if not (REPO_ROOT / "templates" / "ADR-TEMPLATE.md").exists():
        report.warn("templates/ADR-TEMPLATE.md is missing")


def main() -> int:
    report = Report()

    validate_json_manifests(report)
    agent_names = validate_agents(report)
    validate_commands(report)
    validate_cross_references(report, agent_names)
    validate_readme(report, agent_names)
    validate_templates(report)

    for warning in report.warnings:
        print(f"WARN  {warning}")
    for error in report.errors:
        print(f"ERROR {error}")

    print(
        f"\n{len(agent_names)} agents checked · "
        f"{len(report.errors)} error(s) · {len(report.warnings)} warning(s)"
    )

    if report.errors:
        print("FAILED — fix the errors above before publishing.")
        return 1
    print("OK — plugin structure is valid.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
