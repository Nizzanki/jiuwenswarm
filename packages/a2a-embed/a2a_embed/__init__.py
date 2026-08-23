"""a2a_embed -- reusable pieces for building a browser-facing bridge that drives a
JiuwenSwarm agent/team over A2A and relays its line-delimited JSON protocol as SSE.

Extracted from demos/inkwell-studio/server/bridge.py, the first app built on A2A end to
end -- what's here is exactly what stayed generic across that extraction: the transport
(client.py), JSON protocol framing (json_events.py), whitespace-dedup (dedup.py),
live-progress forwarding (live.py), a resilient-call pattern for flaky backends
(resilient.py), and a FastAPI app-factory layer (server.py, auth.py, ratelimit.py).

What's NOT here, on purpose: an app's own event vocabulary, prompt/guided-protocol design,
and UI rendering are domain-specific per app -- see this package's README and
demos/inkwell-studio/server/prompt.py for what a consumer still has to write itself.
"""
from .client import run_agent
from .dedup import best_variants, identity
from .json_events import extract_json_objects, new_complete_lines, parse_events, parse_line
from .live import LiveRelay
from .ratelimit import ConcurrencyGuard
from .resilient import call_resilient

__all__ = [
    "run_agent",
    "best_variants",
    "identity",
    "extract_json_objects",
    "new_complete_lines",
    "parse_events",
    "parse_line",
    "LiveRelay",
    "ConcurrencyGuard",
    "call_resilient",
]
