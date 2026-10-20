#!/usr/bin/env python3
"""Render an .excalidraw scene to PNG for visual self-check.

Uses the vendored Excalidraw bundle in a headless Chromium page (served over a
local HTTP server so ES-module imports aren't blocked by file:// CORS), calls
exportToSvg, and screenshots the SVG.

Setup (one-time):  cd references && uv sync && uv run playwright install chromium
Usage:  uv run python render.py scene.excalidraw --output scene.png
"""
import argparse, http.server, json, socketserver, sys, threading
from pathlib import Path
from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent

def render(src, out, scale=2, max_w=2400):
    scene = json.loads(Path(src).read_text(encoding="utf-8"))
    els = [e for e in scene["elements"] if not e.get("isDeleted")]
    xs, ys, xe, ye = [], [], [], []
    for e in els:
        x, y, w, h = e.get("x",0), e.get("y",0), e.get("width",0), e.get("height",0)
        if e.get("type") in ("arrow","line") and "points" in e:
            for px, py in e["points"]: xs.append(x+px); ys.append(y+py); xe.append(x+px); ye.append(y+py)
        else:
            xs.append(x); ys.append(y); xe.append(x+abs(w)); ye.append(y+abs(h))
    pad = 80
    minx, miny = min(xs or [0]), min(ys or [0])
    maxx, maxy = max(xe or [800]), max(ye or [600])
    vp_w, vp_h = min(int(maxx-minx+2*pad), max_w), max(int(maxy-miny+2*pad), 600)

    class _H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k): super().__init__(*a, directory=str(HERE), **k)
        def log_message(self, *a, **k): pass
    httpd = socketserver.TCPServer(("127.0.0.1", 0), _H)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    with sync_playwright() as p:
        try: browser = p.chromium.launch(headless=True)
        except Exception as e:
            print("Chromium not installed. Run: uv run playwright install chromium", file=sys.stderr); raise
        page = browser.new_page(viewport={"width":vp_w,"height":vp_h}, device_scale_factor=scale)
        page.goto(f"http://127.0.0.1:{port}/render.html")
        page.wait_for_function("window.__ready === true", timeout=20000)
        res = page.evaluate(f"window.renderDiagram({json.dumps(scene)})")
        if not (res and res.get("ok")):
            print(f"render failed: {res.get('error') if res else 'null'}", file=sys.stderr); sys.exit(1)
        svg = page.query_selector("#root svg")
        if not svg: print("no SVG produced", file=sys.stderr); sys.exit(1)
        svg.screenshot(path=str(out))
        browser.close()
    httpd.shutdown()
    return out

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Render .excalidraw to PNG")
    ap.add_argument("input"); ap.add_argument("--output","-o",required=True)
    ap.add_argument("--scale","-s",type=int,default=2)
    a = ap.parse_args()
    print(render(a.input, a.output, a.scale))
