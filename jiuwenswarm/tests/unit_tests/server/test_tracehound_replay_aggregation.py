"""TraceHound replay: per-agent LLM usage attribution (team mode)."""
from jiuwenswarm.server.agent_ws_server import AgentWebSocketServer


def _srv() -> AgentWebSocketServer:
    # Skip __init__ (heavy IO setup); _replay_build_turns only uses class attrs.
    return AgentWebSocketServer.__new__(AgentWebSocketServer)


RID = "req_team_turn_1"


def _rec(**kw) -> dict:
    base = {"request_id": RID, "timestamp": 1000.0, "role": "", "event_type": None}
    base.update(kw)
    return base


def test_member_usage_attributed_to_turn_and_agent() -> None:
    records = [
        _rec(role="user", event_type=None, content="plan the trip"),
        _rec(event_type="chat.tool_call", tool_name="fetch_webpage",
             tool_call={"id": "tc1", "name": "fetch_webpage", "arguments": "{}"},
             member_name="prague-foodie"),
        _rec(event_type="chat.tool_result", tool_name="fetch_webpage",
             tool_call_id="tc1", result="success=True", member_name="prague-foodie"),
        _rec(event_type="chat.usage_metadata",
             member_name="prague-foodie",
             metadata={"usage_metadata": {
                 "model_name": "glm-4.7", "input_tokens": 100, "output_tokens": 50,
                 "total_tokens": 150, "cache_tokens": 0, "input_cost": 0.001,
                 "output_cost": 0.002, "total_cost": 0.003, "code": 0, "err_msg": ""},
                 "total_latency_ms": 800.0, "ttft_ms": 300.0, "tpot_ms": 20.0,
                 "result_type": "ok"}),
        _rec(event_type="chat.usage_metadata",
             member_name="prague-foodie",
             metadata={"usage_metadata": {
                 "model_name": "glm-4.7", "input_tokens": 10, "output_tokens": 5,
                 "total_tokens": 15, "cache_tokens": 0, "input_cost": 0.0001,
                 "output_cost": 0.0002, "total_cost": 0.0003, "code": 0, "err_msg": ""},
                 "total_latency_ms": 200.0, "ttft_ms": 100.0, "tpot_ms": 10.0,
                 "result_type": "ok"}),
        _rec(event_type="chat.usage_summary", total_tokens=165,
             member_name="prague-foodie"),
        _rec(event_type="chat.final", role="assistant", content="done"),
    ]
    turns = _srv()._replay_build_turns(records)
    assert len(turns) == 1
    t = turns[0]
    assert t["llm_call_count"] == 2
    assert t["total_tokens"] == 165
    assert abs(t["total_cost"] - 0.0033) < 1e-9
    foodie = next(a for a in t["agent_activity"] if a["name"] == "prague-foodie")
    assert foodie["llm_calls"] == 2
    assert foodie["tokens"] == 165
    assert abs(foodie["cost"] - 0.0033) < 1e-9


def test_single_agent_usage_unattributed_to_agents() -> None:
    records = [
        _rec(role="user", event_type=None, content="hi"),
        _rec(event_type="chat.usage_metadata",
             metadata={"usage_metadata": {
                 "model_name": "glm-4.7", "input_tokens": 1, "output_tokens": 1,
                 "total_tokens": 2, "cache_tokens": 0, "input_cost": 0.0,
                 "output_cost": 0.0, "total_cost": 0.0, "code": 0, "err_msg": ""},
                 "total_latency_ms": 5.0, "ttft_ms": 5.0, "tpot_ms": 5.0,
                 "result_type": "ok"}),
        _rec(event_type="chat.final", role="assistant", content="hello"),
    ]
    turns = _srv()._replay_build_turns(records)
    assert turns[0]["llm_call_count"] == 1
    # Single-agent: no member_name → no agent_activity entries created.
    assert turns[0]["agent_activity"] == []
