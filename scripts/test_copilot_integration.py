"""Drift guards for the GitHub Copilot port and bundled-script duplication.

These keep the Copilot integration honest against the canonical plugin:
- every agent must have a 1:1 chat-mode persona (a rename mustn't orphan one),
- every chat mode must declare valid Copilot frontmatter, and
- the scripts vendored into the integration must stay byte-identical to the
  canonical ones (they are deliberate copies, not forks).
"""

import filecmp
import os
import re
import glob

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
_COPILOT = os.path.join(_ROOT, "integrations", "github-copilot")
_CHATMODES = os.path.join(_COPILOT, ".github", "chatmodes")

# Tools GitHub Copilot recognises in a chat-mode `tools:` allowlist.
VALID_COPILOT_TOOLS = {
    "codebase", "search", "runCommands", "editFiles", "fetch", "githubRepo",
    "usages", "findTestFiles", "runTests", "terminalLastCommand", "problems",
    "changes",
}


def _agent_names():
    return {
        os.path.splitext(os.path.basename(p))[0]
        for p in glob.glob(os.path.join(_ROOT, "agents", "*.md"))
    }


def _chatmode_names():
    return {
        os.path.basename(p)[: -len(".chatmode.md")]
        for p in glob.glob(os.path.join(_CHATMODES, "*.chatmode.md"))
    }


def _frontmatter(path):
    text = open(path, encoding="utf-8").read()
    m = re.match(r"^---\n(.*?)\n---", text, re.S)
    return m.group(1) if m else None


def test_every_agent_has_a_chatmode():
    """A 1:1 persona map — no agent without a chat mode, no orphan chat mode."""
    agents, modes = _agent_names(), _chatmode_names()
    assert agents, "no canonical agents found"
    assert agents - modes == set(), f"agents missing a chatmode: {sorted(agents - modes)}"
    assert modes - agents == set(), f"chatmodes with no agent: {sorted(modes - agents)}"


def test_chatmodes_have_valid_frontmatter():
    for path in glob.glob(os.path.join(_CHATMODES, "*.chatmode.md")):
        name = os.path.basename(path)
        fm = _frontmatter(path)
        assert fm, f"{name}: missing frontmatter"
        assert "description:" in fm, f"{name}: missing description"
        tools = re.search(r"tools:\s*\[(.*?)\]", fm)
        assert tools, f"{name}: missing tools list"
        toks = [t.strip().strip("'\"") for t in tools.group(1).split(",") if t.strip()]
        bad = [t for t in toks if t not in VALID_COPILOT_TOOLS]
        assert not bad, f"{name}: unknown Copilot tools {bad}"


def test_prompts_have_description():
    prompts = glob.glob(os.path.join(_COPILOT, ".github", "prompts", "*.prompt.md"))
    assert prompts, "no Copilot prompt files found"
    for path in prompts:
        fm = _frontmatter(path)
        assert fm and "description:" in fm, f"{os.path.basename(path)}: missing description"


def test_copilot_instructions_cover_compliance_bands():
    ci = os.path.join(_COPILOT, ".github", "copilot-instructions.md")
    assert os.path.exists(ci), "copilot-instructions.md missing"
    text = open(ci, encoding="utf-8").read()
    missing = [b for b in ("OWASP", "IM8", "PDPA", "WCAG") if b not in text]
    assert not missing, f"copilot-instructions.md missing compliance bands: {missing}"


def test_bundled_scripts_are_in_sync_with_canonical():
    """Vendored copies are deliberate duplicates — they must not silently fork."""
    for script in ("harness.py", "mutation_gate.py"):
        canonical = os.path.join(_ROOT, "scripts", script)
        vendored = os.path.join(_COPILOT, "scripts", script)
        assert os.path.exists(vendored), f"vendored {script} missing"
        assert filecmp.cmp(canonical, vendored, shallow=False), (
            f"{script} has drifted from canonical scripts/{script} — re-copy it"
        )
