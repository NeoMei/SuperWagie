"""Locked Python Playwright transport for standalone hosts without managed bindings."""
import asyncio
import os
from pathlib import Path


def preview(job):
    try:
        from playwright.async_api import async_playwright
    except ImportError as error:
        raise RuntimeError("Standalone preview requires Python >=3.11 and locked Playwright. Run uv sync --locked in references and prepare a compatible browser, or select an existing Chrome/Edge with --browser.") from error
    return asyncio.run(_render(job, async_playwright))


async def _render(job, playwright):
    from render import _assets, _request_is_local
    assets = _assets()
    explicit = job.get("browser") or os.environ.get("CHROME_PATH")
    if explicit and (not Path(explicit).is_absolute() or not Path(explicit).is_file()):
        raise RuntimeError("Selected host browser is unavailable; provide an existing absolute Chrome/Edge executable")
    denied=[]; errors=[]; fonts=set(); browser=None
    env={key:value for key,value in os.environ.items() if key.upper() not in ("ELECTRON_RUN_AS_NODE","NODE_OPTIONS","NODE_PATH")}
    async with playwright() as p:
        try:
            browser=await p.chromium.launch(headless=True, executable_path=explicit, timeout=20000, env=env,
                args=["--disable-features=MacAppCodeSignClone","--disable-background-networking","--disable-component-update","--no-first-run","--no-default-browser-check"])
            async def work():
                context=await browser.new_context(viewport=job["viewport"],device_scale_factor=job["scale"],service_workers="block")
                async def route(request):
                    url=request.request.url
                    if request.request.method!="GET" or not _request_is_local(url,job["origin"]) or url.removeprefix(job["origin"]) not in assets:
                        denied.append("request");await request.abort()
                    else: await request.continue_()
                await context.route("**/*",route)
                async def websocket(socket):
                    denied.append("websocket");await socket.close()
                await context.route_web_socket("**/*",websocket)
                page=await context.new_page();page.set_default_timeout(20000)
                await page.add_init_script("window.__previewViolations=0; document.addEventListener('securitypolicyviolation',()=>window.__previewViolations++);")
                page.on("pageerror",lambda _error:errors.append("page error"))
                page.on("requestfailed",lambda _request:errors.append("request failed"))
                def response(value):
                    if value.status!=200:errors.append("asset response failed")
                    if value.url.endswith(".woff2"):fonts.add(value.url.removeprefix(job["origin"]))
                page.on("response",response)
                await page.goto(job["origin"]+"/render.html")
                await page.wait_for_function("window.__ready === true")
                result=await page.evaluate("scene=>window.renderDiagram(scene)",job["scene"])
                if not result or result.get("ok") is not True: raise RuntimeError("Excalidraw could not render this scene")
                await page.evaluate("async()=>{await document.fonts.ready}")
                state=await page.evaluate("()=>({failed:[...document.fonts].some(font=>font.status==='error'),violations:window.__previewViolations,textCount:document.querySelectorAll('#root svg text').length})")
                if denied or errors or state["failed"] or state["violations"] or (state["textCount"] and not fonts):raise RuntimeError("Offline preview asset, font or network policy check failed")
                svg=page.locator("#root svg");bounds=await svg.bounding_box()
                import math
                if not bounds or any(not math.isfinite(bounds[key]) or bounds[key]<=0 for key in ("width","height")):raise RuntimeError("Preview SVG has invalid bounds")
                ratio=min(1,job["maxWidth"]/bounds["width"],job["maxHeight"]/bounds["height"],math.sqrt(job["maxPixels"]/(math.ceil(bounds["width"]*job["scale"])*math.ceil(bounds["height"]*job["scale"]))))
                if ratio<1:await svg.evaluate("(svg,size)=>{svg.style.width=`${size.width}px`;svg.style.height=`${size.height}px`}",{"width":max(1,math.floor(bounds["width"]*ratio)),"height":max(1,math.floor(bounds["height"]*ratio))})
                glyphs=[]
                if job.get("preflight"):
                    cdp=await context.new_cdp_session(page);await cdp.send("DOM.enable");await cdp.send("CSS.enable")
                    root=await cdp.send("DOM.getDocument");nodes=await cdp.send("DOM.querySelectorAll",{"nodeId":root["root"]["nodeId"],"selector":"#root svg text"})
                    for node in nodes["nodeIds"]:
                        evidence=await cdp.send("CSS.getPlatformFontsForNode",{"nodeId":node})
                        glyphs.extend({"family":font["familyName"],"custom":font["isCustomFont"],"glyphs":font["glyphCount"]} for font in evidence["fonts"])
                    if not all(any(font["custom"] and family in font["family"] and font["glyphs"]>0 for font in glyphs) for family in ("Xiaolai","Excalifont")) or any(not font["custom"] and font["glyphs"]>0 for font in glyphs):raise RuntimeError("Preview preflight used fallback fonts")
                final_bounds=await svg.bounding_box()
                if not final_bounds or any(not math.isfinite(final_bounds[key]) or final_bounds[key]<=0 for key in ("width","height")) or math.ceil(final_bounds["width"]*job["scale"])*math.ceil(final_bounds["height"]*job["scale"])>job["maxPixels"]:
                    raise RuntimeError("Preview screenshot exceeds pixel limit")
                await svg.screenshot(path=job["output"],animations="disabled")
                if denied or errors or await page.evaluate("window.__previewViolations"):raise RuntimeError("Offline preview attempted a forbidden resource")
                await context.close()
                return {"ok":True,"route":"standalone-python","browserVersion":browser.version,"fonts":sorted(fonts),"glyphs":glyphs,"deniedRequests":len(denied)}
            async def cancelled():
                while not Path(job["cancel"]).exists(): await asyncio.sleep(0.1)
                raise RuntimeError("Preview cancelled")
            task=asyncio.create_task(work());cancel=asyncio.create_task(cancelled())
            try:
                done,_pending=await asyncio.wait([task,cancel],timeout=60,return_when=asyncio.FIRST_COMPLETED)
                if not done:raise RuntimeError("Preview exceeded its 60 second deadline")
                return next(iter(done)).result()
            finally:
                task.cancel();cancel.cancel()
                await asyncio.gather(task,cancel,return_exceptions=True)
        finally:
            if browser is not None: await asyncio.wait_for(browser.close(),timeout=5)
