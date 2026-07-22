"""Optional demo-clip helper: grab frames of a run for stitching into a gif/mp4.

Drives headless Chrome over the DevTools Protocol and saves a PNG every INTERVAL seconds
while a run plays. Stitching the frames into a video is a manual step (ffmpeg), e.g.:

    ffmpeg -framerate 2 -i frames/frame_%03d.png -vf scale=1000:-1 inkwell.gif
    ffmpeg -framerate 2 -i frames/frame_%03d.png -c:v libx264 -pix_fmt yuv420p inkwell.mp4

Usage (from repo root, with the bridge + servers running for live):
    .venv/Scripts/python.exe demos/inkwell-studio/server/capture.py \
        --url "http://127.0.0.1:8800/index.html?autorun=1" \
        --out ./frames --frames 40 --interval 2

Requires: websockets (already in the venv) and Chrome. Nothing here touches the app.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import subprocess
import sys
import urllib.request

import websockets

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]


def _find_chrome() -> str:
    for c in CHROME_CANDIDATES:
        if os.path.exists(c):
            return c
    raise SystemExit("Chrome not found — edit CHROME_CANDIDATES in capture.py")


async def _run(args) -> None:
    os.makedirs(args.out, exist_ok=True)
    chrome = _find_chrome()
    port = args.port
    profile = os.path.join(args.out, "_chrome_profile")
    proc = subprocess.Popen(
        [chrome, "--headless=new", "--disable-gpu", "--no-sandbox",
         f"--remote-debugging-port={port}", f"--window-size={args.width},{args.height}",
         "--user-data-dir=" + profile, args.url],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        ws_url = None
        for _ in range(40):
            try:
                data = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json"))
                for t in data:
                    if t.get("type") == "page" and t.get("webSocketDebuggerUrl"):
                        ws_url = t["webSocketDebuggerUrl"]
                        break
                if ws_url:
                    break
            except Exception:
                pass
            await asyncio.sleep(0.5)
        if not ws_url:
            raise SystemExit("could not attach to Chrome")

        async with websockets.connect(ws_url, max_size=80_000_000) as ws:
            mid = 0

            async def cmd(method, params=None):
                nonlocal mid
                mid += 1
                this = mid
                await ws.send(json.dumps({"id": this, "method": method, "params": params or {}}))
                while True:
                    r = json.loads(await ws.recv())
                    if r.get("id") == this:
                        return r

            await cmd("Page.enable")
            for i in range(args.frames):
                r = await cmd("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": True})
                path = os.path.join(args.out, f"frame_{i:03d}.png")
                with open(path, "wb") as f:
                    f.write(base64.b64decode(r["result"]["data"]))
                print(f"saved {path}", flush=True)
                await asyncio.sleep(args.interval)
        print(f"done — {args.frames} frames in {args.out}", flush=True)
    finally:
        proc.terminate()


def main() -> None:
    p = argparse.ArgumentParser(description="Capture frames of an Inkwell Studio run.")
    p.add_argument("--url", default="http://127.0.0.1:8800/index.html?autorun=1")
    p.add_argument("--out", default="./frames")
    p.add_argument("--frames", type=int, default=40)
    p.add_argument("--interval", type=float, default=2.0)
    p.add_argument("--width", type=int, default=1200)
    p.add_argument("--height", type=int, default=2200)
    p.add_argument("--port", type=int, default=9377)
    asyncio.run(_run(p.parse_args()))


if __name__ == "__main__":
    main()
