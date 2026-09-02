"""Rebuild the route-scoped Simplified Chinese UI font subset.

Use the official Noto Sans SC variable TTF as the input. The generated subset
contains every glyph referenced by the checked-in Chinese shell catalog; run
this script whenever that catalog gains characters.

    python scripts/subset-cjk-ui-font.py C:/path/to/NotoSansSC-VF.ttf
The generated WOFF2 filename includes the SHA-256 prefix of its final bytes.
Reference the emitted path from the ZH document/layout before deleting an older
asset; immutable cache headers are only safe for content-addressed names.
"""

import argparse
import hashlib
from pathlib import Path

from fontTools import subset


ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "messages" / "zh.json"
FONT_DIRECTORY = ROOT / "public" / "fonts"
OUTPUT_STEM = "noto-sans-sc-ui"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, help="Path to the official Noto Sans SC variable TTF")
    args = parser.parse_args()
    source = args.source.resolve()
    if not source.is_file():
        raise SystemExit(f"Source font not found: {source}")

    temporary_output = FONT_DIRECTORY / f"{OUTPUT_STEM}.tmp.woff2"
    subset.main(
        [
            str(source),
            f"--output-file={temporary_output}",
            "--flavor=woff2",
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
    digest = hashlib.sha256(temporary_output.read_bytes()).hexdigest()[:8]
    output = FONT_DIRECTORY / f"{OUTPUT_STEM}.{digest}.woff2"
    if output.exists():
        if output.read_bytes() != temporary_output.read_bytes():
            raise SystemExit(f"Refusing to overwrite non-matching asset: {output}")
        temporary_output.unlink()
    else:
        temporary_output.replace(output)
    print(f"Wrote {output.relative_to(ROOT)} ({output.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
