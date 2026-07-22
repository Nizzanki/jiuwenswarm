"""Build a printable PDF of a finished story — a title page + one page per panel (image +
serif caption), in the same editorial-letterpress look as the GIF animatic.

Reuses gifexport's shared helpers (`_base`/`_font`/`_wrap`/`_title_frame`) so the two exports
match visually, but panel pages use their OWN frame builder (`_pdf_panel_frame`) rather than
gifexport's `_panel_frame`: the PDF deliberately omits the "PANEL n" eyebrow and big plate
number — it reads as a continuous storybook, not a numbered panel dump — while the GIF keeps
them. Server-side with Pillow only — Pillow can save a stack of RGB images straight to a
multi-page PDF, so this needs no new dependency and no extra rendering pass.
"""

from __future__ import annotations

import io

from PIL import Image

from gifexport import H, INK, MARGIN, RULE, W, DIM, _base, _font, _text_w, _title_frame, _wrap


def _pdf_panel_frame(art: Image.Image | None, caption: str) -> Image.Image:
    img, d = _base()
    box_w = W - 2 * MARGIN
    box_top = 40
    box_h = 320
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

    f_cap = _font(24)
    for ln in _wrap(d, caption, f_cap, box_w):
        d.text((MARGIN, cap_y), ln, font=f_cap, fill=INK)
        cap_y += 34

    d.line([(MARGIN, H - 52), (W - MARGIN, H - 52)], fill=RULE, width=1)
    f_foot = _font(12)
    d.text((MARGIN, H - 42), "INKWELL STUDIO", font=f_foot, fill=DIM)
    tail = "powered by JiuwenSwarm over A2A"
    d.text((W - MARGIN - _text_w(d, tail, f_foot), H - 42), tail, font=f_foot, fill=DIM)
    return img


def build_pdf(idea: str, style: str, panels: list[dict]) -> bytes:
    """panels: [{n:int, caption:str, png:bytes|None}] — returns PDF bytes: a title page
    followed by one page per panel. `n` is accepted for a consistent call shape with
    gifexport.build_gif but isn't drawn — see module docstring."""
    idea = (idea or "").strip() or "An illustrated story"

    frames: list[Image.Image] = [_title_frame(idea, style, show_style=False)]
    for p in panels:
        art = None
        if p.get("png"):
            try:
                art = Image.open(io.BytesIO(p["png"]))
                art.load()
            except Exception:
                art = None
        frames.append(_pdf_panel_frame(art, p.get("caption") or ""))

    buf = io.BytesIO()
    frames[0].save(buf, format="PDF", save_all=True, append_images=frames[1:])
    return buf.getvalue()
