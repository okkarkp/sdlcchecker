"""Tests for the verification harness (scripts/harness.py)."""

import importlib.util
import io
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("harness", os.path.join(_HERE, "harness.py"))
harness = importlib.util.module_from_spec(_spec)
sys.modules["harness"] = harness
_spec.loader.exec_module(harness)


def _write(tmp_path, gates):
    p = tmp_path / ".harness.json"
    p.write_text(json.dumps({"gates": gates}), encoding="utf-8")
    return str(p)


def test_all_pass_is_green(tmp_path):
    cfg = _write(tmp_path, [
        {"name": "ok1", "cmd": "true"},
        {"name": "ok2", "cmd": "true"},
    ])
    buf = io.StringIO()
    assert harness.run(cfg, stream=buf) == 0
    assert "GREEN" in buf.getvalue()


def test_required_failure_is_red(tmp_path):
    cfg = _write(tmp_path, [
        {"name": "lint", "cmd": "true"},
        {"name": "test", "cmd": "false"},      # required gate fails
    ])
    buf = io.StringIO()
    assert harness.run(cfg, stream=buf) == 1
    out = buf.getvalue()
    assert "RED" in out and "test" in out


def test_optional_failure_does_not_turn_red(tmp_path):
    cfg = _write(tmp_path, [
        {"name": "types", "cmd": "false", "required": False},  # warn, not RED
        {"name": "test", "cmd": "true"},
    ])
    buf = io.StringIO()
    assert harness.run(cfg, stream=buf) == 0
    assert "warn" in buf.getvalue()


def test_only_runs_one_gate(tmp_path):
    cfg = _write(tmp_path, [
        {"name": "lint", "cmd": "false"},      # would fail, but we skip it
        {"name": "test", "cmd": "true"},
    ])
    buf = io.StringIO()
    assert harness.run(cfg, only="test", stream=buf) == 0


def test_missing_config_is_usage_error():
    assert harness.run("/nonexistent/.harness.json") == 2


def test_bad_gate_shape_is_usage_error(tmp_path):
    p = tmp_path / ".harness.json"
    p.write_text(json.dumps({"gates": [{"name": "x"}]}), encoding="utf-8")  # no cmd
    assert harness.run(str(p)) == 2
