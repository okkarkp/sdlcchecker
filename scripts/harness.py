#!/usr/bin/env python3
"""delivery-team verification harness — the ONE place that runs every quality gate.

The whole pipeline verifies a change by calling this single harness. It reads the gate
commands from the project's `.harness.json` (so it is stack-agnostic — the commands come
from the project, never baked in), runs each gate, captures the real output, and reports a
PASS/FAIL summary. It exits non-zero if any *required* gate fails, so the orchestrator's
verify-loop can mechanically tell RED (failed) from GREEN (all passed).

Usage:
    python scripts/harness.py                 # run all gates in .harness.json
    python scripts/harness.py --only test     # run a single gate by name
    python scripts/harness.py -v              # also print the failing gate's output
    python scripts/harness.py --config path   # use a different config file

Config (.harness.json):
    {
      "gates": [
        {"name": "lint",  "cmd": "ruff check .",              "required": true},
        {"name": "types", "cmd": "mypy src",                  "required": false},
        {"name": "test",  "cmd": "pytest -q",                 "required": true},
        {"name": "build", "cmd": "python -m compileall -q src","required": true}
      ]
    }

A gate with "required": false reports `warn` instead of `FAIL` and never turns the run RED.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from typing import Dict, List


def load_config(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        cfg = json.load(fh)
    if not isinstance(cfg, dict) or not isinstance(cfg.get("gates"), list):
        raise ValueError("config must be an object with a 'gates' array")
    for g in cfg["gates"]:
        if not isinstance(g, dict) or "name" not in g or "cmd" not in g:
            raise ValueError("each gate needs a 'name' and a 'cmd'")
    return cfg


def run_gate(gate: dict) -> Dict[str, object]:
    cmd = gate["cmd"]
    start = time.time()
    proc = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return {
        "name": gate["name"],
        "cmd": cmd,
        "required": bool(gate.get("required", True)),
        "ok": proc.returncode == 0,
        "code": proc.returncode,
        "out": proc.stdout,
        "err": proc.stderr,
        "dur": time.time() - start,
    }


def run(config_path: str, only: str | None = None, verbose: bool = False,
        stream=sys.stdout) -> int:
    """Run the harness. Returns 0 (GREEN), 1 (RED), or 2 (config/usage error)."""
    if not os.path.exists(config_path):
        print(f"harness: no config found at '{config_path}'.", file=sys.stderr)
        print("Create a .harness.json listing your project's gate commands "
              "(see templates/harness.example.json).", file=sys.stderr)
        return 2
    try:
        cfg = load_config(config_path)
    except (ValueError, json.JSONDecodeError) as exc:
        print(f"harness: invalid config: {exc}", file=sys.stderr)
        return 2

    gates: List[dict] = cfg["gates"]
    if only is not None:
        gates = [g for g in gates if g["name"] == only]
        if not gates:
            print(f"harness: no gate named '{only}'", file=sys.stderr)
            return 2

    results = [run_gate(g) for g in gates]
    width = max((len(str(r["name"])) for r in results), default=4)

    print(f"\nHARNESS — {len(results)} gate(s)", file=stream)
    failed: List[str] = []
    for r in results:
        if r["ok"]:
            status = "PASS"
        elif r["required"]:
            status = "FAIL"
            failed.append(str(r["name"]))
        else:
            status = "warn"
        print(f"  {str(r['name']):<{width}}  {status}  ({r['dur']:.2f}s)", file=stream)
        if verbose and not r["ok"]:
            tail = (str(r["out"]) + str(r["err"])).strip().splitlines()[-12:]
            for line in tail:
                print(f"      | {line}", file=stream)

    if failed:
        print(f"\nRED — {len(failed)} gate(s) failed: {', '.join(failed)}", file=stream)
        return 1
    print("\nGREEN — all gates passed", file=stream)
    return 0


def main(argv: List[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Run the delivery-team verification harness.")
    ap.add_argument("--config", default=".harness.json", help="path to the gate config")
    ap.add_argument("--only", help="run a single gate by name")
    ap.add_argument("-v", "--verbose", action="store_true", help="print failing gate output")
    args = ap.parse_args(argv)
    return run(args.config, only=args.only, verbose=args.verbose)


if __name__ == "__main__":
    sys.exit(main())
