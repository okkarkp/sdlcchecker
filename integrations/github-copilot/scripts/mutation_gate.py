#!/usr/bin/env python3
"""Mutation-testing gate — checks that the project's TESTS are actually strong.

A green test suite only proves the tests *pass*, not that they would *catch a bug*. This gate
makes tiny semantic edits to the source (swap +/-, ==/!=, and/or, True/False, < / <= …), runs
the test command for each, and checks the tests FAIL. A surviving mutant = a change no test
caught = a real gap in the tests. It prints a mutation score and exits non-zero below the
threshold, so it plugs into the verification harness like any other gate.

Python is mutated via the **AST** (accurate — never touches operators inside strings/comments).
Other languages fall back to a conservative textual mutator. For production at scale, point a
harness gate at a language-native tool instead — mutmut (Python), Stryker (JS/TS), Pitest
(JVM) — and keep this as the zero-setup fallback. Naive mutation testing still has two limits:
*equivalent mutants* (a change that can't alter behaviour) understate the score, and a mutant
that breaks compilation counts as "killed".

Usage:
    python scripts/mutation_gate.py --src src/eventlog --test "pytest -q" --threshold 0.8
"""

from __future__ import annotations

import argparse
import ast
import glob
import os
import random
import subprocess
import sys
from typing import List, Optional, Tuple

TEXT_MUTATIONS = [
    (" + ", " - "), (" - ", " + "), (" * ", " / "),
    (" == ", " != "), (" != ", " == "),
    (" < ", " <= "), (" <= ", " < "), (" > ", " >= "), (" >= ", " > "),
    (" and ", " or "), (" or ", " and "),
    ("True", "False"), ("False", "True"),
]
_PY_BINOP = {ast.Add: ast.Sub, ast.Sub: ast.Add, ast.Mult: ast.Div, ast.Div: ast.Mult}
_PY_CMP = {ast.Lt: ast.LtE, ast.LtE: ast.Lt, ast.Gt: ast.GtE, ast.GtE: ast.Gt,
           ast.Eq: ast.NotEq, ast.NotEq: ast.Eq}
_EXTS = {"py", "js", "ts", "java", "cs", "go", "rb", "kt"}


def _sites(tree):
    out = []
    for node in ast.walk(tree):
        if isinstance(node, ast.BinOp) and type(node.op) in _PY_BINOP:
            out.append(("binop", node))
        elif isinstance(node, ast.Compare) and len(node.ops) == 1 and type(node.ops[0]) in _PY_CMP:
            out.append(("cmp", node))
        elif isinstance(node, ast.BoolOp):
            out.append(("bool", node))
        elif isinstance(node, ast.Constant) and isinstance(node.value, bool):
            out.append(("const", node))
    return out


def _py_mutants(src: str) -> Optional[List[Tuple[str, str]]]:
    """AST mutants for Python source, or None to signal 'fall back to textual'."""
    if not hasattr(ast, "unparse"):
        return None
    try:
        n = len(_sites(ast.parse(src)))
    except SyntaxError:
        return None
    out = []
    for i in range(n):
        tree = ast.parse(src)
        kind, node = _sites(tree)[i]
        if kind == "binop":
            old = type(node.op).__name__; node.op = _PY_BINOP[type(node.op)](); new = type(node.op).__name__
        elif kind == "cmp":
            old = type(node.ops[0]).__name__; node.ops[0] = _PY_CMP[type(node.ops[0])](); new = type(node.ops[0]).__name__
        elif kind == "bool":
            old = type(node.op).__name__; node.op = ast.Or() if isinstance(node.op, ast.And) else ast.And(); new = type(node.op).__name__
        else:
            old = node.value; node.value = not node.value; new = node.value
        ln = getattr(node, "lineno", "?")
        try:
            out.append((ast.unparse(tree), f"L{ln} {old}->{new}"))
        except Exception:
            return None
    return out


def _text_mutants(src: str) -> List[Tuple[str, str]]:
    lines = src.split("\n")
    out = []
    for i, line in enumerate(lines):
        st = line.strip()
        if not st or st.startswith(("#", "//", "*")):
            continue
        for a, b in TEXT_MUTATIONS:
            if a in line:
                mutated = "\n".join(lines[:i] + [line.replace(a, b, 1)] + lines[i + 1:])
                out.append((mutated, f"L{i + 1} {a.strip()}->{b.strip()}"))
    return out


def _collect(src_paths: List[str]) -> List[str]:
    files: List[str] = []
    for sp in src_paths:
        files += glob.glob(os.path.join(sp, "**", "*.*"), recursive=True) if os.path.isdir(sp) else glob.glob(sp)
    out = []
    for f in files:
        ext = f.rsplit(".", 1)[-1] if "." in f else ""
        if ext in _EXTS and "test" not in os.path.basename(f).lower():
            out.append(f)
    return sorted(set(out))


def run(src_paths, test_cmd, threshold=0.8, max_mutants=40, seed=0, timeout=60, stream=sys.stdout) -> int:
    # Force fresh compilation each run: otherwise Python's .pyc cache (keyed on mtime) can serve a
    # previous mutant's bytecode when files are rewritten within the same second.
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    try:
        base = subprocess.run(test_cmd, shell=True, capture_output=True, text=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        print("mutation-gate: baseline test run timed out.", file=sys.stderr)
        return 2
    if base.returncode != 0:
        print("mutation-gate: baseline tests are RED — fix the tests first.", file=sys.stderr)
        return 2

    file_orig = {}
    mutants = []
    for f in _collect(src_paths):
        src = open(f, encoding="utf-8").read()
        file_orig[f] = src
        ms = _py_mutants(src) if f.endswith(".py") else None
        if ms is None:
            ms = _text_mutants(src)
        for (msrc, desc) in ms:
            mutants.append((f, msrc, desc))

    if not mutants:
        print("mutation-gate: no mutable code found.", file=stream)
        return 0
    random.seed(seed)
    random.shuffle(mutants)
    mutants = mutants[:max_mutants]

    killed = 0
    survived = []
    try:
        for (f, msrc, desc) in mutants:
            open(f, "w", encoding="utf-8").write(msrc)
            try:
                r = subprocess.run(test_cmd, shell=True, capture_output=True, text=True, timeout=timeout, env=env)
                dead = r.returncode != 0
            except subprocess.TimeoutExpired:
                dead = True  # a mutant that hangs is caught by the timeout
            finally:
                open(f, "w", encoding="utf-8").write(file_orig[f])
            if dead:
                killed += 1
            else:
                survived.append((f, desc))
    finally:
        for f, orig in file_orig.items():  # belt-and-braces restore
            open(f, "w", encoding="utf-8").write(orig)

    total = len(mutants)
    score = killed / total
    print(f"\nMUTATION GATE — {total} mutant(s) tested", file=stream)
    print(f"  killed    {killed}", file=stream)
    print(f"  survived  {len(survived)}", file=stream)
    for (f, desc) in survived[:12]:
        print(f"     survivor  {f}  ({desc}) — no test caught this change", file=stream)
    print(f"  score     {score:.0%}   (threshold {threshold:.0%})", file=stream)
    if score < threshold:
        print(f"\nRED — mutation score {score:.0%} below {threshold:.0%}: the tests are too weak.", file=stream)
        return 1
    print(f"\nGREEN — the tests killed {score:.0%} of mutants.", file=stream)
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Mutation-testing gate for the verification harness.")
    ap.add_argument("--src", nargs="+", required=True, help="source files/dirs to mutate")
    ap.add_argument("--test", required=True, help="the test command to run per mutant")
    ap.add_argument("--threshold", type=float, default=0.8, help="min mutation score (0-1)")
    ap.add_argument("--max-mutants", type=int, default=40, help="cap mutants for speed")
    ap.add_argument("--timeout", type=int, default=60, help="per-mutant test timeout (s)")
    a = ap.parse_args(argv)
    return run(a.src, a.test, a.threshold, a.max_mutants, timeout=a.timeout)


if __name__ == "__main__":
    sys.exit(main())
