"""Pluggable image renderer for the Inkwell bridge (Path 2: our app renders pixels).

`render(prompt, style, size)` returns `(data_uri, error)` — exactly one is non-None. On
failure the caller gets a short human-readable reason it can surface in the UI, and the
full exception is logged. (It used to swallow failures and return a bare `None`, which
made a rate-limited panel indistinguishable from one still rendering.)

Backend is chosen by `IMAGE_BACKEND`:

  stub    (default) — a real image generated locally from the prompt; zero external setup.
  a1111            — Automatic1111 / SD.Next  POST {IMAGE_URL}/sdapi/v1/txt2img
  openai           — OpenAI-compatible        POST {IMAGE_URL}/v1/images/generations

Env: IMAGE_BACKEND, IMAGE_URL, IMAGE_KEY, IMAGE_MODEL, IMAGE_STEPS, IMAGE_SIZE, IMAGE_TIMEOUT,
IMAGE_RETRIES (attempts on 429/5xx, default 3).

Honesty: the `stub` images are procedurally generated placeholders (labeled as such), not
model art — they prove the whole pipeline. Point IMAGE_BACKEND at a real SDXL/Flux endpoint
for genuine pictures.

Child-safe is a hard constraint: every `a1111`/`openai` render appends `CHILD_SAFE_TAG` to
the prompt and `NEGATIVE` carries violence/gore/scary/adult terms — independent of whatever
the crew's Art Director wrote (see server/prompt.py for the matching brief-level instruction).
"""

from __future__ import annotations

import asyncio
import base64
import colorsys
import hashlib
import io
import json
import logging
import os
import random
import textwrap

import httpx

log = logging.getLogger("inkwell.imagegen")

BACKEND = os.getenv("IMAGE_BACKEND", "stub").strip().lower()
IMAGE_URL = os.getenv("IMAGE_URL", "").rstrip("/")
IMAGE_KEY = os.getenv("IMAGE_KEY", "")
IMAGE_MODEL = os.getenv("IMAGE_MODEL", "")
IMAGE_STEPS = int(os.getenv("IMAGE_STEPS", "20") or 20)
IMAGE_TIMEOUT = float(os.getenv("IMAGE_TIMEOUT", "120") or 120)
IMAGE_RETRIES = max(1, int(os.getenv("IMAGE_RETRIES", "3") or 3))

# Child-safe is a hard constraint, not a style choice: every real render (and every
# /restyle re-render, which calls this same code) gets this appended, independent of
# whatever the crew's Art Director wrote — prompt.py asks the crew nicely, this is the
# backend-level backstop for when a model doesn't perfectly follow instructions.
CHILD_SAFE_TAG = "gentle children's book illustration, warm and wholesome, family-friendly"
NEGATIVE = (
    "text, watermark, letters, blurry, deformed, extra limbs, "
    "violence, gore, blood, weapons, scary, frightening, horror, nudity, adult content"
)


def _default_size() -> tuple[int, int]:
    raw = os.getenv("IMAGE_SIZE", "768x480").lower()
    try:
        w, h = raw.split("x")
        return int(w), int(h)
    except Exception:
        return 768, 480


def describe() -> str:
    if BACKEND == "stub":
        return "stub (local placeholder — not model art)"
    return f"{BACKEND} @ {IMAGE_URL or '(no IMAGE_URL)'}"


async def render(
    prompt: str, style: str = "", size: tuple[int, int] | None = None, seed: int | None = None,
) -> tuple[str | None, str | None, int | None]:
    """Render one panel. Returns (data_uri, None, seed_used) on success, (None, reason, None)
    on failure.

    `seed`, when given, asks the backend to reuse a specific seed. Only `a1111` and non-OpenAI
    `openai`-compatible hosts (FLUX-style: Together/SiliconFlow/DeepInfra/xAI…) honor it; the
    `stub` backend doesn't need it (already deterministic per prompt, independent of style —
    see `_seed`); real OpenAI (api.openai.com) has no seed control at all.

    NOTE: `/restyle` (bridge.py) deliberately does NOT pass a seed — it used to, to keep a
    restyled image close to the original, but a low-step distilled model (e.g. FLUX.1-schnell
    at 4 steps) can let the seed dominate enough that the image doesn't visibly change at all.
    A fresh seed every restyle guarantees a visible change instead.
    """
    prompt = (prompt or "").strip()
    if not prompt:
        return None, "empty prompt", None
    w, h = size or _default_size()
    used_seed: int | None = None
    try:
        if BACKEND == "a1111":
            src, used_seed = await _a1111(prompt, style, w, h, seed)
        elif BACKEND == "openai":
            if not IMAGE_KEY:
                # configured for a hosted model but no key yet → clean placeholder
                src = await asyncio.to_thread(_stub, prompt, style, w, h)
            else:
                src, used_seed = await _openai(prompt, style, w, h, seed)
        else:
            src = await asyncio.to_thread(_stub, prompt, style, w, h)  # default
    except Exception as exc:  # noqa: BLE001
        detail = _response_detail(exc.response) if isinstance(exc, httpx.HTTPStatusError) else None
        log.warning("image render failed (%s): %s%s", describe(), exc,
                    f" — response body: {detail}" if detail else "", exc_info=True)
        return None, _reason(exc), None
    if not src:
        log.warning("image render returned no image (%s) for prompt: %.80s", describe(), prompt)
        return None, "the image service returned no image", None
    if _is_coloring_book_style(style):
        # A "black & white line art" instruction is just more prompt text to the model, and
        # models don't reliably follow it panel to panel (some come back fully colored — the
        # bug this fixes). Don't rely on compliance: force it deterministically by converting
        # whatever came back into line art server-side, same technique the old post-hoc
        # coloring-book PDF export used, so every panel is guaranteed monochrome regardless
        # of what the backend actually produced.
        forced = await asyncio.to_thread(_line_art_datauri, src)
        if forced:
            src = forced
    return src, None, used_seed


def _is_coloring_book_style(style: str) -> bool:
    return "coloring book" in (style or "").lower()


def _line_art_datauri(data_uri: str) -> str | None:
    """Convert a PNG data URI into a white-background black-line-art outline — Pillow only.
    Returns None (leave the image as-is) for anything that isn't a PNG data URI, e.g. the
    Pillow-less SVG stub fallback, since there's no image to filter without Pillow in the
    first place.

    SMOOTH + POSTERIZE → edge-detect → invert → autocontrast → HARD THRESHOLD (binarize to
    pure black or white), then a light dilation to bolden the lines. This is the standard
    "photo to coloring page" recipe, and the order matters:

    A real illustration is full of genuine fine detail — grass blades, water ripples, brush
    texture — that a naive edge-detect treats as just as significant as the actual object
    outlines, producing a busy, cluttered, sketch-like result instead of a clean coloring
    page (an earlier version of this even SHARPENED first, which made it worse — sharpening
    amplifies exactly that texture noise). Smoothing (GaussianBlur) and posterizing (collapse
    to a handful of tone levels) FIRST erases the fine texture while keeping the large shape
    boundaries intact, so edge-detection only finds the boundaries a human would actually draw
    for a coloring page. Thresholding then removes the last gray in-between values so lines
    are solid black on solid white, not a faint gray ramp (the "blurry" look this replaced),
    and MinFilter thickens them slightly for a bolder, more printable line."""
    if not data_uri.startswith("data:image/png;base64,"):
        return None
    try:
        from PIL import Image, ImageFilter, ImageOps
        raw = base64.b64decode(data_uri.split(",", 1)[1])
        img = Image.open(io.BytesIO(raw))
        img.load()
        simplified = ImageOps.posterize(img.convert("RGB").filter(ImageFilter.GaussianBlur(5)), 2)
        edges = ImageOps.invert(simplified.convert("L").filter(ImageFilter.FIND_EDGES))
        edges = ImageOps.autocontrast(edges, cutoff=1)
        edges = edges.point(lambda p: 0 if p < 200 else 255)   # binarize: no gray, just black/white
        edges = edges.filter(ImageFilter.MinFilter(3))         # bolden lines for a printable look
        edges = edges.convert("RGB")
        buf = io.BytesIO()
        edges.save(buf, "PNG")
        return _png_datauri(base64.b64encode(buf.getvalue()).decode())
    except Exception:  # noqa: BLE001
        log.exception("coloring-book line-art conversion failed — leaving image as rendered")
        return None


async def stub(prompt: str, style: str = "", size: tuple[int, int] | None = None) -> str:
    """Render the local placeholder directly, regardless of `BACKEND`. Used as a last-resort
    fallback so a panel always shows *something* rather than a bare "no image" after every
    retry against a real backend has failed."""
    w, h = size or _default_size()
    return await asyncio.to_thread(_stub, prompt, style, w, h)


def _reason(exc: Exception) -> str:
    """Short, user-facing explanation of a render failure."""
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        if code == 429:
            return "rate limited by the image service"
        if code in (401, 403):
            return "image service rejected the API key"
        if code >= 500:
            return f"image service error ({code})"
        detail = _response_detail(exc.response)
        return f"image request rejected ({code}){f': {detail}' if detail else ''}"
    if isinstance(exc, httpx.TimeoutException):
        return f"image request timed out after {IMAGE_TIMEOUT:.0f}s"
    if isinstance(exc, httpx.HTTPError):
        return "could not reach the image service"
    return f"{type(exc).__name__}: {exc}"


def _response_detail(response: httpx.Response) -> str:
    """Pull a short human-readable message out of an error response body, if any — providers
    usually explain WHICH field/value was rejected on a 4xx (we were previously discarding
    this and only surfacing the bare status code, which made a 422 unactionable)."""
    try:
        body = response.json()
        if isinstance(body, dict):
            err = body.get("error")
            if isinstance(err, dict):
                msg = err.get("message") or err.get("type")
                if msg:
                    return str(msg)[:200]
            elif isinstance(err, str) and err:
                return err[:200]
            msg = body.get("message")
            if msg:
                return str(msg)[:200]
        return str(body)[:200]
    except Exception:  # noqa: BLE001
        return (response.text or "")[:200]


async def _post_retrying(client: httpx.AsyncClient, url: str, **kw) -> httpx.Response:
    """POST, retrying on 429 and 5xx with backoff. Honors `Retry-After` when present.

    Free image tiers rate-limit aggressively and a burst of panels trips them routinely;
    without this a single 429 silently costs you a panel.
    """
    last: httpx.HTTPStatusError | None = None
    for attempt in range(1, IMAGE_RETRIES + 1):
        r = await client.post(url, **kw)
        if r.status_code != 429 and r.status_code < 500:
            r.raise_for_status()
            return r
        last = httpx.HTTPStatusError(
            f"{r.status_code} from {url}", request=r.request, response=r,
        )
        if attempt == IMAGE_RETRIES:
            break
        delay = _retry_after(r) or min(2 ** attempt, 20)
        log.info("image %s — retrying in %.1fs (attempt %d/%d)",
                 r.status_code, delay, attempt, IMAGE_RETRIES)
        await asyncio.sleep(delay)
    raise last  # type: ignore[misc]


def _retry_after(r: httpx.Response) -> float | None:
    raw = r.headers.get("Retry-After")
    if not raw:
        return None
    try:
        return max(0.0, min(float(raw), 60.0))   # cap: never stall a run on a bad header
    except ValueError:
        return None                              # HTTP-date form: fall back to backoff


def _png_datauri(b64: str) -> str:
    return f"data:image/png;base64,{b64.split(',', 1)[-1]}"


# ------------------------------- real backends -------------------------------

async def _a1111(
    prompt: str, style: str, w: int, h: int, seed: int | None = None,
) -> tuple[str | None, int | None]:
    payload = {
        "prompt": ", ".join(p for p in (prompt, style, CHILD_SAFE_TAG) if p),
        "negative_prompt": NEGATIVE,
        "steps": IMAGE_STEPS, "width": w, "height": h,
        "seed": seed if seed is not None else -1,
    }
    async with httpx.AsyncClient(timeout=IMAGE_TIMEOUT) as c:
        r = await _post_retrying(c, f"{IMAGE_URL}/sdapi/v1/txt2img", json=payload)
        body = r.json()
        imgs = body.get("images") or []
        if not imgs:
            return None, None
        used_seed = seed
        try:                                      # A1111 echoes the actual seed in `info` (JSON string)
            used_seed = json.loads(body.get("info") or "{}").get("seed", used_seed)
        except (ValueError, TypeError):
            pass
        return _png_datauri(imgs[0]), used_seed


async def _openai(
    prompt: str, style: str, w: int, h: int, seed: int | None = None,
) -> tuple[str | None, int | None]:
    base = IMAGE_URL or "https://api.openai.com"
    headers = {"Authorization": f"Bearer {IMAGE_KEY}"} if IMAGE_KEY else {}
    payload = {"prompt": ", ".join(p for p in (prompt, style, CHILD_SAFE_TAG) if p), "n": 1}
    if IMAGE_MODEL:
        payload["model"] = IMAGE_MODEL
    used_seed: int | None = None
    if "api.openai.com" in base:
        # OpenAI (DALL·E / gpt-image): single `size` string, no steps, and — unlike the hosts
        # below — no seed control at all, so a restyle here can't pin the composition.
        payload["size"] = f"{w}x{h}"
        payload["response_format"] = "b64_json"
    else:
        # FLUX / SD hosts (Together, SiliconFlow, DeepInfra, xAI…): width/height/steps/seed.
        payload["width"], payload["height"] = w, h
        payload["steps"] = int(os.getenv("IMAGE_STEPS", "4") or 4)
        payload["response_format"] = "b64_json"
        used_seed = seed if seed is not None else random.randint(0, 2**31 - 1)
        payload["seed"] = used_seed
    async with httpx.AsyncClient(timeout=IMAGE_TIMEOUT) as c:
        r = await _post_retrying(c, f"{base}/v1/images/generations", json=payload, headers=headers)
        data = r.json().get("data") or []
        if not data:
            return None, used_seed
        d0 = data[0]
        if d0.get("b64_json"):
            return _png_datauri(d0["b64_json"]), used_seed
        if d0.get("url"):
            img = await c.get(d0["url"])
            img.raise_for_status()
            return _png_datauri(base64.b64encode(img.content).decode()), used_seed
        return None, used_seed


# --------------------------------- stub renderer -----------------------------
# A deterministic, pleasant placeholder: hash-seeded gradient + soft blobs + the
# prompt's opening words. Uses Pillow; falls back to an SVG data URI without it.
#
# Two independent seed streams so a style-only restyle can keep the same picture:
# `_layout` (blob positions/sizes/count) is keyed on the prompt ALONE, `_palette`
# (colors) is keyed on prompt+style. Restyling therefore reuses the exact same
# composition and only re-tints it — the closest this backend can get to "same
# image, new style" without a real img2img model behind it.

def _seed(text: str) -> random.Random:
    h = hashlib.sha256(text.encode()).hexdigest()
    return random.Random(int(h[:16], 16))


def _layout_seed(prompt: str) -> random.Random:
    return _seed(prompt)


def _palette_seed(prompt: str, style: str) -> random.Random:
    return _seed(f"{prompt}|{style}")


def _muted(rnd: random.Random, light: float) -> tuple[int, int, int]:
    hue = rnd.random()
    r, g, b = colorsys.hsv_to_rgb(hue, rnd.uniform(0.30, 0.55), light)
    return int(r * 255), int(g * 255), int(b * 255)


def _load_font(size: int):
    from PIL import ImageFont
    for name in ("georgia.ttf", "Georgia.ttf", "arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except Exception:
            continue
    try:
        return ImageFont.load_default(size)
    except Exception:
        return ImageFont.load_default()


def _stub(prompt: str, style: str, w: int, h: int) -> str:
    try:
        return _stub_png(prompt, style, w, h)
    except Exception:
        return _stub_svg(prompt, style, w, h)


def _stub_png(prompt: str, style: str, w: int, h: int) -> str:
    from PIL import Image, ImageDraw, ImageFilter

    layout = _layout_seed(prompt)
    palette = _palette_seed(prompt, style)
    top = _muted(palette, palette.uniform(0.62, 0.82))
    bot = _muted(palette, palette.uniform(0.18, 0.32))

    base = Image.new("RGB", (w, h))
    draw = ImageDraw.Draw(base)
    for y in range(h):                                   # vertical gradient
        t = y / max(1, h - 1)
        draw.line([(0, y), (w, y)], fill=tuple(int(top[i] * (1 - t) + bot[i] * t) for i in range(3)))

    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))    # soft translucent blobs
    od = ImageDraw.Draw(overlay)
    for _ in range(5):
        r = layout.randint(w // 8, w // 3)
        x, y = layout.randint(0, w), layout.randint(0, h)
        od.ellipse([x - r, y - r, x + r, y + r], fill=(*_muted(palette, palette.uniform(0.5, 0.85)), layout.randint(35, 75)))
    overlay = overlay.filter(ImageFilter.GaussianBlur(max(8, w // 26)))
    img = Image.alpha_composite(base.convert("RGBA"), overlay)

    scrim = Image.new("RGBA", (w, h), (0, 0, 0, 0))      # bottom scrim for legible text
    ImageDraw.Draw(scrim).rectangle([0, int(h * 0.60), w, h], fill=(10, 12, 18, 165))
    img = Image.alpha_composite(img, scrim).convert("RGB")
    draw = ImageDraw.Draw(img)

    body = _load_font(max(14, w // 32))
    text = " ".join(prompt.split()[:24])
    wrapped = textwrap.fill(text, width=max(22, w // 15))
    draw.multiline_text((int(w * 0.05), int(h * 0.64)), wrapped, fill=(236, 238, 242), font=body, spacing=5)
    draw.text((int(w * 0.05), int(h * 0.05)), "STUB · not model art", fill=(224, 151, 63), font=_load_font(max(10, w // 56)))

    buf = io.BytesIO()
    img.save(buf, "PNG")
    return _png_datauri(base64.b64encode(buf.getvalue()).decode())


def _stub_svg(prompt: str, style: str, w: int, h: int) -> str:
    from xml.sax.saxutils import escape
    rnd = _palette_seed(prompt, style)
    top = "#%02x%02x%02x" % _muted(rnd, 0.72)
    bot = "#%02x%02x%02x" % _muted(rnd, 0.24)
    words = escape(" ".join(prompt.split()[:16]))
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">'
        f'<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">'
        f'<stop offset="0" stop-color="{top}"/><stop offset="1" stop-color="{bot}"/></linearGradient></defs>'
        f'<rect width="{w}" height="{h}" fill="url(#g)"/>'
        f'<rect y="{int(h*0.6)}" width="{w}" height="{int(h*0.4)}" fill="rgba(10,12,18,0.55)"/>'
        f'<text x="{int(w*0.05)}" y="{int(h*0.12)}" font-family="monospace" font-size="{max(10,w//56)}" fill="#e0973f">STUB · not model art</text>'
        f'<foreignObject x="{int(w*0.05)}" y="{int(h*0.64)}" width="{int(w*0.9)}" height="{int(h*0.32)}">'
        f'<div xmlns="http://www.w3.org/1999/xhtml" style="font:italic {max(13,w//30)}px Georgia,serif;color:#eceef2;line-height:1.4">{words}</div>'
        f'</foreignObject></svg>'
    )
    b64 = base64.b64encode(svg.encode()).decode()
    return f"data:image/svg+xml;base64,{b64}"
