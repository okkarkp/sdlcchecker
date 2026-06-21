#!/usr/bin/env python3
"""Executable acceptance-criteria contract — makes "done" decidable, not asserted.

Parses the acceptance-criteria IDs (AC1, AC2, …) from a story / AC file, scans the test
files to see which ACs a test actually references, then runs the test command. The contract
is satisfied (GREEN) only when **(a) every AC is mapped to at least one test AND (b) the
suite passes**. An AC with no covering test is an UNMAPPED AC — the gate goes RED even when
the tests are green. That is the project's core rule — "gate-green != requirement-complete"
— turned into a mechanical check the verify-loop can run.

Tag a test with the AC it covers by naming or annotating it with the AC id, e.g.
    def test_AC2_duplicate_is_ignored(): ...        # name carries the id
    def test_dupes():  # covers: AC2, AC3
        ...

Usage:
    python scripts/ac_contract.py --ac docs/stories/SBX-2.md --tests tests --test "pytest -q"
    python scripts/ac_contract.py --ac story.md --tests tests --no-run     # mapping only
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from typing import Dict, List, Tuple

_AC = re.compile(r"\bAC(\d+)\b")
_TEST_FILE = re.compile(r"(?i)(^test_|_test\.|\.test\.|\.spec\.|tests?\.)")


def parse_ac_ids(text: str) -> List[str]:
    nums = {int(m.group(1)) for m in _AC.finditer(text)}
    return [f"AC{n}" for n in sorted(nums)]


def _iter_test_files(paths: List[str]):
    for root in paths:
        if os.path.isfile(root):
            yield root
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in {".git", "__pycache__", "node_modules"}]
            for name in filenames:
                if name.endswith((".py", ".js", ".ts", ".tsx", ".java", ".cs", ".go", ".rb")):
                    if _TEST_FILE.search(name) or "test" in dirpath.lower():
                        yield os.path.join(dirpath, name)


def map_coverage(ac_ids: List[str], test_paths: List[str]) -> Dict[str, List[str]]:
    """Return {ac_id: [files that reference it]}."""
    cover: Dict[str, List[str]] = {ac: [] for ac in ac_ids}
    # match e.g. AC2 in "test_AC2" or "covers: AC2", but never AC2 inside AC20:
    # not preceded by an alnum (underscores/space/punctuation are fine), not followed by a digit.
    wanted = {ac: re.compile(rf"(?<![A-Za-z0-9]){ac}(?![0-9])") for ac in ac_ids}
    for fp in _iter_test_files(test_paths):
        try:
            text = open(fp, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        for ac, pat in wanted.items():
            if pat.search(text):
                cover[ac].append(fp)
    return cover


def run(ac_file: str, test_paths: List[str], test_cmd: "str | None",
        stream=sys.stdout) -> int:
    """Returns 0 (GREEN), 1 (RED — unmapped AC or failing tests), 2 (usage error)."""
    if not os.path.exists(ac_file):
        print(f"ac-contract: AC file not found: {ac_file}", file=sys.stderr)
        return 2
    ac_ids = parse_ac_ids(open(ac_file, encoding="utf-8", errors="replace").read())
    if not ac_ids:
        print(f"ac-contract: no acceptance-criteria ids (AC1, AC2, …) found in {ac_file}",
              file=sys.stderr)
        return 2

    cover = map_coverage(ac_ids, test_paths or ["."])
    unmapped = [ac for ac in ac_ids if not cover[ac]]

    print(f"\nAC CONTRACT — {len(ac_ids)} acceptance criteria", file=stream)
    width = max(len(ac) for ac in ac_ids)
    for ac in ac_ids:
        files = cover[ac]
        if files:
            where = os.path.basename(files[0]) + (f" +{len(files) - 1}" if len(files) > 1 else "")
            print(f"  {ac:<{width}}  mapped    {where}", file=stream)
        else:
            print(f"  {ac:<{width}}  UNMAPPED  no test references this AC", file=stream)

    tests_ok = True
    if test_cmd:
        proc = subprocess.run(test_cmd, shell=True, capture_output=True, text=True)
        tests_ok = proc.returncode == 0
        print(f"  suite     {'PASS' if tests_ok else 'FAIL'}  ({test_cmd})", file=stream)

    if unmapped:
        print(f"\nRED — {len(unmapped)} unmapped AC(s): {', '.join(unmapped)}. "
              f"Every acceptance criterion needs at least one test that references it.",
              file=stream)
        return 1
    if not tests_ok:
        print("\nRED — all ACs are mapped, but the test suite is failing.", file=stream)
        return 1
    print(f"\nGREEN — every AC is mapped to a test"
          f"{' and the suite passes' if test_cmd else ''}.", file=stream)
    return 0


def main(argv: "List[str] | None" = None) -> int:
    ap = argparse.ArgumentParser(description="Executable acceptance-criteria contract gate.")
    ap.add_argument("--ac", required=True, help="story / AC file containing AC1, AC2, … ids")
    ap.add_argument("--tests", nargs="+", default=["tests"], help="test files/dirs to scan")
    ap.add_argument("--test", help="test command to run (omit with --no-run for mapping only)")
    ap.add_argument("--no-run", action="store_true", help="check mapping only; don't run tests")
    a = ap.parse_args(argv)
    return run(a.ac, a.tests, None if a.no_run else a.test)


if __name__ == "__main__":
    sys.exit(main())
