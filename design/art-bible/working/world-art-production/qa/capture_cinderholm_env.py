"""G2-A4: capture the Cinderholm environment assembly and inspect sprite state."""
from __future__ import annotations

import json
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

PREVIEWS = Path(__file__).resolve().parents[1] / "previews"
OUT = Path(__file__).resolve().parents[5] / "screenshots" / "g2a4-cinderholm-env-2026-11-06"
CHROME = Path(r"C:\Users\91866\AppData\Local\ms-playwright\chromium-1243\chrome-win64\chrome.exe")
BASE = "http://localhost:5173/design/art-bible/working/world-art-production/previews/cinderholm-env.html"


def read_runtime(page):
    return page.evaluate("""() => {
      const d = window.__cinderholm;
      if (!d) return null;
      return {
        format: d.format,
        reduced: d.reduced,
        noAtlas: d.noAtlas,
        keeperPreview: d.keeperPreview,
        keeper: d.keeper,
        vessel: d.vessel,
        layers: d.layers,
        loadErrors: d.loadErrors,
        tweens: d.tweens,
      };
    }""")


def run_case(browser, name, url, wait_js, settle_ms=1200, trace_ms=0):
    context = browser.new_context(viewport={"width": 1920, "height": 1080}, device_scale_factor=1)
    if "reduced" in name:
        context = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            device_scale_factor=1,
            reduced_motion="reduce",
        )
    if "portrait" in name:
        context.close()
        context = browser.new_context(viewport={"width": 1080, "height": 1920}, device_scale_factor=1)
    page = context.new_page()
    page.bring_to_front()
    errors, failed, bad_responses = [], [], []
    page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
    page.on("pageerror", lambda err: errors.append(str(err)))
    page.on("requestfailed", lambda req: failed.append({"url": req.url, "error": str(req.failure)}))
    page.on("response", lambda res: bad_responses.append({"url": res.url, "status": res.status}) if res.status >= 400 else None)
    page.goto(url, wait_until="domcontentloaded", timeout=45000)
    page.wait_for_function(wait_js, timeout=45000)
    page.wait_for_timeout(settle_ms)
    shot = OUT / f"{name}.png"
    page.screenshot(path=str(shot), full_page=True)
    state = read_runtime(page)
    trace = []
    if trace_ms:
        started = time.perf_counter()
        while (time.perf_counter() - started) * 1000 < trace_ms:
            sample = read_runtime(page)
            sample["elapsedMs"] = round((time.perf_counter() - started) * 1000, 1)
            trace.append(sample)
            page.wait_for_timeout(250)
    events = page.evaluate("window.__cinderholm.frameEvents")
    run = {
        "name": name,
        "url": url,
        "screenshot": shot.name,
        "state": state,
        "trace": trace,
        "frameEvents": events,
        "consoleErrors": errors,
        "failedRequests": failed,
        "httpErrors": bad_responses,
    }
    (OUT / f"{name}.json").write_text(json.dumps(run, indent=2) + "\n", encoding="utf-8")
    context.close()
    return run


def main():
    if not CHROME.exists():
        raise SystemExit(f"Chromium missing: {CHROME}")
    OUT.mkdir(parents=True, exist_ok=True)
    results = {"baseUrl": BASE, "runs": []}
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            executable_path=str(CHROME),
            args=["--no-sandbox", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
        )
        results["runs"].append(run_case(
            browser, "landscape-idle",
            f"{BASE}?format=landscape",
            "window.__cinderholm && window.__cinderholm.keeper.present && window.__cinderholm.vessel.present",
            trace_ms=4000,
        ))
        results["runs"].append(run_case(
            browser, "portrait-idle",
            f"{BASE}?format=portrait",
            "window.__cinderholm && window.__cinderholm.keeper.present",
        ))
        results["runs"].append(run_case(
            browser, "landscape-reduced",
            f"{BASE}?format=landscape&reduced=1",
            "window.__cinderholm && window.__cinderholm.tweens === 0",
        ))
        results["runs"].append(run_case(
            browser, "landscape-strike-lock",
            f"{BASE}?format=landscape&keeperPreview=strike",
            "window.__cinderholm && window.__cinderholm.frameEvents.length >= 4",
            trace_ms=3000,
        ))
        results["runs"].append(run_case(
            browser, "landscape-noatlas",
            f"{BASE}?format=landscape&noatlas=1",
            "window.__cinderholm && window.__cinderholm.layers['p1-sky'] === true",
        ))
        browser.close()
    (OUT / "runtime-report.json").write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "report": str(OUT / "runtime-report.json"),
        "runs": [{
            "name": r["name"],
            "keeper": r["state"]["keeper"],
            "vessel": r["state"]["vessel"],
            "layers": r["state"]["layers"],
            "errors": len(r["consoleErrors"]),
            "failed": len(r["failedRequests"]),
            "http": len(r["httpErrors"]),
        } for r in results["runs"]],
    }, indent=2))


if __name__ == "__main__":
    main()
