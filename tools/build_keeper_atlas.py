"""P1 keeper atlas builder: sheets -> 360px cells -> atlas PNG + Phaser JSON hash.

Usage: python tools/build_keeper_atlas.py  (run from repo root)
Reads design/art-bible/working/p1-sheet-*.png, writes
public/assets/tidebound/atlases/tidebound_chars.png/.json + validation report.
Pure Pillow, stdlib otherwise.

Two intake paths (auto-detected per sheet):
  RGBA-DIRECT — sheets with real transparency (transparent corners) skip
    keying; alpha is used as-is (despill + feather still applied).
  MAGENTA-KEY — opaque sheets on flat magenta are border flood-filled
    (see chroma_key). Preserved as fallback for generators that cannot
    emit transparency.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "design" / "art-bible" / "working"
OUT_PNG = ROOT / "public" / "assets" / "tidebound" / "atlases" / "tidebound_chars.png"
OUT_JSON = ROOT / "public" / "assets" / "tidebound" / "atlases" / "tidebound_chars.json"

CELL = 360
KEY_TOL = 48          # chroma-key distance from sampled background
DESPILL_LIMIT = 40    # max residual R/B dominance removed at edges
FEATHER_R = 1
ALPHA_DIRECT_MIN = 0.5  # fraction of transparent border samples => pre-keyed
BOTTOM_BAND = 8         # rows inspected for the grounding check
BOTTOM_BAND_MAX = 0.60  # band opaque fraction above this => full-bleed/key failure
MEDIAN_MIN_RATIO = 0.40  # frame opaque px below this x sheet median => outlier

# sheet file stem -> (frame key prefix, expected frame count)
SHEETS = {
    "p1-sheet-idle": ("keeper_idle_side", 4),
    "p1-sheet-walk": ("keeper_walk_side", 6),
    "p1-sheet-strike": ("keeper_strike_side", 4),
    "p1-sheet-shield": ("keeper_shield_side", 3),
    "p1-sheet-mend": ("keeper_mend_side", 4),
    "p1-sheet-interact": ("keeper_interact_side", 3),
    "p1-sheet-expressions": ("keeper_expr", 4),
}
EXPR_NAMES = ["neutral", "determined", "concerned", "hopeful"]

from PIL import Image, ImageFilter  # noqa: E402


def find_sheet(stem: str, work_dir: Path = WORK) -> Path:
    for ext in (".png", ".jpg", ".jpeg", ".webp"):
        p = work_dir / (stem + ext)
        if p.exists():
            return p
    raise FileNotFoundError(f"missing sheet {stem} (.png/.jpg/.webp) in {work_dir}")


def border_samples(img: Image.Image, n: int = 24) -> list[tuple[int, int, int, int]]:
    """Evenly spaced border pixels (corners + edges) for bg/alpha probing."""
    w, h = img.size
    pts = []
    for i in range(n):
        t = i / n
        if t < 0.25:
            pts.append((round(t * 4 * (w - 1)), 0))
        elif t < 0.5:
            pts.append((w - 1, round((t - 0.25) * 4 * (h - 1))))
        elif t < 0.75:
            pts.append((round((1 - (t - 0.5) * 4) * (w - 1)), h - 1))
        else:
            pts.append((0, round((1 - (t - 0.75) * 4) * (h - 1))))
    px = img.load()
    return [px[x, y] for x, y in pts]


def has_alpha_background(img: Image.Image) -> bool:
    """True when the sheet already carries transparency (RGBA-direct path).

    Requires the image to have an alpha channel AND a majority of border
    samples fully transparent — a figure touching the sheet edge will not
    false-positive from one or two samples.
    """
    img = img.convert("RGBA")
    samples = border_samples(img)
    clear = sum(1 for c in samples if c[3] < 8)
    return clear / len(samples) >= ALPHA_DIRECT_MIN


def chroma_key(img: Image.Image) -> Image.Image:
    """Border flood-fill magenta removal + despill + 1px feather."""
    return finish_rgba(kill_background(img))


def kill_background(img: Image.Image) -> Image.Image:
    """Flood-fill keying WITHOUT despill/feather (validation probe).

    finish_rgba would pull magenta cast out of edge pixels and launder
    borderline palette violations below the gloam thresholds, so the
    palette gate always runs on this raw output (see gloam_fraction).
    """
    img = img.convert("RGBA")
    w, h = img.size
    px = img.load()
    samples = [px[x, y][:3] for x, y in
               [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3),
                (w // 2, 2), (w // 2, h - 3), (2, h // 2), (w - 3, h // 2)]]

    def is_bg(c, bg):
        return (abs(c[0] - bg[0]) < KEY_TOL and abs(c[1] - bg[1]) < KEY_TOL
                and abs(c[2] - bg[2]) < KEY_TOL)

    bg = tuple(sum(c[i] for c in samples) // len(samples) for i in range(3))
    from collections import deque
    kill = bytearray(w * h)
    q = deque()
    for x in range(w):
        q += [(x, 0), (x, h - 1)]
    for y in range(h):
        q += [(0, y), (w - 1, y)]
    while q:
        x, y = q.popleft()
        if not (0 <= x < w and 0 <= y < h) or kill[y * w + x]:
            continue
        c = px[x, y]
        if c[3] < 8 or is_bg(c[:3], bg):
            kill[y * w + x] = 1
            q += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out.paste(img, (0, 0), _kill_mask_as_alpha(kill, w, h, img))
    return out


def _kill_mask_as_alpha(kill: bytearray, w: int, h: int, src: Image.Image) -> Image.Image:
    """Alpha mask: 0 where flood-filled, else the source alpha."""
    mask = bytearray(w * h)
    src_a = src.split()[3].tobytes()
    for i, k in enumerate(kill):
        mask[i] = 0 if k else src_a[i]
    return Image.frombytes("L", (w, h), bytes(mask))


def finish_rgba(img: Image.Image) -> Image.Image:
    """Shared finish for both intake paths: magenta despill + 1px feather.

    Despill only touches pixels where R AND B both dominate G (magenta
    cast). Amber lantern glow (G-rich), teal ward (G-dominant) and neutral
    mist pass through untouched; soft painted edges survive with a 1px
    alpha feather instead of a hard cut.
    """
    img = img.convert("RGBA")
    w, h = img.size
    px = img.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a > 0 and r > g and b > g:
                cut = min(r - g, b - g, DESPILL_LIMIT)
                px[x, y] = (r - cut, g, b - cut, a)
    alpha = img.split()[3].filter(ImageFilter.GaussianBlur(FEATHER_R))
    img.putalpha(alpha)
    return img


def prepare_frame(frame: Image.Image, prekeyed: bool) -> Image.Image:
    """RGBA-direct (pre-keyed sheet) or magenta-key a single frame crop."""
    if prekeyed:
        return finish_rgba(frame)
    return chroma_key(frame)


def fit_cell(img: Image.Image) -> Image.Image:
    """Trim to content, scale to fit 360px box, pin feet to bottom-center."""
    bbox = img.getbbox()
    if not bbox:
        raise ValueError("empty frame after keying")
    img = img.crop(bbox)
    w, h = img.size
    s = min(CELL / w, CELL / h)
    img = img.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
    cell = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    cell.alpha_composite(img, ((CELL - img.size[0]) // 2, CELL - img.size[1]))
    return cell


def gloam_fraction(cell: Image.Image) -> float:
    """Fraction of opaque pixels reading gloam-ish (r>150,b>120,g<110).

    MUST be evaluated on pre-despill pixels: finish_rgba deliberately
    pulls magenta cast out of edge pixels, which would launder borderline
    violations below the thresholds. Catches magenta/purple intrusion
    (failed keys, wrong-palette paint); true violet shade (r<150) and
    ember/amber (g-rich) pass by design.
    """
    rgb = cell.convert("RGB").tobytes()
    alpha = cell.split()[3].tobytes()
    n = glo = 0
    for i in range(len(alpha)):
        if alpha[i] > 16:
            n += 1
            r, g, b = rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]
            if r > 150 and b > 120 and g < 110:
                glo += 1
    return glo / n if n else 1.0


def _opaque_count(img: Image.Image) -> int:
    """Opaque-pixel count via alpha bytes (no deprecated getdata)."""
    return sum(1 for b in img.split()[3].tobytes() if b > 16)


def bottom_band_fraction(cell: Image.Image) -> float:
    """Opaque fraction of the bottom BOTTOM_BAND rows (grounding probe).

    fit_cell pins content to the cell bottom by construction, so this is
    0 only for empty cells and ~1.0 for full-bleed keying failures —
    both are defects worth failing on.
    """
    w, h = cell.size
    band = cell.crop((0, h - BOTTOM_BAND, w, h))
    raw = band.split()[3].tobytes()
    return sum(1 for b in raw if b > 16) / len(raw)


def build(sheets: dict[str, tuple[str, int]] = SHEETS,
          work_dir: Path = WORK,
          out_png: Path = OUT_PNG,
          out_json: Path = OUT_JSON,
          expr_names: list[str] = EXPR_NAMES) -> tuple[int, list[str]]:
    """Build the atlas; returns (exit_code, fail_lines). Pure stdlib+Pillow,
    deterministic, no randomness. Raises FileNotFoundError on missing sheets
    (fail-fast: nothing to validate). Empty frames are recorded as gate
    failures (exit 1) with atlas indices kept stable; outputs are written
    only when all gates pass."""
    cells: list[tuple[str, Image.Image]] = []
    report = []
    for stem, (prefix, count) in sheets.items():
        sheet = Image.open(find_sheet(stem, work_dir))
        prekeyed = has_alpha_background(sheet)
        w, h = sheet.size
        cw = w / count
        for i in range(count):
            x0 = round(i * cw)
            x1 = round((i + 1) * cw) if i < count - 1 else w
            crop = sheet.crop((x0, 0, x1, h))
            # Palette gate runs on PRE-despill pixels (finish_rgba would
            # launder borderline violations below threshold).
            probe = crop.convert("RGBA") if prekeyed else kill_background(crop)
            gf = gloam_fraction(probe)
            frame = finish_rgba(probe)
            key = f"{prefix}_{i:02d}" if prefix != "keeper_expr" else f"keeper_expr_{expr_names[i]}"
            try:
                cell = fit_cell(frame)
            except ValueError:
                # Empty after keying: record ONE fail, keep a blank
                # placeholder so atlas indices stay stable.
                cell = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
                report.append({"key": key, "bbox": None, "opaque_px": 0,
                               "gloam_frac": round(gf, 4),
                               "band": 0.0, "empty": True})
                cells.append((key, cell))
                continue
            ob = cell.getbbox()
            opaque = _opaque_count(cell)
            report.append({"key": key, "bbox": ob, "opaque_px": opaque,
                           "gloam_frac": round(gf, 4),
                           "band": round(bottom_band_fraction(cell), 4)})
            cells.append((key, cell))

    cols = 7
    rows = (len(cells) + cols - 1) // cols
    atlas = Image.new("RGBA", (cols * CELL, rows * CELL), (0, 0, 0, 0))
    frames = {}
    for idx, (key, cell) in enumerate(cells):
        cx, cy = (idx % cols) * CELL, (idx // cols) * CELL
        atlas.alpha_composite(cell, (cx, cy))
        frames[key] = {
            "frame": {"x": cx, "y": cy, "w": CELL, "h": CELL},
            "rotated": False,
            "trimmed": False,
            "spriteSourceSize": {"x": 0, "y": 0, "w": CELL, "h": CELL},
            "sourceSize": {"w": CELL, "h": CELL},
        }

    # ---- structural validation gates (before writing) ----
    fails = []
    by_sheet: dict[str, list[int]] = {}
    for r in report:
        sheet = r["key"].rsplit("_", 2)[0] if "expr" not in r["key"] else "keeper_expr"
        by_sheet.setdefault(sheet, []).append(r["opaque_px"])
    medians = {k: sorted(v)[len(v) // 2] for k, v in by_sheet.items()}
    for r in report:
        if r.get("empty"):
            fails.append(f'{r["key"]}: empty after keying')
            continue
        if r["opaque_px"] < 2000:
            fails.append(f'{r["key"]}: too few opaque px ({r["opaque_px"]})')
        if r["band"] <= 0:
            fails.append(f'{r["key"]}: nothing grounded in bottom band')
        if r["band"] > BOTTOM_BAND_MAX:
            fails.append(f'{r["key"]}: bottom band {r["band"]} — full-bleed, keying failed?')
        sheet = r["key"].rsplit("_", 2)[0] if "expr" not in r["key"] else "keeper_expr"
        if r["opaque_px"] < medians[sheet] * MEDIAN_MIN_RATIO:
            fails.append(f'{r["key"]}: outlier vs sheet median ({r["opaque_px"]} < {medians[sheet]})')
        if r["gloam_frac"] > 0.005:
            fails.append(f'{r["key"]}: gloam frac {r["gloam_frac"]}')

    print(f"frames={len(cells)} atlas={atlas.size[0]}x{atlas.size[1]}")
    for r in report:
        print(f'  {r["key"]}: bbox={r["bbox"]} opaque={r["opaque_px"]} band={r["band"]} gloam={r["gloam_frac"]}')
    if fails:
        print("FAIL:")
        for f in fails:
            print("  " + f)
        return 1, fails

    out_png.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(out_png)
    out_json.write_text(json.dumps(
        {"frames": frames, "meta": {"app": "tidebound-p1", "version": "1.0",
                                    "image": out_png.name, "size": {"w": atlas.size[0], "h": atlas.size[1]},
                                    "scale": "1"}}, indent=1))
    print("ALL STRUCTURAL GATES PASS")
    return 0, []


def main() -> int:
    code, _ = build()
    return code


if __name__ == "__main__":
    sys.exit(main())
