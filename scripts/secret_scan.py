#!/usr/bin/env python3
"""Secret-scanning gate — fails the build if a credential looks committed.

Dependency-free, high-precision scan for committed secrets: cloud keys, private-key
blocks, provider tokens (GitHub / Slack / Stripe / Google), and high-entropy values
assigned to secret-named variables. It is deliberately conservative (precision over
recall) so it can sit in the verify-loop without crying wolf, and it exits non-zero on a
finding so it plugs into the harness like any other gate. Suppress a known-safe match with
an inline `pragma: allowlist secret` comment. For deep coverage at scale, point a harness
gate at gitleaks / trufflehog and keep this as the zero-setup default.

Usage:
    python scripts/secret_scan.py                  # scan the repo (cwd)
    python scripts/secret_scan.py src tests         # scan specific paths
    python scripts/secret_scan.py --entropy 4.0     # tune the entropy floor
    python scripts/secret_scan.py -v                # show the (redacted) match
"""

from __future__ import annotations

import argparse
import math
import os
import re
import sys
from typing import Dict, List, Tuple

# High-precision provider patterns: each match is almost certainly a real credential.
PROVIDER_RULES: List[Tuple[str, "re.Pattern[str]"]] = [
    ("aws-access-key-id", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("private-key-block", re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----")),
    ("github-token", re.compile(r"\bgh[poprs]_[A-Za-z0-9]{36}\b")),
    ("slack-token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b")),
    ("stripe-secret-key", re.compile(r"\bsk_live_[A-Za-z0-9]{16,}\b")),
    ("google-api-key", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
    ("slack-webhook", re.compile(r"https://hooks\.slack\.com/services/[A-Za-z0-9/]{20,}")),
]

# Generic: a secret-named variable assigned a quoted literal value.
_SECRET_NAME = r"(?:password|passwd|secret|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|private[_-]?key|auth[_-]?token|token)"
GENERIC_RULE = re.compile(
    rf"(?i)\b{_SECRET_NAME}\b\s*[:=]\s*['\"]([^'\"]{{8,}})['\"]"
)

# Values that look like placeholders, references, or templates — never real secrets.
_PLACEHOLDER = re.compile(
    r"(?i)(\$\{|\{\{|%\(|<[a-z]|os\.environ|getenv|process\.env|your[_-]|example|changeme|placeholder|redacted|dummy|sample|xxx+|\*\*\*|\.\.\.)"
)

_ALLOWLIST = re.compile(r"(?i)(pragma:\s*allowlist secret|allowlist[- ]secret|noqa:\s*secret|gitleaks:allow)")

_SKIP_DIRS = {".git", "node_modules", "dist", "build", ".venv", "venv", "__pycache__",
              "vendor", ".mypy_cache", ".pytest_cache", "target", ".idea", ".gradle"}
_SKIP_EXT = {"png", "jpg", "jpeg", "gif", "ico", "pdf", "zip", "gz", "tar", "jar",
             "class", "pyc", "woff", "woff2", "ttf", "eot", "lock", "min.js", "map"}


def shannon_entropy(s: str) -> float:
    if not s:
        return 0.0
    counts: Dict[str, int] = {}
    for ch in s:
        counts[ch] = counts.get(ch, 0) + 1
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in counts.values())


def _iter_files(paths: List[str]):
    for root in paths:
        if os.path.isfile(root):
            yield root
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]
            for name in filenames:
                ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
                if ext in _SKIP_EXT:
                    continue
                yield os.path.join(dirpath, name)


def _looks_secret(value: str, entropy_floor: float) -> bool:
    """A generic quoted value is a secret only if it's high-entropy and not a placeholder."""
    if _PLACEHOLDER.search(value):
        return False
    if len(set(value)) <= 3:                       # 'aaaaaaaa', '--------'
        return False
    if not (re.search(r"[A-Za-z]", value) and re.search(r"[0-9]", value)):
        return False                               # require mixed letters+digits
    return shannon_entropy(value) >= entropy_floor


def _redact(s: str) -> str:
    s = s.strip()
    if len(s) <= 8:
        return s[:2] + "***"
    return s[:4] + "***" + s[-2:]


def scan_text(text: str, entropy_floor: float) -> List[Tuple[int, str, str]]:
    """Return (lineno, rule, redacted_match) findings for one file's text."""
    findings: List[Tuple[int, str, str]] = []
    for i, line in enumerate(text.splitlines(), start=1):
        if _ALLOWLIST.search(line):
            continue
        for rule, pat in PROVIDER_RULES:
            m = pat.search(line)
            if m:
                findings.append((i, rule, _redact(m.group(0))))
        gm = GENERIC_RULE.search(line)
        if gm and _looks_secret(gm.group(1), entropy_floor):
            findings.append((i, "high-entropy-secret", _redact(gm.group(1))))
    return findings


def run(paths: List[str], entropy_floor: float = 3.5, verbose: bool = False,
        stream=sys.stdout) -> int:
    """Scan paths. Returns 0 (clean), 1 (secrets found), or 2 (nothing to scan)."""
    paths = paths or ["."]
    self_path = os.path.abspath(__file__)
    scanned = 0
    all_findings: List[Tuple[str, int, str, str]] = []
    for fp in _iter_files(paths):
        if os.path.abspath(fp) == self_path:        # don't flag our own rule strings
            continue
        try:
            with open(fp, "rb") as fh:
                raw = fh.read()
            if b"\x00" in raw:                       # binary
                continue
            text = raw.decode("utf-8", errors="replace")
        except OSError:
            continue
        scanned += 1
        for lineno, rule, red in scan_text(text, entropy_floor):
            all_findings.append((fp, lineno, rule, red))

    if scanned == 0:
        print("secret-scan: no files to scan.", file=sys.stderr)
        return 2

    print(f"\nSECRET SCAN — {scanned} file(s) scanned", file=stream)
    if not all_findings:
        print("\nGREEN — no secrets detected.", file=stream)
        return 0
    for fp, lineno, rule, red in all_findings:
        line = f"  {fp}:{lineno}  {rule}"
        if verbose:
            line += f"  [{red}]"
        print(line, file=stream)
    print(f"\nRED — {len(all_findings)} potential secret(s) found. "
          f"Move them to a secret manager / env, or add a 'pragma: allowlist secret' "
          f"comment if it's a false positive.", file=stream)
    return 1


def main(argv: "List[str] | None" = None) -> int:
    ap = argparse.ArgumentParser(description="Scan for committed secrets (verification gate).")
    ap.add_argument("paths", nargs="*", help="files/dirs to scan (default: cwd)")
    ap.add_argument("--entropy", type=float, default=3.5, help="entropy floor for generic secrets")
    ap.add_argument("-v", "--verbose", action="store_true", help="show the redacted match")
    a = ap.parse_args(argv)
    return run(a.paths, entropy_floor=a.entropy, verbose=a.verbose)


if __name__ == "__main__":
    sys.exit(main())
