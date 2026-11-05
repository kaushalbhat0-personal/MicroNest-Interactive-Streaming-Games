"""P1 portrait pipeline: expressions sheet -> 360px head-pinned cells + JSON-hash.

Isolated from the full-body animation builder (tools/build_keeper_atlas.py):
 byte-identical animation gates are NOT imported or altered here. Portrait
 crops legitimately fill the cell bottom (bust cut), so feet-grounding and
 the 0.60 bottom-band tripwire must never apply to them.

 Usage (isolated validation only, never production atlas output):
   python tools/build_keeper_portraits.py
 Reads design/art-bible/working/p1-sheet-expressions.png, writes a 4-cell
 strip + Phaser JSON-hash to a temp-style output dir (default under the
 system temp area, never public/). Pure Pillow, stdlib otherwise.

 Bounds are stray-tolerant WITHOUT global alpha thresholding: only the
 bound calculation looks at opaque pixels (alpha > 16, the same opaque
 definition the animation builder uses); the cropped output pixels keep
 their original alpha, plus a 2px fringe margin so semi-transparent edges
 survive. Disconnected single-pixel perimeter noise therefore cannot pin
 the trim box, while real feathered edges are preserved.
"""
import hashlib
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "design" / "art-bible" / "working"
STEM = "p1-sheet-expressions"

CELL = 360
PORTRAIT_NAMES = ["neutral", "determined", "concerned", "hopeful"]
OPAQUE_AT = 16      # opaque definition (shared with the animation builder)
FRINGE_PAD = 2      # px margin around the opaque bbox so soft edges survive
SCALE_TOL = 0.03    # max relative scale spread across the four portraits
CENTER_TOL = 6      # max |content cx - CELL/2| after fit (px)
TOP_TOL = 4         # max content top row after head-pinning (px)
MIN_OPAQUE = 5000   # absolute floor per portrait cell (guards empties)
RATIO_CAP = 1.6     # max/min opaque ratio across the set (scale outlier)
ALPHA_DIRECT_MIN = 0.5  # border-clear fraction required (genuine transparency)

from PIL import Image  # noqa: E402


def find_sheet(work_dir: Path = WORK) -> Path:
    for ext in (".png", ".jpg", ".jpeg", ".webp"):
        p = work_dir / (STEM + ext)
        if p.exists():
            return p
    raise FileNotFoundError(f"missing sheet {STEM} in {work_dir}")


def border_clear_fraction(img: Image.Image, n: int = 24) -> float:
    """Fraction of evenly spaced border samples fully transparent."""
    img = img.convert("RGBA")
    w, h = img.size
    px = img.load()
    clear = 0
    for i in range(n):
        t = i / n
        if t < 0.25:
            x, y = round(t * 4 * (w - 1)), 0
        elif t < 0.5:
            x, y = w - 1, round((t - 0.25) * 4 * (h - 1))
        elif t < 0.75:
            x, y = round((1 - (t - 0.5) * 4) * (w - 1)), h - 1
        else:
            x, y = 0, round((1 - (t - 0.75) * 4) * (h - 1))
        if px[x, y][3] < 8:
            clear += 1
    return clear / n


def portrait_bounds(slice_img: Image.Image) -> tuple[int, int, int, int]:
    """Stray-tolerant content box: opaque-pixel bbox + fringe pad.

    Only the measurement ignores faint pixels; the returned box is then
    used to crop the ORIGINAL pixels (alpha preserved).
    """
    rgba = slice_img.convert("RGBA")
    w, h = rgba.size
    alpha = rgba.split()[3].tobytes()
    pts = [(x, y) for y in range(h) for x in range(w) if alpha[y * w + x] > OPAQUE_AT]
    if not pts:
        raise ValueError("empty portrait: no opaque pixels")
    min_x = min(x for x, _ in pts)
    max_x = max(x for x, _ in pts)
    min_y = min(y for _, y in pts)
    max_y = max(y for _, y in pts)
    return (max(0, min_x - FRINGE_PAD), max(0, min_y - FRINGE_PAD),
            min(w, max_x + 1 + FRINGE_PAD), min(h, max_y + 1 + FRINGE_PAD))


def fit_portrait_cell(content: Image.Image) -> tuple[Image.Image, float]:
    """Scale content to fit CELL, center horizontally, pin head (top)."""
    w, h = content.size
    s = min(CELL / w, CELL / h)
    grown = content.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
    cell = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    cell.alpha_composite(grown, ((CELL - grown.size[0]) // 2, 0))
    return cell, s


def opaque_count(img: Image.Image) -> int:
    return sum(1 for b in img.convert("RGBA").split()[3].tobytes() if b > OPAQUE_AT)


def validate_cells(cells: list[tuple[str, Image.Image, float]]) -> list[str]:
    """Portrait gates (no feet-grounding, no bottom-band tripwire)."""
    fails: list[str] = []
    opaques = {k: opaque_count(c) for k, c, _ in cells}
    for k, n in opaques.items():
        if n < MIN_OPAQUE:
            fails.append(f"{k}: too few opaque px ({n})")
    if max(opaques.values()) / max(1, min(opaques.values())) > RATIO_CAP:
        fails.append(f"portrait opaque spread exceeds {RATIO_CAP}: {opaques}")
    scales = [s for _, _, s in cells]
    if (max(scales) - min(scales)) / max(scales) > SCALE_TOL:
        fails.append(f"head-scale spread exceeds {SCALE_TOL}: {[round(s, 4) for s in scales]}")
    for k, cell, _ in cells:
        bb = cell.convert("RGBA").getbbox()
        if not bb:
            fails.append(f"{k}: empty cell after fit")
            continue
        cx = (bb[0] + bb[2]) / 2
        if abs(cx - CELL / 2) > CENTER_TOL:
            fails.append(f"{k}: off-center by {abs(cx - CELL / 2):.1f}px")
        if bb[1] > TOP_TOL:
            fails.append(f"{k}: head not pinned (top={bb[1]})")
    return fails


def build(work_dir: Path = WORK,
          out_png: Path | None = None,
          out_json: Path | None = None,
          names: list[str] = PORTRAIT_NAMES) -> tuple[int, list[str]]:
    """Extract + validate portraits; returns (exit_code, fail_lines).

    Outputs default to an isolated temp directory (never public/). Raises
    FileNotFoundError on a missing sheet. Outputs are written only when
    all portrait gates pass.
    """
    if out_png is None or out_json is None:
        tmp = Path(tempfile.mkdtemp(prefix="keeper-portraits-"))
        out_png = out_png or tmp / "keeper_expr.png"
        out_json = out_json or tmp / "keeper_expr.json"
    fails: list[str] = []
    sheet = Image.open(find_sheet(work_dir)).convert("RGBA")
    if border_clear_fraction(sheet) < ALPHA_DIRECT_MIN:
        return 1, ["sheet background is not genuinely transparent"]
    w, h = sheet.size
    count = len(names)
    cw = w / count

    # cut columns must be empty (no portrait overlap / clipping)
    for i in range(1, count):
        x = round(i * cw)
        if x >= w:
            continue
        col = sum(1 for y in range(h) if sheet.getpixel((x, y))[3] > OPAQUE_AT)
        if col:
            fails.append(f"cut column {x} hits portrait ({col} opaque px)")

    cells: list[tuple[str, Image.Image, float]] = []
    for i, name in enumerate(names):
        x0 = round(i * cw)
        x1 = round((i + 1) * cw) if i < count - 1 else w
        crop = sheet.crop((x0, 0, x1, h))
        key = f"keeper_expr_{name}"
        try:
            box = portrait_bounds(crop)
        except ValueError:
            fails.append(f"{key}: empty portrait")
            continue
        content = crop.crop(box)
        cell, scale = fit_portrait_cell(content)
        cells.append((key, cell, scale))

    if len(cells) != count:
        return 1, fails

    fails.extend(validate_cells(cells))

    opaques = {k: opaque_count(c) for k, c, _ in cells}
    print(f"portraits={len(cells)}")
    for (k, cell, s) in cells:
        bb = cell.convert("RGBA").getbbox()
        print(f"  {k}: bbox={bb} opaque={opaques[k]} scale={s:.4f}")
    if fails:
        print("FAIL:")
        for f in fails:
            print("  " + f)
        return 1, fails

    strip = Image.new("RGBA", (CELL * count, CELL), (0, 0, 0, 0))
    frames = {}
    for idx, (key, cell, _) in enumerate(cells):
        strip.alpha_composite(cell, (idx * CELL, 0))
        frames[key] = {
            "frame": {"x": idx * CELL, "y": 0, "w": CELL, "h": CELL},
            "rotated": False,
            "trimmed": False,
            "spriteSourceSize": {"x": 0, "y": 0, "w": CELL, "h": CELL},
            "sourceSize": {"w": CELL, "h": CELL},
        }
    out_png.parent.mkdir(parents=True, exist_ok=True)
    strip.save(out_png)
    out_json.write_text(json.dumps(
        {"frames": frames, "meta": {"app": "tidebound-p1", "version": "1.0",
                                    "image": out_png.name,
                                    "size": {"w": strip.size[0], "h": strip.size[1]},
                                    "scale": "1"}}, indent=1))
    print("ALL PORTRAIT GATES PASS")
    return 0, []


def main() -> int:
    code, _ = build()
    return code


if __name__ == "__main__":
    sys.exit(main())
