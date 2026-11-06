"""G2-A6: production GameScene + Cinderholm environment captures.

Boots the real dashboard (index.html -> main.ts -> GameScene) under vite,
drives grades via the dev-only ?env= override, and records screenshots,
FPS (rAF), heap, tweens, vessel berth, env state, and all console/network
errors. Writes under screenshots/g2a6-production-2026-11-07/.
No production code is modified by this harness (runtime inspection only).
"""
from __future__ import annotations

import json
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parents[5] / "screenshots" / "g2a6-production-2026-11-07"
BASE = "http://localhost:5173/index.html"

WAIT_CANVAS = "() => !!document.querySelector('#game canvas')"

READ_STATE = """() => {
  const game = window.__tbGame;
  if (!game) return { game: false };
  const sc = game.scene.getScene('game');
  if (!sc || !sc.scene.isActive()) return { game: true, active: false };
  const env = sc.cinderholmEnv || null;
  return {
    game: true, active: true,
    format: sc.format || (sc.getFormat ? sc.getFormat() : null),
    reduced: !!sc.reducedMotion,
    envReady: !!sc.envReady,
    envActive: env ? !!env.active : null,
    envPreset: env ? env.ctl.preset : null,
    envMissing: env ? env.missing : null,
    vessel: sc.vessel ? { x: sc.vessel.x, y: sc.vessel.y, rotation: sc.vessel.rotation } : null,
    tweens: sc.tweens ? sc.tweens.getTweens().length : null,
    textures: {
      sky: sc.textures.exists('env-sky'), sea: sc.textures.exists('env-sea'),
      beam: sc.textures.exists('env-beam'),
    },
  };
}"""

FPS_JS = """() => new Promise((resolve) => {
  let frames = 0;
  const start = performance.now();
  const tick = () => {
    frames += 1;
    if (performance.now() - start >= 3000) {
      const heap = (performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null);
      resolve({ fps: frames / 3, heapMB: heap });
    } else {
      requestAnimationFrame(tick);
    }
  };
  requestAnimationFrame(tick);
})"""


def run_case(browser, name, query, viewport, bring_front=True, abort_env=False,
              reduced=False, settle_ms=4000, restart=0):
    OUT.mkdir(parents=True, exist_ok=True)
    ctx_kwargs = {"viewport": viewport}
    if reduced:
        ctx_kwargs["reduced_motion"] = "reduce"
    context = browser.new_context(**ctx_kwargs)
    if abort_env:
        context.route("**/assets/tidebound/environment/*",
                      lambda route: route.abort())
    page = context.new_page()
    if bring_front:
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
    if restart:
        for _ in range(restart):
            page.evaluate("""() => {
              const game = window.__tbGame;
              const sc = game.scene.getScene('game');
              game.scene.stop('game');
              game.scene.start('game');
            }""")
            page.wait_for_timeout(1500)
    state = page.evaluate(READ_STATE)
    perf = page.evaluate(FPS_JS)
    shot = OUT / f"{name}.png"
    page.screenshot(path=str(shot))
    run = {"name": name, "url": url, "screenshot": shot.name,
           "state": state, "perf": perf,
           "consoleErrors": errors, "failedRequests": failed, "httpErrors": bad}
    (OUT / f"{name}.json").write_text(json.dumps(run, indent=2), encoding="utf-8")
    print(json.dumps({"case": name, "state": state, "perf": perf,
                      "errors": len(errors), "failed": len(failed), "http": len(bad)}))
    context.close()
    return run


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--use-angle=swiftshader"])
        land = {"width": 1920, "height": 1080}
        port = {"width": 1080, "height": 1920}
        run_case(browser, "prod-calm-landscape", "?env=calm", land)
        run_case(browser, "prod-overcast-landscape", "?env=overcast", land)
        run_case(browser, "prod-storm-landscape", "?env=storm", land)
        run_case(browser, "prod-aftermath-landscape", "?env=aftermath", land)
        run_case(browser, "prod-calm-portrait", "?format=portrait&env=calm", port)
        run_case(browser, "prod-storm-portrait", "?format=portrait&env=storm", port)
        run_case(browser, "prod-storm-reduced", "?env=storm", land, reduced=True)
        run_case(browser, "prod-storm-fxoff", "?env=storm&fx=0", land)
        run_case(browser, "prod-noenv-fallback", "?env=calm", land, abort_env=True)
        run_case(browser, "prod-restart-x3", "?env=storm", land, restart=3)
        browser.close()
    print("OK", OUT)


if __name__ == "__main__":
    main()
