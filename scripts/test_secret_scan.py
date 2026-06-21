"""Tests for the secret-scanning gate (scripts/secret_scan.py)."""

import importlib.util
import io
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("secret_scan", os.path.join(_HERE, "secret_scan.py"))
ss = importlib.util.module_from_spec(_spec)
sys.modules["secret_scan"] = ss
_spec.loader.exec_module(ss)


def _scan(tmp_path, name, content, **kw):
    (tmp_path / name).write_text(content, encoding="utf-8")
    buf = io.StringIO()
    rc = ss.run([str(tmp_path)], stream=buf, **kw)
    return rc, buf.getvalue()


def test_clean_file_is_green(tmp_path):
    rc, out = _scan(tmp_path, "ok.py", "x = 1\napi_key = os.environ['API_KEY']\n")
    assert rc == 0, out
    assert "GREEN" in out


def test_aws_key_is_caught(tmp_path):
    rc, out = _scan(tmp_path, "leak.py", "AWS = 'AKIAIOSFODNN7EXAMPLE'\n")  # pragma: allowlist secret
    assert rc == 1, out
    assert "aws-access-key-id" in out and "RED" in out


def test_private_key_block_is_caught(tmp_path):
    rc, out = _scan(tmp_path, "key.pem", "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n")  # pragma: allowlist secret
    assert rc == 1, out
    assert "private-key-block" in out


def test_high_entropy_secret_assignment_is_caught(tmp_path):
    rc, out = _scan(tmp_path, "cfg.py", "password = 'Gh7Kp2Wq9Lz4Rt8Bx1Vn'\n")  # pragma: allowlist secret
    assert rc == 1, out
    assert "high-entropy-secret" in out


def test_placeholder_is_not_flagged(tmp_path):
    rc, out = _scan(tmp_path, "cfg.py", "password = 'your-password-here'\nsecret = '${SECRET}'\n")
    assert rc == 0, out


def test_allowlist_pragma_suppresses(tmp_path):
    rc, out = _scan(tmp_path, "leak.py", "AWS = 'AKIAIOSFODNN7EXAMPLE'  # pragma: allowlist secret\n")
    assert rc == 0, out


def test_nothing_to_scan_is_usage_error(tmp_path):
    rc = ss.run([str(tmp_path / "does-not-exist")], stream=io.StringIO())
    assert rc == 2
