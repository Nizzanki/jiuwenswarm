"""Pluggable image renderer for the Inkwell bridge (Path 2: our app renders pixels).

`render(prompt, style, size)` returns an `<img>`-able data URI, or `None` on any failure
(the front-end then keeps the prompt placeholder). Backend is chosen by `IMAGE_BACKEND`:

  stub    (default) — a real image generated locally from the prompt; zero external setup.
  a1111            — Automatic1111 / SD.Next  POST {IMAGE_URL}/sdapi/v1/txt2img
  openai           — OpenAI-compatible        POST {IMAGE_URL}/v1/images/generations

Env: IMAGE_BACKEND, IMAGE_URL, IMAGE_KEY, IMAGE_MODEL, IMAGE_STEPS, IMAGE_SIZE, IMAGE_TIMEOUT.

Honesty: the `stub` images are procedurally generated placeholders (labeled as such), not
model art — they prove the whole pipeline. Point IMAGE_BACKEND at a real SDXL/Flux endpoint
for genuine pictures.
"""

from __future__ import annotations

import asyncio
import base64
import colorsys
import hashlib
import io
import os
import random
import textwrap

import httpx

BACKEND = os.getenv("IMAGE_BACKEND", "stub").strip().lower()
IMAGE_URL = os.getenv("IMAGE_URL", "").rstrip("/")
IMAGE_KEY = os.getenv("IMAGE_KEY", "")
IMAGE_MODEL = os.getenv("IMAGE_MODEL", "")
IMAGE_STEPS = int(os.getenv("IMAGE_STEPS", "20") or 20)
IMAGE_TIMEOUT = float(os.getenv("IMAGE_TIMEOUT", "120") or 120)
NEGATIVE = "text, watermark, letters, blurry, deformed, extra limbs"


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


async def render(prompt: str, style: str = "", size: tuple[int, int] | None = None) -> str | None:
    prompt = (prompt or "").strip()
    if not prompt:
        return None
    w, h = size or _default_size()
    try:
        if BACKEND == "a1111":
            return await _a1111(prompt, style, w, h)
        if BACKEND == "openai":
            if not IMAGE_KEY:
                # configured for a hosted model but no key yet → clean placeholder
                return await asyncio.to_thread(_stub, prompt, style, w, h)
            return await _openai(prompt, style, w, h)
        return await asyncio.to_thread(_stub, prompt, style, w, h)  # default
    except Exception:
        return None  # graceful: front-end keeps the prompt placeholder


def _png_datauri(b64: str) -> str:
    return f"data:image/png;base64,{b64.split(',', 1)[-1]}"


# ------------------------------- real backends -------------------------------

async def _a1111(prompt: str, style: str, w: int, h: int) -> str | None:
    payload = {
        "prompt": ", ".join(p for p in (prompt, style) if p),
        "negative_prompt": NEGATIVE,
        "steps": IMAGE_STEPS, "width": w, "height": h,
    }
    async with httpx.AsyncClient(timeout=IMAGE_TIMEOUT) as c:
        r = await c.post(f"{IMAGE_URL}/sdapi/v1/txt2img", json=payload)
        r.raise_for_status()
        imgs = r.json().get("images") or []
        return _png_datauri(imgs[0]) if imgs else None


async def _openai(prompt: str, style: str, w: int, h: int) -> str | None:
    base = IMAGE_URL or "https://api.openai.com"
    headers = {"Authorization": f"Bearer {IMAGE_KEY}"} if IMAGE_KEY else {}
    payload = {"prompt": ", ".join(p for p in (prompt, style) if p), "n": 1}
    if IMAGE_MODEL:
        payload["model"] = IMAGE_MODEL
    if "api.openai.com" in base:
        # OpenAI (DALL·E / gpt-image): single `size` string, no steps.
        payload["size"] = f"{w}x{h}"
        payload["response_format"] = "b64_json"
    else:
        # FLUX / SD hosts (Together, SiliconFlow, DeepInfra, xAI…): width/height/steps.
        payload["width"], payload["height"] = w, h
        payload["steps"] = int(os.getenv("IMAGE_STEPS", "4") or 4)
        payload["response_format"] = "b64_json"
    async with httpx.AsyncClient(timeout=IMAGE_TIMEOUT) as c:
        r = await c.post(f"{base}/v1/images/generations", json=payload, headers=headers)
        r.raise_for_status()
        data = r.json().get("data") or []
        if not data:
            return None
        d0 = data[0]
        if d0.get("b64_json"):
            return _png_datauri(d0["b64_json"])
        if d0.get("url"):
            img = await c.get(d0["url"])
            img.raise_for_status()
            return _png_datauri(base64.b64encode(img.content).decode())
        return None


# --------------------------------- stub renderer -----------------------------
# A deterministic, pleasant placeholder: hash-seeded gradient + soft blobs + the
# prompt's opening words. Uses Pillow; falls back to an SVG data URI without it.

def _seed(prompt: str, style: str) -> random.Random:
    h = hashlib.sha256(f"{prompt}|{style}".encode()).hexdigest()
    return random.Random(int(h[:16], 16))


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

    rnd = _seed(prompt, style)
    top = _muted(rnd, rnd.uniform(0.62, 0.82))
    bot = _muted(rnd, rnd.uniform(0.18, 0.32))

    base = Image.new("RGB", (w, h))
    draw = ImageDraw.Draw(base)
    for y in range(h):                                   # vertical gradient
        t = y / max(1, h - 1)
        draw.line([(0, y), (w, y)], fill=tuple(int(top[i] * (1 - t) + bot[i] * t) for i in range(3)))

    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))    # soft translucent blobs
    od = ImageDraw.Draw(overlay)
    for _ in range(5):
        r = rnd.randint(w // 8, w // 3)
        x, y = rnd.randint(0, w), rnd.randint(0, h)
        od.ellipse([x - r, y - r, x + r, y + r], fill=(*_muted(rnd, rnd.uniform(0.5, 0.85)), rnd.randint(35, 75)))
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
    rnd = _seed(prompt, style)
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
