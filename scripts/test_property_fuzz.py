"""Tests for the tiny property-based / fuzz tester (scripts/property_fuzz.py)."""

import importlib.util
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("property_fuzz", os.path.join(_HERE, "property_fuzz.py"))
pf = importlib.util.module_from_spec(_spec)
sys.modules["property_fuzz"] = pf
_spec.loader.exec_module(pf)


def test_true_property_passes():
    @pf.for_all(pf.lists(pf.ints(0, 1000)), seed=3)
    def prop(xs):
        assert sorted(sorted(xs)) == sorted(xs)
    assert prop() is True


def test_false_property_raises():
    @pf.for_all(pf.ints(0, 1000), seed=3)
    def prop(n):
        assert n < -1                       # impossible for a non-negative draw
    try:
        prop()
    except AssertionError as exc:
        assert "failed for" in str(exc)
    else:
        raise AssertionError("expected the property to fail")


def test_shrinks_list_to_minimal_counterexample():
    @pf.for_all(pf.lists(pf.ints(0, 9), max_len=8), seed=2)
    def prop(xs):
        assert len(xs) < 3                  # any length-3+ list violates this
    try:
        prop()
    except AssertionError as exc:
        # minimal failing list is exactly three zeros
        assert "[0, 0, 0]" in str(exc), str(exc)
    else:
        raise AssertionError("expected the property to fail")


def test_shrinks_int_toward_boundary():
    @pf.for_all(pf.ints(0, 100000), seed=5)
    def prop(n):
        assert n < 100
    try:
        prop()
    except AssertionError as exc:
        # shrinks to the smallest still-failing int; should be right at the boundary
        num = int("".join(ch for ch in str(exc) if ch.isdigit()))
        assert 100 <= num <= 128, str(exc)
    else:
        raise AssertionError("expected the property to fail")


def test_self_test_entrypoint_passes():
    import io
    assert pf._self_test(stream=io.StringIO()) == 0
