"""G2-A6: renderer-surface (overlay.html) production captures.

True-format canvases (1920x1080 / 1080x1920) with default Chromium GL
(hardware when available). Records the GPU renderer string so FPS numbers
are honestly labeled. No production code is modified (inspection only).
"""
from __future__ import annotations

import json
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parents[5] / "screenshots" / "g2a6-production-2026-11-07"
BASE = "http://localhost:5173/overlay.html"

WAIT_CANVAS = "() => !!document.querySelector('#game canvas')"

GPU_JS = """() => {
  try {
    const cv = document.createElement('canvas');
    const gl = cv.getContext('webgl') || cv.getContext('experimental-webgl');
    if (!gl) return 'no-webgl';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'masked';
  } catch (e) { return 'error:' + e; }
}"""

FPS_JS = """() => new Promise((resolve) => {
  let frames = 0;
  const start = performance.now();
  const tick = () => {
    frames += 1;
    if (performance.now() - start >= 4000) {
      const heap = (performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null);
      resolve({ fps: frames / 4, heapMB: heap });
    } else {
      requestAnimationFrame(tick);
    }
  };
  requestAnimationFrame(tick);
})"""


def run_case(browser, name, query, viewport, reduced=False, settle_ms=4000):
    OUT.mkdir(parents=True, exist_ok=True)
    ctx_kwargs = {"viewport": viewport}
    if reduced:
        ctx_kwargs["reduced_motion"] = "reduce"
    context = browser.new_context(**ctx_kwargs)
    page = context.new_page()
    try:
        page.bring_to_front()
    except Exception:
        pass
    errors, failed, bad = [], [], []
    page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
    page.on("pageerror", lambda err: errors.append(str(err)))
    page.on("requestfailed", lambda req: failed.append({"url": req.url, "error": str(req.failure)}))
    page.on("response", lambda res: bad.append({"url": res.url, "status": res.status}) if res.status >= 400 else None)
    url = BASE + query
    last_exc = None
    for _ in range(3):
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=120000)
            break
        except Exception as exc:
            last_exc = exc
            page.wait_for_timeout(3000)
    else:
        raise last_exc
    page.wait_for_function(WAIT_CANVAS, timeout=60000)
    page.wait_for_timeout(settle_ms)
    gpu = page.evaluate(GPU_JS)
    perf = page.evaluate(FPS_JS)
    shot = OUT / f"{name}.png"
    page.screenshot(path=str(shot))
    run = {"name": name, "url": url, "screenshot": shot.name,
           "gpu": gpu, "perf": perf,
           "consoleErrors": errors, "failedRequests": failed, "httpErrors": bad}
    (OUT / f"{name}.json").write_text(json.dumps(run, indent=2), encoding="utf-8")
    print(json.dumps({"case": name, "gpu": gpu, "perf": perf,
                      "errors": len(errors), "failed": len(failed), "http": len(bad)}))
    context.close()
    return run


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        land = {"width": 1920, "height": 1080}
        port = {"width": 1080, "height": 1920}
        run_case(browser, "ovl-calm-landscape", "?env=calm", land)
        run_case(browser, "ovl-storm-landscape", "?env=storm", land)
        run_case(browser, "ovl-calm-portrait", "?format=portrait&env=calm", port)
        run_case(browser, "ovl-storm-portrait", "?format=portrait&env=storm", port)
        run_case(browser, "ovl-storm-reduced", "?env=storm", land, reduced=True)
        run_case(browser, "ovl-storm-fxoff", "?env=storm&fx=0", land)
        browser.close()
    print("OK", OUT)


if __name__ == "__main__":
    main()
