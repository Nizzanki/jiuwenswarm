"""TraceHound replay/turn-aggregation unit tests.

Covers the fix where failed team-mode ``chat.tool_result`` records (result
serialized as a Python-repr string like ``success=False data=None error='...'``)
were invisible to TraceHound: no top-level ``error_type``/``error`` fields and
no ``chat.error`` events, so ``tool_failures`` stayed 0 and the LLM analysis
summary reported zero errors.
"""
from __future__ import annotations

from jiuwenswarm.server.agent_ws_server import AgentWebSocketServer


def _server() -> AgentWebSocketServer:
    """Build an AgentWebSocketServer without running the heavy __init__."""
    return AgentWebSocketServer.__new__(AgentWebSocketServer)


# ── Fixture record builders (shapes copied from the prague-october-trip run) ──


def _user(rid: str, content: str = "find me what to do in Prague", ts: float = 1000.0) -> dict:
    return {
        "role": "user",
        "request_id": rid,
        "content": content,
        "timestamp": ts,
    }


def _tool_call(rid: str, name: str, call_id: str, role: str = "leader", ts: float = 1001.0, **extra: object) -> dict:
    return {
        "role": role,
        "event_type": "chat.tool_call",
        "request_id": rid,
        "tool_name": name,
        "tool_call": {"name": name, "arguments": "{}", "tool_call_id": call_id},
        "mode": "team",
        "timestamp": ts,
        **extra,
    }


def _tool_result(
    rid: str,
    name: str,
    call_id: str,
    result: str,
    role: str = "leader",
    ts: float = 1002.0,
    **extra: object,
) -> dict:
    rec: dict = {
        "role": role,
        "event_type": "chat.tool_result",
        "request_id": rid,
        "tool_name": name,
        "tool_call_id": call_id,
        "result": result,
        "mode": "team",
        "timestamp": ts,
    }
    rec.update(extra)
    return rec


_SUCCESS_RESULT = (
    "success=True data={'file_path': '/tmp/itinerary.md', 'bytes_written': 1234, "
    "'type': 'create', 'created': True, 'original_file': None} error=None"
)

_FAILED_RESULT = (
    'success=False data=None error="Tool execution error: [189001] validate data '
    "with schema failed, error='2 validation errors for DynamicModel\\n"
    "abs_file_path_list\\n  Field required'\""
)

_FAILED_RESULT_EMPTY_ERROR = "success=False data=None error=''"


def _final(rid: str, content: str = "Done.", role: str = "leader", ts: float = 1003.0) -> dict:
    return {
        "role": role,
        "event_type": "chat.final",
        "request_id": rid,
        "content": content,
        "timestamp": ts,
    }


def _tracer_agent_error(rid: str, ts: float = 1002.01) -> dict:
    return {
        "role": "leader",
        "event_type": "chat.tracer_agent",
        "request_id": rid,
        "status": "error",
        "name": "send_file_to_user",
        "error": {
            "error_code": 189001,
            "message": "validate data with schema failed",
        },
        "mode": "team",
        "timestamp": ts,
    }


# ── _tool_result_failed ──────────────────────────────────────────────────────


def test_tool_result_failed_detects_success_false_string() -> None:
    rec = _tool_result("req_1", "send_file_to_user", "call_1", _FAILED_RESULT)
    assert AgentWebSocketServer._tool_result_failed(rec) is True


def test_tool_result_failed_true_for_success_result() -> None:
    rec = _tool_result("req_1", "write_file", "call_1", _SUCCESS_RESULT)
    assert AgentWebSocketServer._tool_result_failed(rec) is False


def test_tool_result_failed_true_when_error_type_field_set() -> None:
    rec = _tool_result(
        "req_1", "write_file", "call_1", _SUCCESS_RESULT,
        error_type="RunError", error="boom",
    )
    assert AgentWebSocketServer._tool_result_failed(rec) is True


def test_tool_result_failed_false_for_non_string_result() -> None:
    rec = _tool_result("req_1", "write_file", "call_1", _SUCCESS_RESULT)
    rec["result"] = {"success": True}
    assert AgentWebSocketServer._tool_result_failed(rec) is False


# ── _tool_result_error_text ──────────────────────────────────────────────────


def test_tool_result_error_text_extracts_double_quoted_error() -> None:
    rec = _tool_result("req_1", "send_file_to_user", "call_1", _FAILED_RESULT)
    text = AgentWebSocketServer._tool_result_error_text(rec)
    assert "validate data with schema failed" in text
    assert "Tool execution error" in text


def test_tool_result_error_text_uses_top_level_error_field() -> None:
    rec = _tool_result(
        "req_1", "write_file", "call_1", _SUCCESS_RESULT,
        error="run failed", error_type="RunError",
    )
    assert AgentWebSocketServer._tool_result_error_text(rec) == "run failed"


def test_tool_result_error_text_empty_for_success() -> None:
    rec = _tool_result("req_1", "write_file", "call_1", _SUCCESS_RESULT)
    assert AgentWebSocketServer._tool_result_error_text(rec) == ""


def test_tool_result_error_text_empty_for_empty_error_repr() -> None:
    rec = _tool_result("req_1", "write_file", "call_1", _FAILED_RESULT_EMPTY_ERROR)
    assert AgentWebSocketServer._tool_result_error_text(rec) == ""


# ── _replay_build_turns ──────────────────────────────────────────────────────


def test_build_turns_counts_failed_tool_result() -> None:
    records = [
        _user("req_1"),
        _tool_call("req_1", "send_file_to_user", "call_1"),
        _tool_result("req_1", "send_file_to_user", "call_1", _FAILED_RESULT),
        _final("req_1"),
    ]
    turns = _server()._replay_build_turns(records)
    assert len(turns) == 1
    turn = turns[0]
    assert turn["tool_failures"] == 1
    assert turn["outcome"] == "completed_with_issues"
    assert "1 tool call failed" in turn["issues"]
    assert turn["has_error"] is False
    assert turn["error_category"] is not None
    assert turn["tool_results_detail"][0]["error_detail"] is not None


def test_build_turns_success_result_not_counted_as_failure() -> None:
    records = [
        _user("req_1"),
        _tool_call("req_1", "write_file", "call_1"),
        _tool_result("req_1", "write_file", "call_1", _SUCCESS_RESULT, role="teammate"),
        _tool_call("req_1", "send_file_to_user", "call_2"),
        _tool_result("req_1", "send_file_to_user", "call_2", _FAILED_RESULT),
        _final("req_1"),
    ]
    turn = _server()._replay_build_turns(records)[0]
    assert turn["tool_failures"] == 1
    assert turn["outcome"] == "completed_with_issues"


def test_build_turns_clean_turn_outcome_completed() -> None:
    records = [
        _user("req_1"),
        _tool_call("req_1", "write_file", "call_1"),
        _tool_result("req_1", "write_file", "call_1", _SUCCESS_RESULT),
        _final("req_1"),
    ]
    turn = _server()._replay_build_turns(records)[0]
    assert turn["tool_failures"] == 0
    assert turn["outcome"] == "completed"
    assert turn["issues"] == []


def test_build_turns_tracer_agent_error_not_double_counted() -> None:
    records = [
        _user("req_1"),
        _tool_call("req_1", "send_file_to_user", "call_1"),
        _tool_result("req_1", "send_file_to_user", "call_1", _FAILED_RESULT),
        _tracer_agent_error("req_1"),
        _final("req_1"),
    ]
    turn = _server()._replay_build_turns(records)[0]
    assert turn["tool_failures"] == 1
    assert turn["has_error"] is False


def test_build_turns_tool_results_detail_marks_failed() -> None:
    records = [
        _user("req_1"),
        _tool_call("req_1", "send_file_to_user", "call_1"),
        _tool_result("req_1", "send_file_to_user", "call_1", _FAILED_RESULT),
        _tool_result("req_1", "write_file", "call_2", _SUCCESS_RESULT),
        _final("req_1"),
    ]
    turn = _server()._replay_build_turns(records)[0]
    details = turn["tool_results_detail"]
    assert details[0]["failed"] is True
    assert details[1]["failed"] is False


def test_build_turns_failed_team_tool_result_is_kept_as_real_turn() -> None:
    records = [
        _user("req_1"),
        _tool_call("req_1", "send_file_to_user", "call_1"),
        _tool_result("req_1", "send_file_to_user", "call_1", _FAILED_RESULT),
    ]
    turns = _server()._replay_build_turns(records)
    assert len(turns) == 1
    assert turns[0]["tool_failures"] == 1


# ── _replay_agent_of ─────────────────────────────────────────────────────────


def test_replay_agent_of_member_via_member_name() -> None:
    rec = _tool_call("req_1", "write_file", "call_1", role="teammate", member_name="prague-foodie")
    assert AgentWebSocketServer._replay_agent_of(rec) == ("prague-foodie", "member")


def test_replay_agent_of_leader_has_no_member_name() -> None:
    rec = _tool_call("req_1", "send_file_to_user", "call_1", role="leader")
    assert AgentWebSocketServer._replay_agent_of(rec) == ("leader", "leader")


def test_replay_agent_of_single_agent_and_user_are_ignored() -> None:
    assistant = _tool_call("req_1", "write_file", "call_1", role="assistant")
    assert AgentWebSocketServer._replay_agent_of(assistant) == ("", "")
    user_rec = {"role": "user", "member_name": "prague-foodie"}
    assert AgentWebSocketServer._replay_agent_of(user_rec) == ("", "")


# ── _replay_build_turns: agent attribution ───────────────────────────────────


def test_build_turns_attributes_tool_details_to_agent() -> None:
    records = [
        _user("req_1"),
        _tool_call("req_1", "write_file", "call_1", role="teammate", member_name="prague-foodie"),
        _tool_result("req_1", "write_file", "call_1", _FAILED_RESULT, role="teammate", member_name="prague-foodie"),
        _tool_call("req_1", "send_file_to_user", "call_2", role="leader"),
        _tool_result("req_1", "send_file_to_user", "call_2", _FAILED_RESULT, role="leader"),
        _final("req_1", role="leader"),
    ]
    turn = _server()._replay_build_turns(records)[0]
    assert turn["tool_calls_detail"][0]["agent"] == "prague-foodie"
    assert turn["tool_calls_detail"][1]["agent"] == "leader"
    assert turn["tool_results_detail"][0]["agent"] == "prague-foodie"
    assert turn["tool_results_detail"][1]["agent"] == "leader"


def test_build_turns_agent_activity_counts_calls_results_failures() -> None:
    records = [
        _user("req_1"),
        _tool_call("req_1", "write_file", "call_1", role="teammate", member_name="prague-foodie"),
        _tool_result("req_1", "write_file", "call_1", _FAILED_RESULT, role="teammate", member_name="prague-foodie"),
        _tool_call("req_1", "send_file_to_user", "call_2", role="leader"),
        _tool_result("req_1", "send_file_to_user", "call_2", _FAILED_RESULT, role="leader"),
        _final("req_1", role="leader"),
    ]
    turn = _server()._replay_build_turns(records)[0]
    by_name = {a["name"]: a for a in turn["agent_activity"]}
    assert by_name["prague-foodie"]["tool_calls"] == 1
    assert by_name["prague-foodie"]["tool_results"] == 1
    assert by_name["prague-foodie"]["tool_failures"] == 1
    assert by_name["leader"]["tool_calls"] == 1
    assert by_name["leader"]["tool_failures"] == 1
    assert by_name["leader"]["responses"] == 1


def test_build_turns_agents_list_leader_first() -> None:
    records = [
        _user("req_1"),
        _tool_call("req_1", "view_task", "call_1", role="teammate", member_name="prague-sightseer"),
        _tool_result("req_1", "view_task", "call_1", _SUCCESS_RESULT, role="teammate", member_name="prague-sightseer"),
        _tool_call("req_1", "build_team", "call_2", role="leader"),
        _tool_result("req_1", "build_team", "call_2", _SUCCESS_RESULT, role="leader"),
        _final("req_1", role="leader"),
    ]
    turn = _server()._replay_build_turns(records)[0]
    assert turn["agents"] == ["leader", "prague-sightseer"]


def test_build_turns_agent_activity_empty_for_single_agent_session() -> None:
    records = [
        _user("req_1"),
        _tool_call("req_1", "write_file", "call_1", role="assistant"),
        _tool_result("req_1", "write_file", "call_1", _SUCCESS_RESULT, role="assistant"),
        _final("req_1", role="assistant"),
    ]
    turn = _server()._replay_build_turns(records)[0]
    assert turn["agents"] == []
    assert turn["agent_activity"] == []
    assert all(d["agent"] is None for d in turn["tool_calls_detail"])
    assert all(d["agent"] is None for d in turn["tool_results_detail"])


# ── _build_analysis_summary ──────────────────────────────────────────────────


def test_analysis_summary_includes_failed_tool_results() -> None:
    records = [
        _user("req_1"),
        _tool_call("req_1", "send_file_to_user", "call_1"),
        _tool_result("req_1", "send_file_to_user", "call_1", _FAILED_RESULT),
        _final("req_1"),
    ]
    summary = AgentWebSocketServer._build_analysis_summary(records)
    assert "Turns with errors: 1" in summary
    assert "ERROR" in summary
    assert "send_file_to_user" in summary
    assert "validate data with schema failed" in summary


def test_analysis_summary_clean_turn_reports_no_errors() -> None:
    records = [
        _user("req_1"),
        _tool_call("req_1", "write_file", "call_1"),
        _tool_result("req_1", "write_file", "call_1", _SUCCESS_RESULT),
        _final("req_1"),
    ]
    summary = AgentWebSocketServer._build_analysis_summary(records)
    assert "Turns with errors: 0" in summary
