"""Rebuild the four Manrope subsets this site serves.

Use the official variable `Manrope[wght].ttf` from Google Fonts as the input —
the same font the checked-in subsets were cut from. The ranges below are the
ones declared in `app/globals.css`, so a subset can never claim a codepoint it
does not carry.

    python scripts/subset-manrope-font.py C:/path/to/Manrope[wght].ttf

Two ranges deliberately differ from the stock Google Fonts split:

  * the Cyrillic Extended range is punched through at U+0492-0493, U+049A-049B,
    U+04A2-04A3 and U+04D8-04D9, and U+04B0-04B1 is dropped from the Cyrillic
    range, because Manrope has no outlines for those ten Kazakh letters. Left in
    the declared range they made the browser pick a font that could not draw
    them; excluded, it goes straight to the companion family built by
    `scripts/subset-kazakh-companion-font.py`;
  * Latin Extended gains U+2070-209F, because Manrope does draw subscript
    digits and the content uses them (CO₂), but no declared range asked for
    them, so they fell through to a system font.

Each emitted filename carries the SHA-256 prefix of its own bytes; update
`app/globals.css` and the `headers()` rule in `next.config.ts` from the printed
names before deleting an older asset.
"""

import argparse
import hashlib
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont


ROOT = Path(__file__).resolve().parents[1]
FONT_DIRECTORY = ROOT / "public" / "fonts"

SUBSETS = {
    "cyrillic-ext": (
        "U+0460-0491,U+0494-0499,U+049C-04A1,U+04A4-04AF,U+04B2-04D7,U+04DA-052F,"
        "U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F"
    ),
    "cyrillic": "U+0301,U+0400-045F,U+0490-0491,U+2116",
    "latin-ext": (
        "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,"
        "U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+2070-209F,U+20A0-20AB,U+20AD-20C0,"
        "U+2113,U+2C60-2C7F,U+A720-A7FF"
    ),
    "latin": (
        "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,"
        "U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"
    ),
}


def build(source: Path, name: str, unicodes: str) -> Path:
    temporary_output = FONT_DIRECTORY / f"manrope-{name}.tmp.woff2"
    subset.main(
        [
            str(source),
            f"--output-file={temporary_output}",
            "--flavor=woff2",
            f"--unicodes={unicodes}",
            "--layout-features=*",
            "--name-IDs=*",
            "--name-legacy",
            "--name-languages=*",
            "--notdef-glyph",
            "--notdef-outline",
            "--recommended-glyphs",
        ]
    )
    digest = hashlib.sha256(temporary_output.read_bytes()).hexdigest()[:8]
    output = FONT_DIRECTORY / f"manrope-{name}.{digest}.woff2"
    if output.exists():
        if output.read_bytes() != temporary_output.read_bytes():
            raise SystemExit(f"Refusing to overwrite non-matching asset: {output}")
        temporary_output.unlink()
    else:
        temporary_output.replace(output)
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, help="Path to the official Manrope variable TTF")
    args = parser.parse_args()
    source = args.source.resolve()
    if not source.is_file():
        raise SystemExit(f"Source font not found: {source}")

    for name, unicodes in SUBSETS.items():
        output = build(source, name, unicodes)
        font = TTFont(output)
        covered = len(font.getBestCmap())
        font.close()
        print(
            f"Wrote {output.relative_to(ROOT)} "
            f"({output.stat().st_size:,} bytes, {covered} codepoints)"
        )


if __name__ == "__main__":
    main()
