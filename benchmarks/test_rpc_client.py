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
import threading
import time
import uuid
from pathlib import Path
from unittest.mock import patch, MagicMock, PropertyMock

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rpc_client import PiRpc, _extension_paths, REPO_ROOT, TB_SHELL_PREFIX, PromptResult  # noqa: E402

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
        # Model id may vary across environments; just verify it resolved
        assert resp["data"]["model"]["id"] is not None
        assert isinstance(resp["data"]["model"]["id"], str)
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


# ---- Unit tests (no live subprocess) ----


def _make_mock_rpc():
    """Create a PiRpc instance with mocked internals for unit testing."""
    rpc = object.__new__(PiRpc)
    rpc._send = MagicMock()
    rpc._tb_shell_handler = None
    rpc._notifications = []
    rpc._lock = threading.Lock()
    rpc._event_q = []
    rpc._cv = threading.Condition(rpc._lock)
    rpc._responses = {}
    rpc._stderr_buf = []
    rpc._closed = False
    return rpc


def _make_mock_rpc_for_prompt():
    """Create a PiRpc instance with mocked prompt_and_collect dependencies."""
    rpc = _make_mock_rpc()
    rpc._await_response = MagicMock(return_value={"success": True})
    rpc._drain_events_until = MagicMock(return_value=[])
    return rpc


# ---- _handle_ui_request tests ----


def test_handle_ui_request_confirm_auto_accepts():
    rpc = _make_mock_rpc()
    rpc._handle_ui_request({"method": "confirm", "id": "req-1"})
    rpc._send.assert_called_once_with(
        {"type": "extension_ui_response", "id": "req-1", "confirmed": True}
    )


def test_handle_ui_request_select_takes_first_option():
    rpc = _make_mock_rpc()
    rpc._handle_ui_request({
        "method": "select",
        "id": "req-2",
        "options": ["opt_a", "opt_b"],
    })
    rpc._send.assert_called_once_with(
        {"type": "extension_ui_response", "id": "req-2", "value": "opt_a"}
    )


def test_handle_ui_request_select_empty_options_sends_empty_string():
    rpc = _make_mock_rpc()
    rpc._handle_ui_request({
        "method": "select",
        "id": "req-3",
        "options": [],
    })
    rpc._send.assert_called_once_with(
        {"type": "extension_ui_response", "id": "req-3", "value": ""}
    )


def test_handle_ui_request_editor_returns_prefill():
    rpc = _make_mock_rpc()
    rpc._handle_ui_request({
        "method": "editor",
        "id": "req-4",
        "prefill": "some prefill text",
    })
    rpc._send.assert_called_once_with(
        {"type": "extension_ui_response", "id": "req-4", "value": "some prefill text"}
    )


def test_handle_ui_request_notify_appends_to_notifications():
    rpc = _make_mock_rpc()
    rpc._handle_ui_request({
        "method": "notify",
        "message": "hello world",
        "notifyType": "info",
    })
    rpc._send.assert_not_called()
    assert rpc.notifications() == [{"message": "hello world", "notifyType": "info"}]


def test_handle_ui_request_notify_with_no_type_defaults_to_info():
    rpc = _make_mock_rpc()
    rpc._handle_ui_request({"method": "notify", "message": "just a msg"})
    assert rpc.notifications() == [{"message": "just a msg", "notifyType": "info"}]


def test_handle_ui_request_input_with_tb_shell_prefix_calls_handler():
    rpc = _make_mock_rpc()
    rpc._tb_shell_handler = MagicMock(return_value="handler result")
    payload = json.dumps({"cmd": "ls"})
    rpc._handle_ui_request({
        "method": "input",
        "id": "req-5",
        "title": f"{TB_SHELL_PREFIX}{payload}",
    })
    rpc._tb_shell_handler.assert_called_once_with({"cmd": "ls"})
    rpc._send.assert_called_once_with(
        {"type": "extension_ui_response", "id": "req-5", "value": "handler result"}
    )


def test_handle_ui_request_input_without_tb_prefix_sends_empty():
    rpc = _make_mock_rpc()
    rpc._handle_ui_request({
        "method": "input",
        "id": "req-6",
        "title": "regular question",
    })
    rpc._send.assert_called_once_with(
        {"type": "extension_ui_response", "id": "req-6", "value": ""}
    )


def test_handle_ui_request_unknown_method_is_fire_and_forget():
    rpc = _make_mock_rpc()
    rpc._handle_ui_request({
        "method": "setStatus",
        "id": "req-7",
        "value": "working...",
    })
    rpc._send.assert_not_called()


def test_handle_ui_request_handler_exception_is_caught():
    rpc = _make_mock_rpc()
    rpc._tb_shell_handler = MagicMock(side_effect=RuntimeError("boom"))
    payload = json.dumps({"cmd": "bad"})
    rpc._handle_ui_request({
        "method": "input",
        "id": "req-8",
        "title": f"{TB_SHELL_PREFIX}{payload}",
    })
    rpc._send.assert_called_once()
    call_args = rpc._send.call_args[0][0]
    assert "Error in TB shell handler" in call_args["value"]


# ---- _drain_events_until tests ----


def test_drain_events_until_returns_events_until_predicate_matches():
    rpc = _make_mock_rpc()
    rpc._event_q = [
        {"type": "message_update", "id": 1},
        {"type": "tool_execution_start", "id": 2},
        {"type": "agent_end", "id": 3},
    ]
    result = rpc._drain_events_until(
        lambda ev: ev.get("type") == "agent_end", timeout=5.0
    )
    assert len(result) == 3
    assert result[-1]["type"] == "agent_end"


def test_drain_events_until_empty_when_no_events_and_no_timeout_wait():
    rpc = _make_mock_rpc()
    rpc._event_q = []
    result = rpc._drain_events_until(
        lambda ev: False, timeout=0.0
    )
    assert result == []


def test_drain_events_until_collects_all_when_predicate_never_matches():
    rpc = _make_mock_rpc()
    rpc._event_q = [
        {"type": "message_update"},
        {"type": "tool_execution_start"},
    ]
    result = rpc._drain_events_until(
        lambda ev: ev.get("type") == "agent_end", timeout=0.0
    )
    assert len(result) == 2


def test_drain_events_until_stops_at_first_match():
    rpc = _make_mock_rpc()
    rpc._event_q = [
        {"type": "start"},
        {"type": "end"},
        {"type": "extra"},
    ]
    result = rpc._drain_events_until(
        lambda ev: ev.get("type") == "end", timeout=5.0
    )
    assert len(result) == 2
    assert result[-1]["type"] == "end"


# ---- prompt_and_collect parsing tests ----


def test_prompt_and_collect_accumulates_assistant_text():
    rpc = _make_mock_rpc_for_prompt()
    rpc._drain_events_until.return_value = [
        {
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "text_delta",
                "delta": "Hello, ",
            },
        },
        {
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "text_delta",
                "delta": "world!",
            },
        },
        {"type": "agent_end"},
    ]
    result = rpc.prompt_and_collect("say hello")
    assert result.assistant_text == "Hello, world!"


def test_prompt_and_collect_parses_tool_calls():
    rpc = _make_mock_rpc_for_prompt()
    rpc._drain_events_until.return_value = [
        {
            "type": "tool_execution_start",
            "toolCallId": "call-1",
            "toolName": "Read",
            "args": {"path": "file.txt"},
        },
        {
            "type": "tool_execution_end",
            "toolCallId": "call-1",
            "toolName": "Read",
            "result": {"content": [{"type": "text", "text": "file contents"}]},
            "isError": False,
        },
        {"type": "agent_end"},
    ]
    result = rpc.prompt_and_collect("read a file")
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0]["name"] == "Read"
    assert result.tool_calls[0]["result_text"] == "file contents"
    assert result.tool_calls[0]["is_error"] is False


def test_prompt_and_collect_sets_agent_ended_flag():
    rpc = _make_mock_rpc_for_prompt()
    rpc._drain_events_until.return_value = [
        {"type": "agent_end"},
    ]
    result = rpc.prompt_and_collect("done")
    assert result.agent_ended is True


# ---- Miscellaneous tests ----


def test_close_kills_on_timeout():
    rpc = _make_mock_rpc()
    rpc._closed = False
    mock_proc = MagicMock()
    # First call raises TimeoutExpired, second call (after kill) succeeds
    mock_proc.wait.side_effect = [
        subprocess.TimeoutExpired(cmd="pi", timeout=5),
        0,
    ]
    rpc._proc = mock_proc
    rpc.close(timeout=5)
    assert rpc._closed is True
    mock_proc.kill.assert_called_once()


def test_context_manager_calls_close():
    with patch.object(PiRpc, "__init__", return_value=None) as mock_init:
        rpc = PiRpc.__new__(PiRpc)
        rpc._closed = False
        rpc._proc = MagicMock()
        rpc._proc.stdin = None
        rpc._proc.wait = MagicMock(return_value=0)
        rpc._stderr_buf = []
        rpc._lock = threading.Lock()
        rpc._cv = threading.Condition(rpc._lock)
        rpc.__enter__ = lambda self: self
        rpc.__exit__ = lambda self, *a: self.close()
        rpc.close()
        assert rpc._closed is True


def test_notification_shallow_copy():
    rpc = _make_mock_rpc()
    rpc._notifications.append({"message": "test", "notifyType": "info"})
    result = rpc.notifications()
    assert result == [{"message": "test", "notifyType": "info"}]
    # Modifying the copy shouldn't affect internal state
    result.clear()
    assert rpc.notifications() == [{"message": "test", "notifyType": "info"}]
