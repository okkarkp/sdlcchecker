"""Contract tests for the plugin validator (scripts/validate_plugin.py).

These guard against drift that the validator's own structural checks don't
fully cover: that the plugin actually passes its own gate, and that every
external file the agent prompts point to (scripts, standards, templates) really
exists on disk. An agent that references a script or standard that was renamed
or deleted is silently broken at runtime — these tests catch that in CI.
"""

import importlib.util
import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
_spec = importlib.util.spec_from_file_location(
    "validate_plugin", os.path.join(_HERE, "validate_plugin.py")
)
vp = importlib.util.module_from_spec(_spec)
sys.modules["validate_plugin"] = vp
_spec.loader.exec_module(vp)

AGENTS_DIR = os.path.join(_ROOT, "agents")


def _agent_text(name):
    with open(os.path.join(AGENTS_DIR, f"{name}.md"), encoding="utf-8") as fh:
        return fh.read()


def _all_agent_names():
    return {
        f[:-3]
        for f in os.listdir(AGENTS_DIR)
        if f.endswith(".md")
    }


def test_plugin_passes_its_own_validator():
    """The shipped plugin must pass `validate_plugin.main()` with exit 0."""
    assert vp.main() == 0


def test_validate_agents_reports_no_errors():
    report = vp.Report()
    names = vp.validate_agents(report)
    assert report.errors == [], report.errors
    assert names, "no agents discovered"


def test_expected_agent_roster_present():
    """The 11 pipeline agents the orchestrator drives must all exist."""
    expected = {
        "requirements-analyst",
        "solution-architect",
        "frontend-designer",
        "backend-developer",
        "frontend-developer",
        "db-migration-engineer",
        "code-reviewer",
        "security-reviewer",
        "test-engineer",
        "devops-engineer",
        "orchestrator",
    }
    assert expected <= _all_agent_names()


def test_every_orchestrator_agent_reference_resolves():
    """No @agent the orchestrator spawns may dangle."""
    text = _agent_text("orchestrator")
    referenced = set(re.findall(r"@([a-z][a-z0-9-]+)", text))
    missing = referenced - _all_agent_names()
    assert not missing, f"orchestrator references undefined agents: {sorted(missing)}"


def test_agent_referenced_scripts_exist():
    """Any scripts/<name>.py an agent names must exist on disk."""
    missing = []
    for name in _all_agent_names():
        for script in re.findall(r"scripts/([A-Za-z0-9_]+\.py)", _agent_text(name)):
            if not os.path.exists(os.path.join(_ROOT, "scripts", script)):
                missing.append(f"{name}.md -> scripts/{script}")
    assert not missing, f"agents reference missing scripts: {missing}"


def test_agent_referenced_standards_exist():
    """Any standards/<name>.md fallback baseline an agent names must exist."""
    missing = []
    for name in _all_agent_names():
        for doc in re.findall(r"standards/([A-Za-z0-9_-]+\.md)", _agent_text(name)):
            if not os.path.exists(os.path.join(_ROOT, "standards", doc)):
                missing.append(f"{name}.md -> standards/{doc}")
    assert not missing, f"agents reference missing standards: {missing}"


def test_feature_template_scaffold_is_complete():
    report = vp.Report()
    vp.validate_templates(report)
    assert report.errors == [], report.errors
