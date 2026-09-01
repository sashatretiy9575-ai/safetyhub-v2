"""Rebuild the route-scoped Simplified Chinese UI font subset.

Use the official Noto Sans SC variable TTF as the input. The generated subset
contains every glyph referenced by the checked-in Chinese shell catalog; run
this script whenever that catalog gains characters.

    python scripts/subset-cjk-ui-font.py C:/path/to/NotoSansSC-VF.ttf
"""

import argparse
from pathlib import Path

from fontTools import subset


ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "messages" / "zh.json"
OUTPUT = ROOT / "public" / "fonts" / "noto-sans-sc-ui.ttf"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, help="Path to the official Noto Sans SC variable TTF")
    args = parser.parse_args()
    source = args.source.resolve()
    if not source.is_file():
        raise SystemExit(f"Source font not found: {source}")

    subset.main(
        [
            str(source),
            f"--output-file={OUTPUT}",
            f"--text-file={CATALOG}",
            "--layout-features=*",
            "--name-IDs=*",
            "--name-legacy",
            "--name-languages=*",
            "--notdef-glyph",
            "--notdef-outline",
            "--recommended-glyphs",
        ]
    )
    print(f"Wrote {OUTPUT.relative_to(ROOT)} ({OUTPUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()

