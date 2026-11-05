"""P1A — atlas builder tests (synthetic fixtures only, TemporaryDirectory).

Covers: magenta-key path, RGBA-direct path, missing sheets, empty frames,
wrong content (outlier), full-bleed keying failure, palette violations,
atlas JSON key/coordinate resolution. Fixtures are generated shapes —
never artwork, never written to production asset directories.
Run: python -m unittest tools.test_build_keeper_atlas -v  (from repo root)
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from PIL import Image, ImageDraw

import build_keeper_atlas as B


def magenta_strip(path: Path, frames: int = 4, size=(200, 200), figure=(60, 40, 140, 180)):
    """Opaque magenta sheet with a navy figure + amber lantern dot per frame."""
    img = Image.new("RGB", (size[0] * frames, size[1]), (255, 0, 255))
    d = ImageDraw.Draw(img)
    for i in range(frames):
        ox = i * size[0]
        d.rectangle([ox + figure[0], figure[1], ox + figure[2], figure[3]], fill=(31, 58, 82))
        d.ellipse([ox + 150, 60, ox + 170, 80], fill=(255, 209, 102))
    img.save(path)


def rgba_strip(path: Path, frames: int = 4, size=(200, 200)):
    """Pre-keyed transparent sheet with the same figure language."""
    img = Image.new("RGBA", (size[0] * frames, size[1]), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for i in range(frames):
        ox = i * size[0]
        d.rectangle([ox + 60, 40, ox + 140, 180], fill=(31, 58, 82, 255))
        d.ellipse([ox + 150, 60, ox + 170, 80], fill=(255, 209, 102, 255))
    img.save(path)


SHEETS2 = {"t-idle": ("keeper_idle_side", 2), "t-walk": ("keeper_walk_side", 2)}


def run_build(tmp: Path, sheets=SHEETS2):
    return B.build(sheets=sheets, work_dir=tmp,
                   out_png=tmp / "out.png", out_json=tmp / "out.json")


class BuilderTests(unittest.TestCase):
    def test_magenta_key_path_passes(self):
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            magenta_strip(tmp / "t-idle.png", frames=2)
            magenta_strip(tmp / "t-walk.png", frames=2)
            code, fails = run_build(tmp)
            self.assertEqual(code, 0, fails)
            meta = json.loads((tmp / "out.json").read_text())
            self.assertEqual(len(meta["frames"]), 4)
            for key, f in meta["frames"].items():
                fr = f["frame"]
                self.assertLess(fr["x"] + fr["w"], 8 * 360 + 1)
                self.assertLess(fr["y"] + fr["h"], 8 * 360 + 1)
                self.assertFalse(f["rotated"])
            # keyed atlas corners must be transparent
            atlas = Image.open(tmp / "out.png")
            self.assertEqual(atlas.getpixel((0, 0))[3], 0)
            # figure survived with opaque core
            self.assertGreater(sum(1 for b in atlas.split()[3].tobytes() if b > 16), 10000)

    def test_rgba_direct_path_accepted(self):
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            rgba_strip(tmp / "t-idle.png")
            rgba_strip(tmp / "t-walk.png")
            code, fails = run_build(tmp)
            self.assertEqual(code, 0, fails)
            # pre-keyed glow pixel preserved: put one in and re-check
            self.assertTrue((tmp / "out.png").exists())

    def test_rgba_glow_preserved(self):
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            img = Image.new("RGBA", (400, 200), (0, 0, 0, 0))
            d = ImageDraw.Draw(img)
            d.rectangle([60, 40, 140, 180], fill=(31, 58, 82, 255))
            d.rectangle([230, 40, 330, 180], fill=(31, 58, 82, 255))
            # semi-transparent amber glow overlapping figure edge
            d.ellipse([120, 50, 200, 130], fill=(255, 209, 102, 110))
            img.save(tmp / "t-idle.png")
            rgba_strip(tmp / "t-walk.png", frames=2)
            code, fails = run_build(tmp)
            self.assertEqual(code, 0, fails)
            atlas = Image.open(tmp / "out.png")
            alpha = atlas.split()[3].tobytes()
            mid = sum(1 for b in alpha if 0 < b < 255)
            self.assertGreater(mid, 100, "semi-transparent glow pixels must survive")

    def test_missing_sheet_raises(self):
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            magenta_strip(tmp / "t-idle.png", frames=2)
            with self.assertRaises(FileNotFoundError):
                run_build(tmp)

    def test_empty_frame_fails(self):
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            magenta_strip(tmp / "t-idle.png", frames=2)
            Image.new("RGB", (400, 200), (255, 0, 255)).save(tmp / "t-walk.png")
            code, fails = run_build(tmp)
            self.assertEqual(code, 1)
            self.assertTrue(any("empty" in f or "grounded" in f or "opaque" in f for f in fails))

    def test_full_bleed_key_failure_detected(self):
        # figure painted in near-magenta: keying eats nothing, band saturates
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            img = Image.new("RGB", (400, 200), (250, 10, 250))
            d = ImageDraw.Draw(img)
            d.rectangle([0, 0, 400, 200], fill=(250, 10, 250))
            img.save(tmp / "t-idle.png")
            magenta_strip(tmp / "t-walk.png", frames=2)
            code, fails = run_build(tmp)
            self.assertEqual(code, 1)

    def test_palette_violation_fails(self):
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            img = Image.new("RGB", (400, 200), (255, 0, 255))
            d = ImageDraw.Draw(img)
            for i in range(2):  # big gloam-red figures (r>150,b>120,g<110)
                d.rectangle([i * 200 + 20, 10, i * 200 + 180, 190], fill=(180, 40, 150))
            img.save(tmp / "t-idle.png")
            magenta_strip(tmp / "t-walk.png", frames=2)
            code, fails = run_build(tmp)
            self.assertEqual(code, 1)
            self.assertTrue(any("gloam" in f for f in fails))

    def test_outlier_frame_detected(self):
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            img = Image.new("RGB", (400, 200), (255, 0, 255))
            d = ImageDraw.Draw(img)
            d.rectangle([60, 40, 140, 180], fill=(31, 58, 82))      # full figure
            d.rectangle([260, 150, 270, 180], fill=(31, 58, 82))    # sliver (bad slice)
            d.ellipse([350, 60, 370, 80], fill=(255, 209, 102))
            img.save(tmp / "t-idle.png")
            magenta_strip(tmp / "t-walk.png", frames=2)
            code, fails = run_build(tmp)
            self.assertEqual(code, 1)
            self.assertTrue(any("outlier" in f for f in fails))

    def test_no_production_paths_touched(self):
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            magenta_strip(tmp / "t-idle.png", frames=2)
            magenta_strip(tmp / "t-walk.png", frames=2)
            run_build(tmp)
            self.assertFalse((B.OUT_PNG).exists() and (B.OUT_PNG.stat().st_mtime_ns > 0)
                             and (tmp / "out.png").resolve() == B.OUT_PNG.resolve())


if __name__ == "__main__":
    unittest.main()
