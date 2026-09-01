"""Team-mode LLM usage mirror: normalization + per-member summary + history filter."""
from types import SimpleNamespace

from jiuwenswarm.server.runtime.agent_adapter.team_helpers import (
    _accumulate_team_usage,
    _build_team_usage_summary_payload,
    _team_llm_usage_metadata_payload,
)
from jiuwenswarm.server.runtime.session.session_history import (
    _has_persistable_assistant_payload,
)


def _usage_chunk(*, member: str | None = None, role: str | None = None):
    return SimpleNamespace(
        type="llm_usage",
        payload={
            "usage_metadata": {
                "model_name": "glm-4.7",
                "input_tokens": 100,
                "output_tokens": 50,
                "total_tokens": 150,
                "cache_tokens": 0,
                "input_cost": 0.001,
                "output_cost": 0.002,
                "total_cost": 0.003,
                "code": 0,
                "err_msg": "",
            },
            "result_type": "answer",
            "total_latency_ms": 800.0,
            "ttft_ms": 300.0,
            "tpot_ms": 20.0,
        },
        source_member=member,
        role=role,
    )


def test_llm_usage_normalized_to_usage_metadata_for_teammate() -> None:
    parsed = _team_llm_usage_metadata_payload(
        _usage_chunk(member="prague-foodie", role="teammate"),
        session_id="team_sid",
        is_leader=False,
        is_teammate=True,
    )
    assert parsed["event_type"] == "chat.usage_metadata"
    assert parsed["session_id"] == "team_sid"
    assert parsed["member_name"] == "prague-foodie"
    assert parsed["role"] == "teammate"
    assert parsed["metadata"]["usage_metadata"]["total_tokens"] == 150


def test_llm_usage_normalized_for_leader_without_member_name() -> None:
    parsed = _team_llm_usage_metadata_payload(
        _usage_chunk(role="leader"),
        session_id="team_sid",
        is_leader=True,
        is_teammate=False,
    )
    assert parsed["event_type"] == "chat.usage_metadata"
    assert parsed["role"] == "leader"
    assert not parsed.get("member_name")


def test_usage_accumulation_and_summary_payload() -> None:
    accumulator: dict[str, dict] = {}
    for _ in range(2):
        parsed = _team_llm_usage_metadata_payload(
            _usage_chunk(member="prague-foodie", role="teammate"),
            session_id="team_sid",
            is_leader=False,
            is_teammate=True,
        )
        _accumulate_team_usage(accumulator, parsed)
    summary = _build_team_usage_summary_payload(
        "prague-foodie", accumulator["prague-foodie"], session_id="team_sid"
    )
    assert summary is not None
    assert summary["event_type"] == "chat.usage_summary"
    assert summary["member_name"] == "prague-foodie"
    assert summary["role"] == "teammate"
    assert summary["usage"]["total_tokens"] == 300
    assert summary["usage"]["input_tokens"] == 200
    assert abs(summary["usage"]["total_cost"] - 0.006) < 1e-9
    assert summary["model"] == "glm-4.7"


def test_summary_none_when_no_usage() -> None:
    accumulator: dict[str, dict] = {}
    parsed = _team_llm_usage_metadata_payload(
        _usage_chunk(member="idle-member", role="teammate"),
        session_id="team_sid",
        is_leader=False,
        is_teammate=True,
    )
    parsed["metadata"] = {"usage_metadata": {"input_tokens": 0, "output_tokens": 0}}
    _accumulate_team_usage(accumulator, parsed)
    acc = accumulator["idle-member"]
    assert acc["total_tokens"] == 0
    assert (
        _build_team_usage_summary_payload(
            "idle-member", acc, session_id="team_sid"
        )
        is None
    )


def test_leader_summary_has_no_member_name() -> None:
    accumulator: dict[str, dict] = {}
    parsed = _team_llm_usage_metadata_payload(
        _usage_chunk(role="leader"),
        session_id="team_sid",
        is_leader=True,
        is_teammate=False,
    )
    _accumulate_team_usage(accumulator, parsed)
    summary = _build_team_usage_summary_payload("", accumulator[""], session_id="team_sid")
    assert summary is not None
    assert summary["role"] == "leader"
    assert "member_name" not in summary


def test_history_filter_allows_usage_events_but_skips_other_empty_chat() -> None:
    assert _has_persistable_assistant_payload(
        content_text="",
        event_type="chat.usage_metadata",
        extra={"metadata": {"usage_metadata": {"total_tokens": 100}}, "member_name": "m"},
    )
    assert _has_persistable_assistant_payload(
        content_text="",
        event_type="chat.usage_summary",
        extra={"usage": {"total_tokens": 100}, "member_name": "m"},
    )
    assert not _has_persistable_assistant_payload(
        content_text="",
        event_type="chat.usage_metadata",
        extra={"member_name": "m"},
    )
    assert not _has_persistable_assistant_payload(
        content_text="",
        event_type="chat.final",
        extra={},
    )
    assert not _has_persistable_assistant_payload(
        content_text="",
        event_type="chat.processing_status",
        extra={},
    )
    assert not _has_persistable_assistant_payload(
        content_text="",
        event_type="chat.tool_update",
        extra={},
    )
