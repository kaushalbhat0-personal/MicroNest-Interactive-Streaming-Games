"""P1C assembler tests (synthetic fixtures only, TemporaryDirectory).

Covers: 28-key merge with zero collisions, slot transparency enforcement,
fail-closed on upstream gate failure, determinism, source immutability,
animation-cell coordinate preservation. Never artwork, never production
asset directories.
Run: python -m unittest tools.test_assemble_keeper_atlas -v (repo root)
"""
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from PIL import Image, ImageDraw

import assemble_keeper_atlas as M
import build_keeper_atlas as A


def anim_sheet(path: Path, frames: int, size=(120, 120)):
    img = Image.new("RGB", (size[0] * frames, size[1]), (255, 0, 255))
    d = ImageDraw.Draw(img)
    for i in range(frames):
        ox = i * size[0]
        d.rectangle([ox + 30, 20, ox + 90, 110], fill=(31, 58, 82))
        d.ellipse([ox + 80, 30, ox + 100, 50], fill=(255, 209, 102))
    img.save(path)


def expr_sheet(path: Path, size=(120, 120)):
    img = Image.new("RGBA", (size[0] * 4, size[1]), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for i in range(4):
        ox = i * size[0]
        d.ellipse([ox + 35, 15, ox + 85, 75], fill=(210, 170, 140, 255))
        d.rectangle([ox + 25, 75, ox + 95, 120], fill=(31, 58, 82, 255))
    img.save(path)


def make_work(tmp: Path) -> Path:
    work = tmp / "work"
    work.mkdir()
    counts = {"idle": 4, "walk": 6, "strike": 4, "shield": 3,
              "mend": 4, "interact": 3}
    for stem, n in counts.items():
        anim_sheet(work / f"p1-sheet-{stem}.png", n)
    expr_sheet(work / "p1-sheet-expressions.png")
    return work


def assemble_tmp(work: Path, tmp: Path):
    return M.assemble(work_dir=work, out_png=tmp / "atlas.png",
                      out_json=tmp / "atlas.json")


class AssemblerTests(unittest.TestCase):
    def test_merge_28_keys_no_collisions(self):
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            work = make_work(tmp)
            code, fails, report = assemble_tmp(work, tmp)
            self.assertEqual(code, 0, fails)
            meta = json.loads((tmp / "atlas.json").read_text())
            self.assertEqual(len(meta["frames"]), 28)
            self.assertEqual(sorted(meta["frames"]), report["keys"])
            self.assertEqual(report["size"], [2520, 1440])
            for i in range(4):
                self.assertIn(f"keeper_idle_side_{i:02d}", meta["frames"])
            for name in ("neutral", "determined", "concerned", "hopeful"):
                fr = meta["frames"][f"keeper_expr_{name}"]["frame"]
                self.assertEqual((fr["w"], fr["h"]), (360, 360))
                self.assertEqual(fr["y"], 1080)  # last row slots
            atlas = Image.open(tmp / "atlas.png")
            self.assertEqual(atlas.size, (2520, 1440))
            self.assertEqual(atlas.getpixel((0, 0))[3], 0)

    def test_animation_coords_preserved(self):
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            work = make_work(tmp)
            M.assemble(work_dir=work, out_png=tmp / "atlas.png",
                       out_json=tmp / "atlas.json")
            code_a, _ = A.build(
                sheets={k: v for k, v in A.SHEETS.items() if k != "p1-sheet-expressions"},
                work_dir=work, out_png=tmp / "anim.png", out_json=tmp / "anim.json")
            self.assertEqual(code_a, 0)
            uni = json.loads((tmp / "atlas.json").read_text())["frames"]
            anim = json.loads((tmp / "anim.json").read_text())["frames"]
            for k, v in anim.items():
                self.assertEqual(uni[k]["frame"], v["frame"])

    def test_fail_closed_on_bad_sheet(self):
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            work = make_work(tmp)
            Image.new("RGB", (360, 120), (255, 0, 255)).save(work / "p1-sheet-walk.png")
            code, fails, _ = assemble_tmp(work, tmp)
            self.assertEqual(code, 1)
            self.assertTrue(fails)
            self.assertFalse((tmp / "atlas.png").exists())
            self.assertFalse((tmp / "atlas.json").exists())

    def test_deterministic_and_immutable(self):
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            work = make_work(tmp)
            before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                      for p in work.glob("*.png")}
            M.assemble(work_dir=work, out_png=tmp / "a.png", out_json=tmp / "a.json")
            png1 = (tmp / "a.png").read_bytes()
            meta1 = json.loads((tmp / "a.json").read_text())
            M.assemble(work_dir=work, out_png=tmp / "a.png", out_json=tmp / "a.json")
            self.assertEqual(png1, (tmp / "a.png").read_bytes())
            meta2 = json.loads((tmp / "a.json").read_text())
            self.assertEqual(meta1["frames"], meta2["frames"])
            self.assertEqual(meta1["meta"]["size"], meta2["meta"]["size"])
            after = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                     for p in work.glob("*.png")}
            self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
