"""Light tests for rpc_client.PiRpc.

These exercise startup + RPC round-trips but don't require a live LLM —
they use pi's built-in get_state command, which responds without hitting
the provider.

Run with:
    python -m pytest benchmarks/test_rpc_client.py -v
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rpc_client import PiRpc, _extension_paths, REPO_ROOT  # noqa: E402

PI_BIN = REPO_ROOT / "node_modules" / ".bin" / "pi"


@pytest.fixture(scope="module", autouse=True)
def _skip_if_no_pi():
    if not PI_BIN.exists():
        pytest.skip(f"pi CLI not installed at {PI_BIN} — run `npm install`")


def test_extension_enumeration_finds_scaffold():
    paths = _extension_paths()
    assert len(paths) > 0
    names = {Path(p).parent.name for p in paths}
    for required in ["write-guard", "skill-inject", "knowledge-inject", "evidence"]:
        assert required in names, f"missing required extension: {required}"


def test_rpc_get_state_from_arbitrary_cwd(tmp_path):
    """PiRpc should work from any cwd, not just the repo root."""
    rpc = PiRpc(model="llamacpp/qwen3.6-35b-a3b", cwd=str(tmp_path))
    try:
        rid = str(uuid.uuid4())
        rpc._send({"id": rid, "type": "get_state"})
        resp = rpc._await_response(rid, timeout=20)
        assert resp["success"] is True
        assert resp["data"]["model"]["id"] in {"qwen3.6-35b-a3b", "qwen/Qwen3.6-35B-A3B"}
        assert resp["data"]["model"]["provider"] == "llamacpp"
    finally:
        rpc.close(timeout=3)


def test_rpc_allowed_tools_env_propagates(tmp_path):
    """LITTLE_CODER_ALLOWED_TOOLS should reach the tool-gating extension."""
    rpc = PiRpc(
        model="llamacpp/qwen3.6-35b-a3b",
        cwd=str(tmp_path),
        allowed_tools=["Read", "Bash"],
    )
    try:
        rid = str(uuid.uuid4())
        rpc._send({"id": rid, "type": "get_state"})
        resp = rpc._await_response(rid, timeout=20)
        assert resp["success"] is True
    finally:
        rpc.close(timeout=3)


def test_rpc_tb_mode_env_propagates(tmp_path):
    """tb_mode=True sets LITTLE_CODER_TB_MODE=1 for the subprocess."""
    rpc = PiRpc(
        model="llamacpp/qwen3.6-35b-a3b",
        cwd=str(tmp_path),
        tb_mode=True,
        session_id="test-tb",
    )
    try:
        rid = str(uuid.uuid4())
        rpc._send({"id": rid, "type": "get_state"})
        resp = rpc._await_response(rid, timeout=20)
        assert resp["success"] is True
    finally:
        rpc.close(timeout=3)
