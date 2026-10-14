"""Server-side read-aloud narration for the Inkwell bridge.

Replaces the old browser-native `SpeechSynthesis` engine (app.js) with Microsoft Edge's
neural TTS voices via the `edge-tts` package — the same consumer service behind Edge's own
Read Aloud/Narrator feature. Unlike the browser engine this is a real network call (bridge →
Microsoft), so it needs the bridge host to have outbound internet access, and there is
deliberately **no fallback voice engine**: a synthesis failure is returned as an error for
bridge.py's `/narrate` route to surface, not silently swapped for a lesser/different voice.

Env: TTS_VOICE (default en-US-AnaNeural — a young/child-register voice, fitting a kids'
storybook), TTS_RATE (edge-tts SSML prosody rate, e.g. "-8%"; default a touch slower than
normal speech, easier to follow as a read-aloud story), TTS_TIMEOUT (seconds, default 20).
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os

import edge_tts
import edge_tts.communicate as _edge_communicate
import edge_tts.constants as _edge_constants
from aiohttp import WSServerHandshakeError

log = logging.getLogger("inkwell.narrate")

VOICE = os.getenv("TTS_VOICE", "en-US-AnaNeural")
RATE = os.getenv("TTS_RATE", "-8%")
TIMEOUT = float(os.getenv("TTS_TIMEOUT", "20") or 20)

# --- Oct 2026 Microsoft host-migration workaround ---------------------------------------
# Microsoft is moving Edge Read Aloud off the legacy speech.platform.bing.com websocket to a
# new api.msedgeservices.com host; the legacy host now 403s the handshake in a growing set of
# regions (edge-tts 7.2.8 doesn't know about the new host yet — see
# github.com/rany2/edge-tts/issues/490). Both hosts currently accept the SAME legacy
# Sec-MS-GEC token/version edge-tts already generates, so only WSS_URL needs to change.
# `edge_tts.communicate` imports WSS_URL by name at module scope and reads that name fresh
# each call, so reassigning `_edge_communicate.WSS_URL` before `Communicate.stream()` runs
# redirects it — same trick the edge-tts issue thread's workaround uses. Try the new host
# first (legacy is failing in more regions as the migration progresses), falling back to
# whichever edge-tts shipped with; remember whichever host last worked so later calls don't
# re-pay for the failing one's handshake first.
_LEGACY_WSS_URL = _edge_communicate.WSS_URL
_NEW_WSS_URL = (
    "wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1"
    f"?Ocp-Apim-Subscription-Key={_edge_constants.TRUSTED_CLIENT_TOKEN}"
)
_WSS_CANDIDATES = (_NEW_WSS_URL, _LEGACY_WSS_URL)
_wss_working = 0


async def _stream_with_host_fallback(text: str, voice: str) -> tuple[list[bytes], list[list]]:
    """Like Communicate.stream(), but retries against each known websocket host in turn
    (starting with whichever last succeeded) on a 403 handshake — a fresh Communicate instance
    per attempt, since stream() can only be called once per instance.

    Returns (audio chunks, word boundaries). Boundaries are `[start_ms, duration_ms, word]`
    from the service's own WordBoundary metadata — the timing app.js uses to highlight each
    word as it's spoken. They come back on the same websocket as the audio, so they cost no
    extra round-trip. For zh-CN the service segments by word (水獭, 手套), not per character."""
    global _wss_working
    last_exc: WSServerHandshakeError | None = None
    for offset in range(len(_WSS_CANDIDATES)):
        idx = (_wss_working + offset) % len(_WSS_CANDIDATES)
        _edge_communicate.WSS_URL = _WSS_CANDIDATES[idx]
        chunks: list[bytes] = []
        words: list[list] = []
        try:
            comm = edge_tts.Communicate(text, voice, rate=RATE, boundary="WordBoundary")
            async for chunk in comm.stream():
                if chunk["type"] == "audio":
                    chunks.append(chunk["data"])
                elif chunk["type"] == "WordBoundary":
                    # offset/duration are in 100-ns ticks
                    words.append([chunk["offset"] // 10_000, chunk["duration"] // 10_000, chunk["text"]])
            _wss_working = idx
            return chunks, words
        except WSServerHandshakeError as exc:
            if exc.status != 403:
                raise
            last_exc = exc
    assert last_exc is not None
    raise last_exc

# Panel captions are immutable once approved, so the same line is commonly synthesized twice
# (once live as it settles, again if "Read story aloud" replays the finished story) — cache by
# (voice, rate, text) so the second ask never re-pays for a Microsoft round-trip. Small bound:
# a story is ~10-12 lines, so this only ever holds a handful of recent stories' worth.
_CACHE_MAX = 64
_cache: dict[str, tuple[bytes, list[list]]] = {}
_cache_order: list[str] = []


def describe() -> str:
    return f"edge-tts ({VOICE}, rate {RATE})"


def _cache_key(text: str, voice: str) -> str:
    return hashlib.sha256(f"{voice}|{RATE}|{text}".encode("utf-8")).hexdigest()


async def synthesize(text: str, voice: str | None = None) -> tuple[bytes | None, str | None]:
    """MP3 bytes for `text` spoken in `voice` (default: the VOICE env var), or (None, reason)
    on failure — never both/neither, same two-tuple convention as imagegen.render. `voice` lets
    callers switch language (see bridge.py's /narrate, which maps the front-end's EN/中文
    toggle to a voice) without touching the module-level English default."""
    audio, _words, err = await synthesize_with_words(text, voice)
    return audio, err


async def synthesize_with_words(
    text: str, voice: str | None = None,
) -> tuple[bytes | None, list[list], str | None]:
    """synthesize(), plus the per-word `[start_ms, duration_ms, word]` timings (see
    _stream_with_host_fallback) — what bridge.py's /narrate sends so app.js can highlight the
    word being spoken. (None, [], reason) on failure."""
    text = (text or "").strip()
    if not text:
        return None, [], "empty text"
    voice = voice or VOICE
    key = _cache_key(text, voice)
    cached = _cache.get(key)
    if cached is not None:
        return cached[0], cached[1], None
    try:
        async with asyncio.timeout(TIMEOUT):
            chunks, words = await _stream_with_host_fallback(text, voice)
    except Exception as exc:  # noqa: BLE001
        log.warning("narration failed (%s): %s", describe(), exc, exc_info=True)
        return None, [], str(exc) or exc.__class__.__name__
    audio = b"".join(chunks)
    if not audio:
        log.warning("narration returned no audio (%s) for text: %.80s", describe(), text)
        return None, [], "the narration service returned no audio"
    _cache[key] = (audio, words)
    _cache_order.append(key)
    if len(_cache_order) > _CACHE_MAX:
        _cache.pop(_cache_order.pop(0), None)
    return audio, words, None
