"""P1P — portrait pipeline tests (synthetic fixtures only, TemporaryDirectory).

Covers: four-portrait extraction, alpha preservation (no global
thresholding), stray perimeter-pixel tolerance, empty portrait rejection,
scale-outlier rejection, alignment gates, determinism, exact key names +
JSON coordinates, source immutability, and animation-pipeline guards
(EXPR_NAMES agreement + full-body gate constants untouched). Fixtures are
generated shapes — never artwork, never production asset directories.
Run: python -m unittest tools.test_build_keeper_portraits -v (repo root)
"""
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from PIL import Image, ImageDraw

import build_keeper_atlas as A
import build_keeper_portraits as P


def bust_strip(path: Path, frames: int = 4, size=(180, 200),
               head=(50, 20, 130, 110), torso=(30, 110, 150, 200)):
    """Transparent sheet with per-frame navy bust + amber clasp dot."""
    img = Image.new("RGBA", (size[0] * frames, size[1]), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for i in range(frames):
        ox = i * size[0]
        d.ellipse([ox + head[0], head[1], ox + head[2], head[3]],
                  fill=(210, 170, 140, 255))
        d.rectangle([ox + torso[0], torso[1], ox + torso[2], torso[3]],
                    fill=(31, 58, 82, 255))
        d.ellipse([ox + 80, 120, ox + 100, 140], fill=(255, 209, 102, 255))
    img.save(path)


def run_build(tmp: Path, names=None):
    kw = {} if names is None else {"names": names}
    return P.build(work_dir=tmp, out_png=tmp / "out.png",
                   out_json=tmp / "out.json", **kw)


class PortraitTests(unittest.TestCase):
    def test_four_portraits_keys_and_coords(self):
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            bust_strip(tmp / "p1-sheet-expressions.png")
            code, fails = run_build(tmp)
            self.assertEqual(code, 0, fails)
            meta = json.loads((tmp / "out.json").read_text())
            self.assertEqual(sorted(meta["frames"]),
                             ["keeper_expr_concerned", "keeper_expr_determined",
                              "keeper_expr_hopeful", "keeper_expr_neutral"])
            for idx, name in enumerate(P.PORTRAIT_NAMES):
                fr = meta["frames"][f"keeper_expr_{name}"]["frame"]
                self.assertEqual((fr["x"], fr["y"], fr["w"], fr["h"]),
                                 (idx * 360, 0, 360, 360))
            strip = Image.open(tmp / "out.png")
            self.assertEqual(strip.size, (1440, 360))
            self.assertEqual(strip.getpixel((0, 0))[3], 0)  # transparent corner

    def test_alpha_preserved_no_threshold(self):
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            img = Image.new("RGBA", (720, 200), (0, 0, 0, 0))
            d = ImageDraw.Draw(img)
            for i in range(4):
                ox = i * 180
                d.ellipse([ox + 50, 20, ox + 130, 110], fill=(210, 170, 140, 255))
                d.rectangle([ox + 30, 110, ox + 150, 200], fill=(31, 58, 82, 255))
                # semi-transparent glow overlapping the bust edge
                d.ellipse([ox + 100, 60, ox + 170, 140], fill=(255, 209, 102, 110))
            img.save(tmp / "p1-sheet-expressions.png")
            code, fails = run_build(tmp)
            self.assertEqual(code, 0, fails)
            mid = sum(1 for b in Image.open(tmp / "out.png").split()[3].tobytes()
                      if 0 < b < 255)
            self.assertGreater(mid, 100, "semi-transparent edge pixels must survive")

    def test_stray_perimeter_pixels_tolerated(self):
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            bust_strip(tmp / "p1-sheet-expressions.png")
            img = Image.open(tmp / "p1-sheet-expressions.png")
            px = img.load()
            px[0, 0] = (0, 0, 0, 1)          # invisible noise, 3 corners
            px[0, 199] = (0, 0, 0, 2)
            px[719, 0] = (255, 0, 0, 1)
            img.save(tmp / "p1-sheet-expressions.png")
            code, fails = run_build(tmp)
            self.assertEqual(code, 0, fails)

    def test_empty_portrait_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            bust_strip(tmp / "p1-sheet-expressions.png")
            img = Image.open(tmp / "p1-sheet-expressions.png")
            img.crop((180, 0, 360, 200))  # keep shape; now blank frame 1
            blank = Image.new("RGBA", (720, 200), (0, 0, 0, 0))
            d = ImageDraw.Draw(blank)
            for i in (0, 2, 3):
                ox = i * 180
                d.ellipse([ox + 50, 20, ox + 130, 110], fill=(210, 170, 140, 255))
                d.rectangle([ox + 30, 110, ox + 150, 200], fill=(31, 58, 82, 255))
            blank.save(tmp / "p1-sheet-expressions.png")
            code, fails = run_build(tmp)
            self.assertEqual(code, 1)
            self.assertTrue(any("empty" in f for f in fails))

    def test_scale_outlier_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            img = Image.new("RGBA", (720, 200), (0, 0, 0, 0))
            d = ImageDraw.Draw(img)
            for i in range(4):
                ox = i * 180
                if i == 2:  # giant bust: fills the whole slice
                    d.ellipse([ox + 5, 5, ox + 175, 150], fill=(210, 170, 140, 255))
                    d.rectangle([ox, 140, ox + 180, 200], fill=(31, 58, 82, 255))
                else:
                    d.ellipse([ox + 70, 60, ox + 110, 110], fill=(210, 170, 140, 255))
                    d.rectangle([ox + 60, 110, ox + 120, 200], fill=(31, 58, 82, 255))
            img.save(tmp / "p1-sheet-expressions.png")
            code, fails = run_build(tmp)
            self.assertEqual(code, 1)
            self.assertTrue(any("scale" in f or "spread" in f for f in fails))

    def test_alignment_gate_catches_offset(self):
        bad = Image.new("RGBA", (360, 360), (0, 0, 0, 0))
        d = ImageDraw.Draw(bad)
        d.rectangle([250, 0, 359, 200], fill=(31, 58, 82, 255))  # jammed right
        good, _ = P.fit_portrait_cell(
            Image.new("RGBA", (100, 200), (31, 58, 82, 255)))
        cells = [(f"keeper_expr_{n}", good, 1.0) for n in P.PORTRAIT_NAMES[:3]]
        cells.append(("keeper_expr_hopeful", bad, 1.0))
        fails = P.validate_cells(cells)
        self.assertTrue(any("off-center" in f or "pinned" in f or "spread" in f
                            for f in fails))

    def test_deterministic_output(self):
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            bust_strip(tmp / "p1-sheet-expressions.png")
            run_build(tmp)
            first = (tmp / "out.png").read_bytes()
            (tmp / "out.png").unlink()
            run_build(tmp)
            self.assertEqual(first, (tmp / "out.png").read_bytes())

    def test_source_immutable(self):
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            bust_strip(tmp / "p1-sheet-expressions.png")
            before = hashlib.sha256((tmp / "p1-sheet-expressions.png").read_bytes())
            run_build(tmp)
            after = hashlib.sha256((tmp / "p1-sheet-expressions.png").read_bytes())
            self.assertEqual(before.hexdigest(), after.hexdigest())

    def test_missing_sheet_raises(self):
        with tempfile.TemporaryDirectory() as t:
            with self.assertRaises(FileNotFoundError):
                run_build(Path(t))

    def test_expr_names_agree_with_builder(self):
        self.assertEqual(P.PORTRAIT_NAMES, A.EXPR_NAMES)
        self.assertEqual(P.PORTRAIT_NAMES,
                         ["neutral", "determined", "concerned", "hopeful"])

    def test_animation_pipeline_untouched(self):
        self.assertEqual((A.CELL, A.KEY_TOL, A.DESPILL_LIMIT, A.FEATHER_R,
                          A.BOTTOM_BAND, A.BOTTOM_BAND_MAX, A.MEDIAN_MIN_RATIO),
                         (360, 48, 40, 1, 8, 0.60, 0.40))
        self.assertEqual(A.SHEETS["p1-sheet-idle"], ("keeper_idle_side", 4))
        self.assertEqual(A.SHEETS["p1-sheet-walk"], ("keeper_walk_side", 6))
        self.assertEqual(A.SHEETS["p1-sheet-strike"], ("keeper_strike_side", 4))
        self.assertEqual(A.SHEETS["p1-sheet-shield"], ("keeper_shield_side", 3))
        self.assertEqual(A.SHEETS["p1-sheet-mend"], ("keeper_mend_side", 4))
        self.assertEqual(A.SHEETS["p1-sheet-interact"], ("keeper_interact_side", 3))
        self.assertFalse(hasattr(A, "validate_cells"),
                         "no portrait exceptions in the full-body path")


if __name__ == "__main__":
    unittest.main()
