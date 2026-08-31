"""Rebuild SafetyHub's server-only Noto Sans subset used by generated PDFs.

Run with a Python environment that has ``fonttools`` installed:
    python scripts/subset-pdf-font.py C:/path/to/NotoSans-Regular.ttf
"""

import argparse
from pathlib import Path

from fontTools import subset


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "lib" / "pdf" / "assets" / "noto-sans-latin-cyrillic.ttf"
UNICODES = "U+0020-024F,U+0300-036F,U+0400-052F,U+2000-206F,U+20B8,U+2100-214F"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, help="Path to the original Noto Sans Regular TTF")
    args = parser.parse_args()
    source = args.source.resolve()
    if not source.is_file():
        raise SystemExit(f"Source font not found: {source}")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    subset.main(
        [
            str(source),
            f"--output-file={OUTPUT}",
            f"--unicodes={UNICODES}",
            "--layout-features=*",
            "--name-IDs=*",
            "--name-legacy",
            "--name-languages=*",
            "--glyph-names",
            "--symbol-cmap",
            "--legacy-cmap",
            "--notdef-glyph",
            "--notdef-outline",
            "--recommended-glyphs",
        ]
    )
    print(f"Wrote {OUTPUT.relative_to(ROOT)} ({OUTPUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
