"""Tests for the mutation-testing gate (scripts/mutation_gate.py)."""

import importlib.util
import io
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("mutation_gate", os.path.join(_HERE, "mutation_gate.py"))
mg = importlib.util.module_from_spec(_spec)
sys.modules["mutation_gate"] = mg
_spec.loader.exec_module(mg)


def _testcmd(d, body):
    # a python one-liner test that imports calc from dir d
    return f'{sys.executable} -c "import sys;sys.path.insert(0,r\'{d}\');import calc;{body}"'


def test_strong_tests_kill_all_mutants(tmp_path):
    (tmp_path / "calc.py").write_text("def add(a, b):\n    return a + b\n", encoding="utf-8")
    cmd = _testcmd(str(tmp_path), "assert calc.add(2, 3) == 5; assert calc.add(0, 0) == 0")
    buf = io.StringIO()
    rc = mg.run([str(tmp_path / "calc.py")], cmd, threshold=0.8, stream=buf)
    assert rc == 0, buf.getvalue()
    assert "GREEN" in buf.getvalue()


def test_untested_code_leaves_a_survivor(tmp_path):
    (tmp_path / "calc.py").write_text(
        "def add(a, b):\n    return a + b\n\ndef untested(n):\n    return n + 1\n", encoding="utf-8")
    cmd = _testcmd(str(tmp_path), "assert calc.add(2, 3) == 5")  # untested() never exercised
    buf = io.StringIO()
    rc = mg.run([str(tmp_path / "calc.py")], cmd, threshold=0.9, stream=buf)
    assert rc == 1, buf.getvalue()
    out = buf.getvalue()
    assert "survivor" in out and "RED" in out


def test_red_baseline_is_usage_error(tmp_path):
    (tmp_path / "calc.py").write_text("def add(a, b):\n    return a + b\n", encoding="utf-8")
    cmd = _testcmd(str(tmp_path), "assert calc.add(2, 3) == 999")  # baseline already fails
    assert mg.run([str(tmp_path / "calc.py")], cmd) == 2
