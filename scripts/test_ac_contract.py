"""Tests for the executable AC-contract gate (scripts/ac_contract.py)."""

import importlib.util
import io
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("ac_contract", os.path.join(_HERE, "ac_contract.py"))
ac = importlib.util.module_from_spec(_spec)
sys.modules["ac_contract"] = ac
_spec.loader.exec_module(ac)


def test_parse_ac_ids_sorted_unique():
    assert ac.parse_ac_ids("AC2 then AC1 and AC1 again, AC10") == ["AC1", "AC2", "AC10"]


def _story(tmp_path):
    (tmp_path / "story.md").write_text(
        "AC1 new id appends\nAC2 duplicate ignored\nAC3 get returns payload\n", encoding="utf-8")
    return str(tmp_path / "story.md")


def test_all_acs_mapped_and_tests_pass_is_green(tmp_path):
    story = _story(tmp_path)
    tdir = tmp_path / "tests"; tdir.mkdir()
    (tdir / "test_feature.py").write_text(
        "def test_AC1(): assert True\n"
        "def test_AC2(): assert True\n"
        "def test_other():  # covers: AC3\n    assert True\n", encoding="utf-8")
    buf = io.StringIO()
    rc = ac.run(story, [str(tdir)], test_cmd=f"{sys.executable} -c \"pass\"", stream=buf)
    assert rc == 0, buf.getvalue()
    assert "GREEN" in buf.getvalue()


def test_unmapped_ac_is_red_even_if_tests_pass(tmp_path):
    story = _story(tmp_path)
    tdir = tmp_path / "tests"; tdir.mkdir()
    (tdir / "test_feature.py").write_text(
        "def test_AC1(): assert True\ndef test_AC2(): assert True\n", encoding="utf-8")  # AC3 missing
    buf = io.StringIO()
    rc = ac.run(story, [str(tdir)], test_cmd=f"{sys.executable} -c \"pass\"", stream=buf)
    assert rc == 1, buf.getvalue()
    out = buf.getvalue()
    assert "UNMAPPED" in out and "AC3" in out and "RED" in out


def test_mapped_but_failing_suite_is_red(tmp_path):
    story = _story(tmp_path)
    tdir = tmp_path / "tests"; tdir.mkdir()
    (tdir / "test_feature.py").write_text(
        "# AC1 AC2 AC3 all referenced here\n", encoding="utf-8")
    buf = io.StringIO()
    rc = ac.run(story, [str(tdir)], test_cmd=f"{sys.executable} -c \"import sys;sys.exit(1)\"", stream=buf)
    assert rc == 1, buf.getvalue()
    assert "suite is failing" in buf.getvalue()


def test_no_acs_in_file_is_usage_error(tmp_path):
    (tmp_path / "empty.md").write_text("no criteria here\n", encoding="utf-8")
    assert ac.run(str(tmp_path / "empty.md"), [str(tmp_path)], test_cmd=None) == 2
