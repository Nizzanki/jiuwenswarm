"""tracehound.session.mtime helper returns history mtime or None."""
import importlib
import sys
from pathlib import Path

aws = importlib.import_module("jiuwenswarm.server.agent_ws_server")


def test_mtime_helper(monkeypatch, tmp_path: Path) -> None:
    mod = sys.modules["jiuwenswarm.server.runtime.session.session_history"]
    f = tmp_path / "history.jsonl"
    f.write_text("{}\n", encoding="utf-8")
    monkeypatch.setattr(mod, "get_read_history_path", lambda sid, **kw: f)
    srv = aws.AgentWebSocketServer.__new__(aws.AgentWebSocketServer)
    assert srv._tracehound_session_mtime("s1") is not None
    monkeypatch.setattr(mod, "get_read_history_path", lambda sid, **kw: tmp_path / "missing.jsonl")
    assert srv._tracehound_session_mtime("s1") is None
