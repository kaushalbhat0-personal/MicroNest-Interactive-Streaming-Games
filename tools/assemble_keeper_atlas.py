"""P1C isolated atlas assembly: validated animation cells + portrait cells.

Merges (never re-gates, never weakens):
  1. tools/build_keeper_atlas.py  — 6 full-body animation sheets (24 cells),
     with its production gates fully enforced (fail-closed).
  2. tools/build_keeper_portraits.py — 4 expression portraits, with its
     portrait gates fully enforced (fail-closed).

The 7-column layout of the animation atlas leaves exactly 4 empty slots
(indices 24-27, last row); the 4 portrait cells fill those slots, so every
animation frame keeps its validated coordinates. Slot transparency is
verified before pasting. Any gate failure anywhere aborts with NO output.

Outputs default to an isolated temp directory (never public/). Publish
to public/ only via an explicit out path in a later authorized step.
Pure Pillow, stdlib otherwise.
"""
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "design" / "art-bible" / "working"

sys.path.insert(0, str(ROOT / "tools"))

from PIL import Image

import build_keeper_atlas as B
import build_keeper_portraits as P

COLS = 7
CELL = 360
ANIM_COUNT = 24  # 4+6+4+3+4+3 full-body frames
PORTRAIT_COUNT = 4


def _frame_entry(x: int, y: int) -> dict:
    return {
        "frame": {"x": x, "y": y, "w": CELL, "h": CELL},
        "rotated": False,
        "trimmed": False,
        "spriteSourceSize": {"x": 0, "y": 0, "w": CELL, "h": CELL},
        "sourceSize": {"w": CELL, "h": CELL},
    }


def assemble(work_dir: Path = WORK,
             out_png: Path | None = None,
             out_json: Path | None = None) -> tuple[int, list[str], dict]:
    """Assemble the unified atlas; returns (exit_code, fail_lines, report).

    report carries dimensions, key inventory, hashes, and traceability
    (per-part output hashes) on success; outputs are written only when
    every upstream gate and every merge check passes.
    """
    fails: list[str] = []
    if out_png is None or out_json is None:
        tmp = Path(tempfile.mkdtemp(prefix="keeper-atlas-"))
        out_png = out_png or tmp / "tidebound_chars.png"
        out_json = out_json or tmp / "tidebound_chars.json"
    stage = Path(tempfile.mkdtemp(prefix="keeper-atlas-stage-"))

    anim_sheets = {k: v for k, v in B.SHEETS.items() if k != "p1-sheet-expressions"}
    code_a, fails_a = B.build(sheets=anim_sheets, work_dir=work_dir,
                              out_png=stage / "anim.png", out_json=stage / "anim.json")
    fails.extend(fails_a)
    code_p, fails_p = P.build(work_dir=work_dir,
                              out_png=stage / "expr.png", out_json=stage / "expr.json")
    fails.extend(fails_p)
    if code_a or code_p:
        return 1, fails, {"stage": "upstream-validation"}

    anim = Image.open(stage / "anim.png").convert("RGBA")
    strip = Image.open(stage / "expr.png").convert("RGBA")
    anim_frames = json.loads((stage / "anim.json").read_text())["frames"]
    expr_frames = json.loads((stage / "expr.json").read_text())["frames"]

    if len(anim_frames) != ANIM_COUNT:
        fails.append(f"animation cell count {len(anim_frames)} != {ANIM_COUNT}")
    if len(expr_frames) != PORTRAIT_COUNT:
        fails.append(f"portrait cell count {len(expr_frames)} != {PORTRAIT_COUNT}")
    if set(anim_frames) & set(expr_frames):
        fails.append("key collision between animation and portrait cells")
    expected_w, expected_h = COLS * CELL, ((ANIM_COUNT + PORTRAIT_COUNT + COLS - 1) // COLS) * CELL
    if anim.size != (expected_w, expected_h):
        fails.append(f"animation atlas size {anim.size} != {(expected_w, expected_h)}")
    if strip.size != (PORTRAIT_COUNT * CELL, CELL):
        fails.append(f"portrait strip size {strip.size} != {(PORTRAIT_COUNT * CELL, CELL)}")
    if fails:
        return 1, fails, {"stage": "merge-prechecks"}

    # Empty slots are indices 24..27 (last row, cols 3..6): verify transparent.
    atlas = anim.copy()
    frames = dict(anim_frames)
    for slot, name in enumerate(P.PORTRAIT_NAMES):
        key = f"keeper_expr_{name}"
        if key not in expr_frames:
            fails.append(f"missing portrait key {key}")
            continue
        idx = ANIM_COUNT + slot
        x, y = (idx % COLS) * CELL, (idx // COLS) * CELL
        region = atlas.crop((x, y, x + CELL, y + CELL))
        if any(b != 0 for b in region.split()[3].tobytes()):
            fails.append(f"slot {idx} ({x},{y}) not empty — refusing overwrite")
            continue
        cell = strip.crop((slot * CELL, 0, (slot + 1) * CELL, CELL))
        if cell.size != (CELL, CELL):
            fails.append(f"portrait cell {key} size {cell.size}")
            continue
        atlas.alpha_composite(cell, (x, y))
        frames[key] = _frame_entry(x, y)
    if fails:
        return 1, fails, {"stage": "merge"}

    if len(frames) != ANIM_COUNT + PORTRAIT_COUNT:
        return 1, [f"unified key count {len(frames)} != {ANIM_COUNT + PORTRAIT_COUNT}"], {"stage": "merge"}
    # Alpha integrity: unified opaque == sum of parts (paste into empty slots).
    part_opaque = sum(1 for b in anim.split()[3].tobytes() if b > 0)
    part_opaque += sum(1 for b in strip.split()[3].tobytes() if b > 0)
    uni_opaque = sum(1 for b in atlas.split()[3].tobytes() if b > 0)
    if uni_opaque != part_opaque:
        fails.append(f"alpha integrity: unified {uni_opaque} != parts {part_opaque}")
        return 1, fails, {"stage": "merge"}

    out_png.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(out_png)
    out_json.write_text(json.dumps(
        {"frames": frames, "meta": {"app": "tidebound-p1", "version": "1.0",
                                    "image": out_png.name,
                                    "size": {"w": atlas.size[0], "h": atlas.size[1]},
                                    "scale": "1"}}, indent=1))
    import hashlib
    report = {
        "size": list(atlas.size),
        "keys": sorted(frames),
        "png_sha256": hashlib.sha256(out_png.read_bytes()).hexdigest(),
        "json_sha256": hashlib.sha256(out_json.read_bytes()).hexdigest(),
        "opaque_px": uni_opaque,
    }
    print(f"cells={len(frames)} atlas={atlas.size[0]}x{atlas.size[1]} opaque={uni_opaque}")
    print("ALL ASSEMBLY CHECKS PASS")
    return 0, [], report


def main() -> int:
    code, fails, _ = assemble()
    for f in fails:
        print("FAIL: " + f)
    return code


if __name__ == "__main__":
    sys.exit(main())
