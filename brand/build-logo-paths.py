#!/usr/bin/env python3
"""
Regenerate components/logo-paths.ts: the FoneNova wordmark as SVG outlines, cut from Inter.

Why outlines and not live text: the lockup is eight letters and a subline, so loading a
webfont for it costs a request and can reflow if the font is slow. Outlines are inline,
cannot shift, and still take currentColor and var(--primary), which an <img> could not.

Why Inter: it is the typeface of the site's headline and body, so the logo now reads as
part of the same system. These are the TEXT cuts (Inter-*.otf), not InterDisplay-*: the
site loads Next's Inter, which is the text cut, so these are the shapes visitors see.

Run (needs fonttools and uharfbuzz, and Inter's static OTFs):

    pip install fonttools uharfbuzz
    python3 brand/build-logo-paths.py            # writes components/logo-paths.ts
    python3 brand/build-logo-paths.py --check    # prints metrics, writes nothing

Inter is SIL Open Font License 1.1 (Rasmus Andersson). The static OTFs are in the Inter
release zip at https://github.com/rsms/inter/releases, or often under
/usr/share/fonts/opentype/inter/ on Linux. Point --fonts at the folder if elsewhere.

Do not hand-edit the generated file. Change the options here and run it again.
"""

import argparse
import math
import pathlib
import sys

try:
    import uharfbuzz as hb
    from fontTools.pens.boundsPen import BoundsPen
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.pens.transformPen import TransformPen
    from fontTools.ttLib import TTFont
except ImportError:
    sys.exit("Needs fonttools and uharfbuzz: pip install fonttools uharfbuzz")

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "components" / "logo-paths.ts"

UNITS = 1000  # every coordinate is written at 1000 units per em, baseline at y = 0

# The subline sits below the wordmark. These two numbers are the layout, in the same
# 1000-unit space: the gap from the wordmark's baseline to the top of the subline's caps,
# and the subline's cap height. They are kept from the Archivo version so the lockup
# proportions do not change when only the letter shapes do.
SUBLINE_TOP = 233
SUBLINE_CAP = 165


class Run:
    """One shaped line of text: which glyphs, where, and how to draw them at any offset."""

    def __init__(self, fonts, weight, text, tracking_em, scale_to):
        path = pathlib.Path(fonts) / f"Inter-{weight}.otf"
        if not path.exists():
            sys.exit(f"Missing {path}. Pass --fonts <folder holding Inter-{weight}.otf>.")
        self.tt = TTFont(str(path))
        self.upm = self.tt["head"].unitsPerEm
        self.cap_units = self.tt["OS/2"].sCapHeight
        self.glyphs = self.tt.getGlyphSet()
        self.order = self.tt.getGlyphOrder()
        # scale_to is either a font size in output units (UNITS for the wordmark) or None
        # for "set so the caps are SUBLINE_CAP tall".
        self.scale = (scale_to if scale_to else SUBLINE_CAP / self.cap_units * self.upm) / self.upm

        face = hb.Face(hb.Blob.from_file_path(str(path)))
        font = hb.Font(face)
        buf = hb.Buffer()
        buf.add_str(text)
        buf.guess_segment_properties()
        # Kerning is Inter's own. Ligatures off: these are caps and a logo, not prose.
        hb.shape(font, buf, {"kern": True, "liga": False})

        track = tracking_em * self.upm
        pen_x, self.items = 0.0, []
        for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
            self.items.append((self.order[info.codepoint], pen_x + pos.x_offset))
            pen_x += pos.x_advance + track

    def _transform(self, x, dx, dy):
        # Font y points up and SVG y points down, so flip y. dx and dy are output units.
        return (self.scale, 0, 0, -self.scale, x * self.scale + dx, dy)

    def ink(self):
        """Edges of the drawn letters (side bearings ignored), in output units, y down."""
        lefts, tops, rights, bottoms = [], [], [], []
        for name, x in self.items:
            bp = BoundsPen(self.glyphs)
            self.glyphs[name].draw(TransformPen(bp, self._transform(x, 0, 0)))
            if bp.bounds:
                lefts.append(bp.bounds[0])
                tops.append(bp.bounds[1])
                rights.append(bp.bounds[2])
                bottoms.append(bp.bounds[3])
        return min(lefts), min(tops), max(rights), max(bottoms)

    def path(self, dx, dy, start=0, stop=None):
        """SVG path data for glyphs [start:stop], shifted, integer coordinates."""
        parts = []
        for name, x in self.items[start:stop]:
            pen = SVGPathPen(self.glyphs, ntos=lambda v: str(round(v)))
            self.glyphs[name].draw(TransformPen(pen, self._transform(x, dx, dy)))
            d = pen.getCommands()
            if d:
                parts.append(d)
        return " ".join(parts)


def build(args):
    # Wordmark: shaped as ONE run so kerning carries across the E to N join, then split.
    word = Run(args.fonts, args.weight, "FONENOVA", args.tracking, UNITS)
    assert len(word.items) == 8, "expected 8 glyphs for FONENOVA"
    cap = round(word.cap_units / word.upm * UNITS)
    w_left, w_top, w_right, w_bottom = word.ink()
    word_w = w_right - w_left

    sub = Run(args.fonts, args.subline_weight, "WHOLESALE DISTRIBUTION", args.subline_tracking, None)
    s_left, _s_top, s_right, s_bottom = sub.ink()
    sub_w = s_right - s_left

    # Each line's ink starts at x = 0. The narrower one is then centred under the wider one
    # by arithmetic, not by eye, and the offsets are emitted as wordDx and subDx for
    # logo.tsx to apply as a transform (the same shape the Archivo version had).
    box_w = max(word_w, sub_w)
    sub_baseline = SUBLINE_TOP + SUBLINE_CAP

    # The viewBox hugs the real ink, not the cap line and baseline: round letters (O, S)
    # overshoot both by about a percent of the em, and a box cut exactly at the cap line
    # shaves their tops and bottoms off. logo.tsx still sizes by CAP_HEIGHT, so the caps
    # stay the same size whatever padding the box carries.
    box_y = math.floor(w_top)
    word_h = math.ceil(w_bottom) - box_y
    full_h = math.ceil(s_bottom + sub_baseline) - box_y

    return {
        "fone": word.path(-w_left, 0, 0, 4),
        "nova": word.path(-w_left, 0, 4, 8),
        "sub": sub.path(-s_left, sub_baseline),
        "cap": cap,
        "box_w": round(box_w),
        "box_y": box_y,
        "word_h": word_h,
        "full_h": full_h,
        "word_dx": round((box_w - word_w) / 2, 1),
        "sub_dx": round((box_w - sub_w) / 2, 1),
        "word_w": round(word_w),
        "sub_w": round(sub_w),
    }


TEMPLATE = """/**
 * FoneNova wordmark as outlines, cut from Inter {weight} (SIL Open Font License 1.1).
 *
 * Outlines rather than a webfont: the lockup is eight characters plus a subline, and
 * loading a typeface for it costs a request and can reflow if the font is slow. These
 * paths inline, cost nothing extra, and keep currentColor and var(--primary), which an
 * <img> to an external SVG could not.
 *
 * Inter is also the site's headline and body face, so the logo reads as part of the same
 * system. These are Inter's text cuts, the same shapes the site serves.
 *
 * GENERATED by brand/build-logo-paths.py. Do not hand-edit the path data: change the
 * options in that script and run it again.
 *
 * 1000 units per em, baseline at y = 0, integer coordinates. Kerning is Inter's own.
 * Tracking: wordmark {tracking}em, subline {subline_tracking}em.
 */

/** "FONE", takes currentColor. */
export const FONE_PATH = "{fone}"

/** "NOVA", takes the brand blue. */
export const NOVA_PATH = "{nova}"

/** "WHOLESALE DISTRIBUTION", already below the baseline and centred under the wordmark. */
export const SUBLINE_PATH = "{sub}"

/** Cap height, so callers can size by cap rather than by box. */
export const CAP_HEIGHT = {cap}

/** With the subline. wordDx and subDx centre the narrower line under the wider one. */
export const FULL = {{ x: 0, y: {box_y}, w: {box_w}, h: {full_h}, wordDx: {word_dx}, subDx: {sub_dx} }}

/** Wordmark alone. */
export const WORDMARK = {{ x: 0, y: {box_y}, w: {box_w}, h: {word_h} }}
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fonts", default="/usr/share/fonts/opentype/inter", help="folder holding Inter-*.otf")
    ap.add_argument("--weight", default="ExtraBold", help="wordmark weight (Bold matches the headline)")
    ap.add_argument("--subline-weight", default="Medium")
    ap.add_argument("--tracking", type=float, default=-0.02, help="wordmark tracking in em")
    ap.add_argument("--subline-tracking", type=float, default=0.34, help="subline tracking in em")
    ap.add_argument("--check", action="store_true", help="print metrics and write nothing")
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()

    r = build(args)
    print(
        f"cap {r['cap']} | wordmark ink width {r['word_w']} | subline ink width {r['sub_w']} | "
        f"box {r['box_w']} x {r['full_h']} from y {r['box_y']} (wordmark alone {r['box_w']} x {r['word_h']})"
    )
    if args.check:
        return
    text = TEMPLATE.format(
        weight=args.weight,
        tracking=args.tracking,
        subline_tracking=args.subline_tracking,
        fone=r["fone"],
        nova=r["nova"],
        sub=r["sub"],
        cap=r["cap"],
        box_w=r["box_w"],
        box_y=r["box_y"],
        word_h=r["word_h"],
        full_h=r["full_h"],
        word_dx=r["word_dx"],
        sub_dx=r["sub_dx"],
    )
    pathlib.Path(args.out).write_text(text, encoding="utf-8")
    print(f"wrote {args.out} ({len(text.encode())} bytes)")


if __name__ == "__main__":
    main()
