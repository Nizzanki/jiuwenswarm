"""Build an animated-GIF 'animatic' of a finished story — a title card + one held
frame per panel (image + serif caption), in the editorial-letterpress look.

Server-side with Pillow only (no ffmpeg, no extra deps). The front-end rasterizes each
panel's art to a PNG and posts it here; we compose the storybook frames and assemble the
GIF with per-frame durations (a slideshow with clean cuts).
"""

from __future__ import annotations

import io

from PIL import Image, ImageDraw, ImageFont

# Editorial-letterpress palette (matches style.css)
PAPER = (246, 240, 226)
INK = (36, 31, 24)
OX = (140, 47, 42)
MUT = (106, 96, 81)
DIM = (154, 142, 118)
RULE = (211, 201, 172)

W, H = 820, 620
MARGIN = 56


def _font(size: int, *, bold: bool = False, italic: bool = False):
    names = []
    if bold:
        names += ["georgiab.ttf", "Georgia Bold.ttf"]
    if italic:
        names += ["georgiai.ttf", "Georgia Italic.ttf"]
    names += ["georgia.ttf", "Georgia.ttf", "Palatino Linotype.ttf", "arial.ttf", "DejaVuSerif.ttf"]
    for n in names:
        try:
            return ImageFont.truetype(n, size)
        except Exception:
            continue
    try:
        return ImageFont.load_default(size)
    except Exception:
        return ImageFont.load_default()


def _text_w(draw, text, font):
    return draw.textbbox((0, 0), text, font=font)[2]


def _wrap(draw, text, font, max_w):
    words = str(text).split()
    lines, cur = [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if _text_w(draw, t, font) <= max_w or not cur:
            cur = t
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def _base():
    img = Image.new("RGB", (W, H), PAPER)
    return img, ImageDraw.Draw(img)


def _title_frame(idea: str, style: str) -> Image.Image:
    img, d = _base()
    d.line([(MARGIN, 48), (W - MARGIN, 48)], fill=INK, width=2)
    f_brand = _font(20, bold=True)
    brand = "I N K W E L L   S T U D I O"
    d.text(((W - _text_w(d, brand, f_brand)) / 2, 150), brand, font=f_brand, fill=INK)
    d.line([((W - 260) / 2, 200), ((W + 260) / 2, 200)], fill=OX, width=2)
    f_idea = _font(34, italic=True)
    lines = _wrap(d, f'“{idea}”', f_idea, W - 2 * MARGIN - 40)
    y = 250
    for ln in lines:
        d.text(((W - _text_w(d, ln, f_idea)) / 2, y), ln, font=f_idea, fill=OX)
        y += 46
    if style:
        f_s = _font(16)
        d.text(((W - _text_w(d, style, f_s)) / 2, y + 16), style, font=f_s, fill=MUT)
    f_foot = _font(13)
    foot = "an illustrated story, made by a crew of agents"
    d.text(((W - _text_w(d, foot, f_foot)) / 2, H - 70), foot, font=f_foot, fill=DIM)
    return img


def _panel_frame(n: int, total: int, art: Image.Image | None, caption: str) -> Image.Image:
    img, d = _base()
    # eyebrow + plate number
    f_eye = _font(13)
    d.text((MARGIN, 40), f"PANEL {n:02d}", font=f_eye, fill=DIM)
    f_num = _font(40, italic=True)
    num = f"{n:02d}"
    d.text((W - MARGIN - _text_w(d, num, f_num), 30), num, font=f_num, fill=OX)

    # art box
    box_w = W - 2 * MARGIN
    box_top = 76
    box_h = 300
    if art is not None:
        a = art.convert("RGB")
        scale = min(box_w / a.width, box_h / a.height)
        aw, ah = int(a.width * scale), int(a.height * scale)
        a = a.resize((aw, ah), Image.LANCZOS)
        ax = MARGIN + (box_w - aw) // 2
        img.paste(a, (ax, box_top))
        d.rectangle([ax, box_top, ax + aw - 1, box_top + ah - 1], outline=INK, width=1)
        cap_y = box_top + ah + 30
    else:
        d.rectangle([MARGIN, box_top, W - MARGIN, box_top + box_h], outline=RULE, width=1)
        cap_y = box_top + box_h + 30

    # caption
    f_cap = _font(24)
    for ln in _wrap(d, caption, f_cap, box_w):
        d.text((MARGIN, cap_y), ln, font=f_cap, fill=INK)
        cap_y += 34

    # footer
    d.line([(MARGIN, H - 52), (W - MARGIN, H - 52)], fill=RULE, width=1)
    f_foot = _font(12)
    d.text((MARGIN, H - 42), "INKWELL STUDIO", font=f_foot, fill=DIM)
    tail = "powered by JiuwenSwarm over A2A"
    d.text((W - MARGIN - _text_w(d, tail, f_foot), H - 42), tail, font=f_foot, fill=DIM)
    return img


def build_gif(idea: str, style: str, panels: list[dict]) -> bytes:
    """panels: [{n:int, caption:str, png:bytes|None}] — returns animated GIF bytes."""
    idea = (idea or "").strip() or "An illustrated story"
    frames: list[Image.Image] = []
    durations: list[int] = []

    frames.append(_title_frame(idea, style))
    durations.append(2400)

    total = len(panels)
    for p in panels:
        art = None
        if p.get("png"):
            try:
                art = Image.open(io.BytesIO(p["png"]))
                art.load()
            except Exception:
                art = None
        frames.append(_panel_frame(int(p.get("n") or 0), total, art, p.get("caption") or ""))
        durations.append(2700)

    # quantize each frame to its own palette (local color tables) for faithful colors
    pal = [f.quantize(colors=256, method=Image.MEDIANCUT) for f in frames]
    buf = io.BytesIO()
    pal[0].save(
        buf, format="GIF", save_all=True, append_images=pal[1:],
        duration=durations, loop=0, disposal=2, optimize=True,
    )
    return buf.getvalue()
