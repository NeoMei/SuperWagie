#!/usr/bin/env python3
"""Render a generate.py Excalidraw scene to PNG for visual self-check.

Uses the vendored Excalidraw bundle in a headless Chromium page (served over a
local HTTP server so ES-module imports aren't blocked by file:// CORS), calls
exportToSvg, and screenshots the SVG.

Setup (one-time):  cd references && uv sync --locked && uv run playwright install chromium
Usage:  uv run python render.py scene.excalidraw --output scene.png
"""
import hashlib
import signal
import struct
import subprocess
import tempfile
import zlib
import argparse
import http.server
import json
import math
import os
import socketserver
import sys
import threading
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scene_limits import validate_scene_geometry

HERE = Path(__file__).resolve().parent
MAX_RENDER_SCALE = 8
MAX_SOURCE_BYTES = 50 * 1024 * 1024
MAX_ACTIVE_ELEMENTS = 10_000

def _fit_viewport(width, height, scale, max_pixels):
    """Bound the browser surface before Chromium allocates device-scale pixels."""
    pixel_count = width * height * scale * scale
    if pixel_count <= max_pixels:
        return width, height
    ratio = math.sqrt(max_pixels / pixel_count)
    return max(1, int(width*ratio)), max(1, int(height*ratio))

def _request_is_local(url, local_origin):
    """Return whether a browser request may stay inside the offline renderer."""
    requested = urlsplit(url)
    if requested.scheme == "":
        return not requested.netloc
    if requested.scheme == "data":
        return True
    if requested.scheme == "about":
        return requested.path in ("blank", "srcdoc")
    if requested.scheme == "blob":
        inner_url = requested.path
        return (
            urlsplit(inner_url).scheme in ("http", "https")
            and _request_is_local(inner_url, local_origin)
        )
    if requested.scheme not in ("http", "https"):
        return False
    expected = urlsplit(local_origin)
    try:
        return (
            requested.scheme == expected.scheme
            and requested.hostname == expected.hostname
            and requested.port == expected.port
            and requested.username is None
            and requested.password is None
        )
    except ValueError:
        return False

def render(src, out, scale=2, max_w=2400, max_h=12000, max_pixels=32_000_000, browser=None, receipt=None, preflight=False):
    if (
        not isinstance(scale, (int, float))
        or isinstance(scale, bool)
        or not math.isfinite(scale)
        or scale <= 0
    ):
        raise ValueError("render scale must be positive")
    if scale > MAX_RENDER_SCALE:
        raise ValueError(f"render scale exceeds the safe maximum of {MAX_RENDER_SCALE}")
    for name, value in (
        ("maximum render width", max_w),
        ("maximum render height", max_h),
        ("maximum pixel count", max_pixels),
    ):
        if (
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(value)
            or value <= 0
        ):
            raise ValueError(f"{name} must be positive")
    source = Path(src)
    destination = Path(out)
    _check_output(source, destination)
    if source.stat().st_size > MAX_SOURCE_BYTES:
        raise ValueError(
            f"render source file exceeds the safe maximum of {MAX_SOURCE_BYTES} bytes"
        )
    with source.open("rb") as handle:
        raw = handle.read(MAX_SOURCE_BYTES + 1)
    if len(raw) > MAX_SOURCE_BYTES:
        raise ValueError("render source file exceeds the safe maximum")
    scene = json.loads(raw)
    elements = scene.get("elements") if isinstance(scene, dict) else None
    if not isinstance(elements, list) or any(not isinstance(e, dict) for e in elements):
        raise ValueError("scene elements must be a list of objects")
    els = [e for e in elements if not e.get("isDeleted")]
    if len(els) > MAX_ACTIVE_ELEMENTS:
        raise ValueError(
            f"scene exceeds the safe maximum of {MAX_ACTIVE_ELEMENTS} active elements"
        )
    validate_scene_geometry(els)
    xs, ys, xe, ye = [], [], [], []
    for e in els:
        x, y, w, h = e.get("x",0), e.get("y",0), e.get("width",0), e.get("height",0)
        if e.get("type") in ("arrow","line") and "points" in e:
            points = e["points"]
            for point in points:
                px, py = point
                xs.append(x+px); ys.append(y+py); xe.append(x+px); ye.append(y+py)
        else:
            xs.append(x); ys.append(y); xe.append(x+abs(w)); ye.append(y+abs(h))
    pad = 80
    minx, miny = min(xs or [0]), min(ys or [0])
    maxx, maxy = max(xe or [800]), max(ye or [600])
    vp_w = min(int(maxx-minx+2*pad), int(max_w))
    vp_h = min(max(int(maxy-miny+2*pad), 600), int(max_h))
    vp_w, vp_h = _fit_viewport(vp_w, vp_h, scale, max_pixels)

    binding = _managed_binding(os.environ)
    assets = _assets()
    class _H(http.server.BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(5)
        def do_GET(self):
            entry = _asset_request(self.path, assets)
            if entry is None:
                self.send_error(404); return
            filename, expected = entry
            data = filename.read_bytes()
            if hashlib.sha256(data).hexdigest() != expected:
                self.send_error(409); return
            self.send_response(200)
            self.send_header("Content-Type", "font/woff2" if filename.suffix == ".woff2" else "text/javascript" if filename.suffix == ".mjs" else "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            # FontFace validates unused upstream fallback URLs eagerly. Actual
            # font requests still pass the exact-origin browser route allowlist.
            self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; font-src http: https: data:; img-src data: blob:; connect-src 'self'; worker-src 'none'; frame-src 'none'")
            self.end_headers()
            self.wfile.write(data)
        def log_message(self, *args): pass
    httpd = socketserver.TCPServer(("127.0.0.1", 0), _H)
    server_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    server_started = False
    temporary = None
    try:
        server_thread.start(); server_started = True
        descriptor, filename = tempfile.mkstemp(prefix=".excalidraw-", suffix=".png", dir=destination.parent)
        os.close(descriptor); temporary = Path(filename)
        job = {"scene": scene, "origin": f"http://127.0.0.1:{httpd.server_address[1]}",
               "output": str(temporary.resolve()), "viewport": {"width":vp_w,"height":vp_h},
               "scale":scale, "maxWidth":min(max_w,2400), "maxHeight":min(max_h,12000),
               "maxPixels":min(max_pixels,32_000_000), "browser":browser, "preflight":preflight}
        result = _preview(job, binding)
        _png_dimensions(temporary.read_bytes(), job["maxPixels"])
        _check_output(source, destination)
        if temporary.is_symlink() or temporary.stat().st_nlink != 1:
            raise ValueError("temporary preview output was replaced")
        with temporary.open("rb") as handle: os.fsync(handle.fileno())
        os.replace(temporary, destination)
        if receipt is not None: receipt.update(result)
    finally:
        if temporary is not None: temporary.unlink(missing_ok=True)
        if server_started: httpd.shutdown()
        httpd.server_close()
        if server_started: server_thread.join(timeout=5)
    if receipt is not None: receipt["serverClosed"] = True
    return out


def _check_output(source, destination):
    if destination.is_symlink(): raise ValueError("render output must not be a symbolic link")
    if destination.exists() and not destination.is_file(): raise ValueError("render output must be a regular file")
    if source.resolve() == destination.resolve() or (destination.exists() and os.path.samefile(source, destination)):
        raise ValueError("render input and output must be different files")
    if destination.exists() and destination.stat().st_nlink != 1: raise ValueError("render output must not be a hardlink")
    # Refuse explicitly linked output directories. Canonical system ancestors,
    # such as macOS /var, are resolved before creating the sibling temporary.
    system_temp = Path(tempfile.gettempdir()).absolute()
    trusted_ancestors = set(system_temp.parents)
    for parent in destination.absolute().parents:
        if parent.is_symlink() and parent not in trusted_ancestors:
            raise ValueError("render output directory must not be a symbolic link")


def _managed_binding(env):
    names = ["SUPERWAGIE_EXCALIDRAW_" + key for key in ("NODE","NODE_MODE","PLAYWRIGHT","PYTHON")]
    found = [key for key in env if key.upper() in names]
    if not found: return None
    values = [env.get(key, "") for key in names]
    if len(found) != 4 or values[1] not in ("node","electron") or any(not value for value in values):
        raise RuntimeError("SuperWagie managed preview is unavailable or incomplete. Reopen from an intact local SuperWagie installation; standalone users must clear all four managed bindings and prepare the locked Python runtime.")
    for value in (values[0], values[2], values[3]):
        if not Path(value).is_absolute() or "app.asar" in Path(value).parts:
            raise RuntimeError("SuperWagie managed preview requires physical absolute runtime paths")
    if not Path(values[0]).is_file() or not Path(values[3]).is_file():
        raise RuntimeError("SuperWagie managed preview executable is missing; repair the application installation")
    return values


def _assets():
    manifest = json.loads((HERE / "ASSET-MANIFEST.json").read_text(encoding="utf-8"))
    assets = {}
    for item in manifest:
        name = item["path"]
        if name not in ("render.html", "excalidraw-vendored.mjs") and not (name.startswith("fonts/") and name.endswith(".woff2")):
            raise ValueError("invalid renderer asset inventory")
        file = HERE / name
        current = HERE
        for part in Path(name).parts:
            current = current / part
            if current.is_symlink(): raise ValueError("renderer asset contains a symbolic link")
        if ".." in Path(name).parts or file.is_symlink() or not file.resolve().is_relative_to(HERE):
            raise ValueError("renderer asset escapes inventory")
        if not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest() != item["sha256"]:
            raise RuntimeError("Bundled renderer/font asset is missing or changed; repair the skill installation")
        assets["/" + name] = (file, item["sha256"])
    if len(assets) != 218: raise ValueError("incomplete renderer asset inventory")
    return assets


def _asset_request(request, assets):
    # An exact inventory key excludes queries, escapes, traversal and listings.
    return assets.get(request)


def _png_dimensions(data, max_pixels):
    if len(data) > 128 * 1024 * 1024 or not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("invalid PNG preview")
    offset=8; dimensions=None; image=False; ended=False
    while offset + 12 <= len(data):
        size=struct.unpack(">I",data[offset:offset+4])[0]; kind=data[offset+4:offset+8]
        end=offset+12+size
        if end>len(data): raise ValueError("truncated PNG preview")
        content=data[offset+8:offset+8+size]
        crc=struct.unpack(">I",data[offset+8+size:end])[0]
        if zlib.crc32(kind+content)!=crc: raise ValueError("corrupt PNG preview")
        if offset==8:
            if kind!=b"IHDR" or size!=13: raise ValueError("invalid PNG header")
            dimensions=struct.unpack(">II",content[:8])
            if min(dimensions)<=0 or dimensions[0]*dimensions[1]>max_pixels: raise ValueError("PNG pixel limit exceeded")
        if kind==b"IDAT": image=True
        if kind==b"IEND":
            if size or end!=len(data): raise ValueError("invalid PNG ending")
            ended=True; break
        offset=end
    if not ended or not image: raise ValueError("incomplete PNG preview")
    return dimensions


def _preview(job, binding):
    env = dict(os.environ)
    env.pop("NODE_OPTIONS", None); env.pop("NODE_PATH", None); env.pop("ELECTRON_RUN_AS_NODE", None)
    if binding:
        node, mode, driver, _python = binding
        job["driver"] = driver
        command = [node, str(HERE / "render-node.mjs")]
        if mode == "electron": env["ELECTRON_RUN_AS_NODE"] = "1"
    else:
        command = [sys.executable, "-I", "-B", str(Path(__file__).resolve()), "--standalone-worker"]
    job["cancel"] = job["output"] + ".cancel"
    payload = json.dumps(job, ensure_ascii=False, allow_nan=False).encode("utf-8")
    if len(payload)>MAX_SOURCE_BYTES+1024*1024: raise ValueError("render job exceeds safe input limit")
    options = {"stdin":subprocess.PIPE,"stdout":subprocess.PIPE,"stderr":subprocess.PIPE,"env":env}
    if os.name == "nt": options["creationflags"] = subprocess.CREATE_NO_WINDOW
    else: options["start_new_session"] = True
    child = subprocess.Popen(command, **options)
    try:
        stdout, stderr = child.communicate(payload, timeout=80 if binding else 95)
    except BaseException:
        # The control file reaches Windows children without TerminateProcess,
        # so the browser owner can run Playwright's cleanup during held launch.
        cancel = Path(job["cancel"])
        created = False
        try:
            with cancel.open("x") as handle: handle.write("cancel")
            created = True
        except FileExistsError: pass
        try:
            if os.name != "nt":
                try: os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError: pass
            try: child.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                child.terminate()
                try: child.communicate(timeout=2)
                except subprocess.TimeoutExpired:
                    child.kill(); child.communicate()
        finally:
            if created: cancel.unlink(missing_ok=True)
        raise
    if child.returncode:
        # Worker diagnostics are fixed messages; never forward scene data or browser logs.
        raise RuntimeError("Preview failed. " + stderr.decode("utf-8",errors="replace")[-1500:].strip())
    result=json.loads(stdout)
    if result.get("ok") is not True: raise RuntimeError("Preview worker did not confirm success")
    return result


def _standalone(job):
    from standalone_preview import preview
    return preview(job)


if __name__ == "__main__":
    # Both CLI and standalone worker must unwind their owned resources on SIGTERM.
    def cancel_worker(_signal, _frame): raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, cancel_worker)
    try:
        if sys.argv[1:] == ["--standalone-worker"]:
            data=sys.stdin.buffer.read(MAX_SOURCE_BYTES+1024*1024+1)
            if len(data)>MAX_SOURCE_BYTES+1024*1024: raise ValueError("preview job is too large")
            print(json.dumps(_standalone(json.loads(data))))
        else:
            ap=argparse.ArgumentParser(description="Render .excalidraw to verified PNG with an offline browser")
            ap.add_argument("input",nargs="?");ap.add_argument("--output","-o");ap.add_argument("--scale","-s",type=float,default=2)
            ap.add_argument("--browser",help="Absolute existing Chrome/Edge executable; invalid explicit paths fail")
            ap.add_argument("--preflight",action="store_true",help="Render a local multilingual fixture and report runtime readiness")
            a=ap.parse_args(); receipt={}
            if a.preflight:
                from generate import build
                with tempfile.TemporaryDirectory(prefix="excalidraw-preflight-") as folder:
                    source=Path(folder)/"scene.excalidraw";output=Path(folder)/"preview.png"
                    source.write_text(json.dumps(build({"title":"中文 Latin Ελληνικά Русский", "nodes":[{"id":"input","label":"输入 input"},{"id":"output","label":"输出 output"}],"edges":[{"from":"input","to":"output","label":"传递 flow"}]})),encoding="utf-8")
                    render(source,output,browser=a.browser,receipt=receipt,preflight=True)
                print(json.dumps(receipt,ensure_ascii=False))
            else:
                if not a.input or not a.output: ap.error("input and --output are required unless --preflight is selected")
                render(a.input,a.output,a.scale,browser=a.browser,receipt=receipt)
                print(json.dumps({**receipt,"output":a.output},ensure_ascii=False))
    except Exception as error:
        print(str(error),file=sys.stderr); sys.exit(1)
