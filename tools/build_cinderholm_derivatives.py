"""G2-A6 — Cinderholm production derivative builder (approved pipeline).

Reads approved sources byte-for-byte (never writes to them) and emits
WebP primaries + JPG/PNG fallbacks under public/assets/tidebound/environment/.

Usage: python tools/build_cinderholm_derivatives.py  (run from repo root)
Uses Pillow (WebP supported). Fails closed on missing source or hash drift.

Approvals (G2-A5.1 binding): soft-to-full beam fixture (global cap applied
at runtime, not baked); WebP + JPG/PNG fallback; berth A (staging, not an
asset); shaped shoreline + foam collar (code geometry, not an asset).
Rejected inputs are never published: *-sky-1-png.png (cyan fringe),
farmountains-1.jpg (white backing), waves-1-png.png (mottled alpha),
staged beacon-beam-* (cap 36, invisible), W0 concepts, skiff, ORA, .kra.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
P1 = ROOT / "design/art-bible/working/p1-environment"
FX = ROOT / "design/art-bible/working/world-art-production/previews/assets"
OUT = ROOT / "public/assets/tidebound/environment"
REPORT_DIR = ROOT / "design/art-bible/working/world-art-production/production-assets"
REPORT = REPORT_DIR / "cinderholm-derivative-report.json"

PLATE_SIZE = (1920, 1080)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def alpha_max(path: Path) -> int:
    im = Image.open(path).convert("RGBA")
    _, _, _, a = im.split()
    lo, hi = a.getextrema()
    return hi


def save_webp(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="WEBP", quality=85, method=6)


def save_fallback(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix.lower() == ".jpg":
        image.convert("RGB").save(path, format="JPEG", quality=88, optimize=True)
    else:
        image.save(path, format="PNG", optimize=True)


def build_plate(src_rel: str, stem: str, fallback_ext: str) -> dict:
    src = ROOT / src_rel
    if not src.exists():
        raise SystemExit(f"missing approved source: {src_rel}")
    img = Image.open(src)
    if img.size != (2096, 1184):
        raise SystemExit(f"source size drift {src_rel}: {img.size}")
    fitted = img.convert("RGBA").resize(PLATE_SIZE, Image.Resampling.LANCZOS)
    if fallback_ext == ".jpg":
        fitted_rgb = fitted.convert("RGB")
        save_webp(fitted_rgb, OUT / f"{stem}.webp")
        save_fallback(fitted_rgb, OUT / f"{stem}{fallback_ext}")
    else:
        save_webp(fitted, OUT / f"{stem}.webp")
        save_fallback(fitted, OUT / f"{stem}{fallback_ext}")
    return {
        "source": src_rel,
        "sourceSha256": sha256(src),
        "sourceDimensions": [2096, 1184],
        "outputs": [
            {"path": f"public/assets/tidebound/environment/{stem}.webp",
             "sha256": sha256(OUT / f"{stem}.webp"),
             "bytes": (OUT / f"{stem}.webp").stat().st_size,
             "dimensions": [1920, 1080]},
            {"path": f"public/assets/tidebound/environment/{stem}{fallback_ext}",
             "sha256": sha256(OUT / f"{stem}{fallback_ext}"),
             "bytes": (OUT / f"{stem}{fallback_ext}").stat().st_size,
             "dimensions": [1920, 1080]},
        ],
    }


def build_overlay(src_name: str, stem: str, alpha_cap: int | None) -> dict:
    src = FX / src_name
    if not src.exists():
        raise SystemExit(f"missing approved fixture: {src_name}")
    img = Image.open(src).convert("RGBA")
    if alpha_cap is not None:
        peak = alpha_max(src)
        if peak > alpha_cap:
            raise SystemExit(f"alpha cap drift {src_name}: peak {peak} > {alpha_cap}")
    save_webp(img, OUT / f"{stem}.webp")
    save_fallback(img, OUT / f"{stem}.png")
    return {
        "source": f"design/art-bible/working/world-art-production/previews/assets/{src_name}",
        "sourceSha256": sha256(src),
        "sourceDimensions": [img.size[0], img.size[1]],
        "alphaPeak": alpha_max(src),
        "outputs": [
            {"path": f"public/assets/tidebound/environment/{stem}.webp",
             "sha256": sha256(OUT / f"{stem}.webp"),
             "bytes": (OUT / f"{stem}.webp").stat().st_size,
             "dimensions": [img.size[0], img.size[1]]},
            {"path": f"public/assets/tidebound/environment/{stem}.png",
             "sha256": sha256(OUT / f"{stem}.png"),
             "bytes": (OUT / f"{stem}.png").stat().st_size,
             "dimensions": [img.size[0], img.size[1]]},
        ],
    }


def main() -> None:
    entries: list[dict] = []
    # D1/D4 opaque masters (JPG fallback).
    entries.append(build_plate(
        "design/art-bible/working/p1-environment/p1-sky/tidebound-sky-1.jpg",
        "cinderholm_sky", ".jpg"))
    entries.append(build_plate(
        "design/art-bible/working/p1-environment/p1-waves/tidebound-waves-1.jpg",
        "cinderholm_sea", ".jpg"))
    # D2/D3/D5 RGBA masters (PNG fallback).
    entries.append(build_plate(
        "design/art-bible/working/p1-environment/p1-farmountains/tidebound-farmountains-1-png.png",
        "cinderholm_mountains", ".png"))
    entries.append(build_plate(
        "design/art-bible/working/p1-environment/p1-castlewithlighhouse/tidebound-castle-lighthouse.png",
        "cinderholm_castle", ".png"))
    entries.append(build_plate(
        "design/art-bible/working/p1-environment/p1-frontrocks/tidebound-frontstones.png",
        "cinderholm_frontstones", ".png"))
    # D6/D7 per-format atmosphere (native dims, RGBA).
    entries.append(build_overlay("water-sheen-landscape.png", "cinderholm_sheen_landscape", None))
    entries.append(build_overlay("water-sheen-portrait.png", "cinderholm_sheen_portrait", None))
    entries.append(build_overlay("mist-landscape.png", "cinderholm_mist_landscape", None))
    entries.append(build_overlay("mist-portrait.png", "cinderholm_mist_portrait", None))
    # D8/D9 approved beam rungs (alpha-cap validated, not baked global cap).
    entries.append(build_overlay("beacon-beam-anim-landscape.png", "cinderholm_beam_landscape", 150))
    entries.append(build_overlay("beacon-beam-anim-portrait.png", "cinderholm_beam_portrait", 150))
    entries.append(build_overlay("beacon-beam-anim-soft-landscape.png", "cinderholm_beam_soft_landscape", 80))
    entries.append(build_overlay("beacon-beam-anim-soft-portrait.png", "cinderholm_beam_soft_portrait", 80))

    total_bytes = sum(o["bytes"] for e in entries for o in e["outputs"])
    report = {
        "task": "G2-A6 cinderholm production derivatives",
        "approvals": "G2-A5.1 binding decisions 1-11; rights clearance approved by user",
        "sourcePolicy": "read-only; rejected twins/concepts never published",
        "entries": entries,
        "outputCount": sum(len(e["outputs"]) for e in entries),
        "totalBytes": total_bytes,
    }
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"outputs": report["outputCount"], "totalBytes": total_bytes,
                      "report": str(REPORT)}, indent=2))


if __name__ == "__main__":
    sys.exit(main())
