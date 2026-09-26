"""Build the Kazakh companion faces that Manrope cannot provide.

Upstream Manrope — the variable `Manrope[wght].ttf` published by Google Fonts,
which is the same font this project already serves — has no outlines for ten
letters of the Kazakh alphabet:

    Ә ә U+04D8 U+04D9   Ғ ғ U+0492 U+0493   Қ қ U+049A U+049B
    Ң ң U+04A2 U+04A3   Ұ ұ U+04B0 U+04B1

Re-subsetting therefore cannot fix the Kazakh locale: the glyphs do not exist
to be subsetted. What this script does instead is cut those ten codepoints out
of Inter — already the first fallback in `--font-sans` — and hand them back
under a family of their own, so the browser has a designed answer for them
instead of whatever the operating system happens to install.

Inter is not Manrope, so the two are matched rather than assumed to agree:

  * `size-adjust` in `app/globals.css` scales Inter down to Manrope's x-height
    (0.5459 em against 0.5400 em) and cap height (0.7275 against 0.7200);
  * Inter runs about one weight step heavier than Manrope at the same nominal
    value, so each CSS weight is served by the Inter weight whose vertical stem
    matches Manrope's, measured on `l` at half x-height:

        CSS 500 -> Inter 400   (stem 0.0890 em against 0.0873)
        CSS 600 -> Inter 500   (stem 0.1047 em against 0.1069)
        CSS 700 -> Inter 575   (stem 0.1203 em against 0.1216)
        CSS 800 -> Inter 650   (stem 0.1360 em against 0.1363)

    Static instances are used rather than one variable file precisely because
    that mapping is not the identity, and a variable face would have to carry
    an `avar` remap to express it.

Usage:

    python scripts/fonts/subset-kazakh-companion-font.py C:/path/to/Inter.ttf

Each emitted filename carries the SHA-256 prefix of its own bytes; reference
the printed names from `app/globals.css` before deleting an older asset,
because immutable cache headers are only safe for content-addressed names.
"""

import argparse
import hashlib
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer


ROOT = Path(__file__).resolve().parents[2]
FONT_DIRECTORY = ROOT / "public" / "fonts"
OUTPUT_STEM = "inter-kazakh"

KAZAKH_CODEPOINTS = "U+0492-0493,U+049A-049B,U+04A2-04A3,U+04B0-04B1,U+04D8-04D9"

# Manrope has no optical size axis, so pinning Inter's at a body size keeps the
# two from drifting apart as the text scales.
OPTICAL_SIZE = 16

# CSS weight -> the Inter weight whose stems match Manrope's at that value.
WEIGHT_MAP = ((500, 400), (600, 500), (700, 575), (800, 650))


def build(source: Path, css_weight: int, design_weight: int) -> Path:
    font = TTFont(source)
    instance = instancer.instantiateVariableFont(
        font, {"opsz": OPTICAL_SIZE, "wght": design_weight}
    )
    pinned = FONT_DIRECTORY / f"{OUTPUT_STEM}.{css_weight}.tmp.ttf"
    instance.save(pinned)
    font.close()
    instance.close()

    temporary_output = FONT_DIRECTORY / f"{OUTPUT_STEM}.{css_weight}.tmp.woff2"
    subset.main(
        [
            str(pinned),
            f"--output-file={temporary_output}",
            "--flavor=woff2",
            f"--unicodes={KAZAKH_CODEPOINTS}",
            "--layout-features=*",
            # The OFL asks for the copyright and licence to travel with the
            # font, so those name records stay even though nothing reads them.
            "--name-IDs=0,1,2,3,4,5,6,13,14",
            "--name-legacy",
            "--notdef-glyph",
            "--notdef-outline",
            "--recommended-glyphs",
        ]
    )
    pinned.unlink()

    built = TTFont(temporary_output)
    covered = set(built.getBestCmap())
    built.close()
    expected = {0x0492, 0x0493, 0x049A, 0x049B, 0x04A2, 0x04A3, 0x04B0, 0x04B1, 0x04D8, 0x04D9}
    missing = expected - covered
    if missing:
        temporary_output.unlink()
        raise SystemExit(f"Subset is missing {sorted(hex(cp) for cp in missing)}")

    digest = hashlib.sha256(temporary_output.read_bytes()).hexdigest()[:8]
    output = FONT_DIRECTORY / f"{OUTPUT_STEM}-{css_weight}.{digest}.woff2"
    if output.exists():
        if output.read_bytes() != temporary_output.read_bytes():
            raise SystemExit(f"Refusing to overwrite non-matching asset: {output}")
        temporary_output.unlink()
    else:
        temporary_output.replace(output)
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, help="Path to the official Inter variable TTF")
    args = parser.parse_args()
    source = args.source.resolve()
    if not source.is_file():
        raise SystemExit(f"Source font not found: {source}")

    for css_weight, design_weight in WEIGHT_MAP:
        output = build(source, css_weight, design_weight)
        print(
            f"Wrote {output.relative_to(ROOT)} "
            f"({output.stat().st_size:,} bytes, CSS {css_weight} = Inter {design_weight})"
        )


if __name__ == "__main__":
    main()
