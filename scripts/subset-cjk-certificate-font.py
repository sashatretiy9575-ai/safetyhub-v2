"""Rebuild the Simplified Chinese font the certificate renderer embeds.

The certificate PDF is generated in the browser (or in a Worker), and the font
travels there over the wire. Shipping the whole 16.4 MB Noto Sans CJK SC for a
document that prints a name, a job title, an organisation and a course title
meant minutes of waiting on a mobile connection and a 16 MB `Uint8Array` held in
memory while `fontkit` parsed it.

The subset below is not driven by a fixed string, because the participant's name
is arbitrary text. It keeps:

  * every hanzi in GB/T 2312, the national standard set for simplified Chinese —
    6,763 characters, which covers ordinary names and prose;
  * every character the checked-in Chinese localizations actually use, so
    anything the content needs is present whether or not GB/T 2312 has it;
  * Latin, Cyrillic and the Kazakh letters, because a certificate issued in
    Chinese still carries names, organisations and QR captions in those scripts;
  * CJK, fullwidth and general punctuation.

Output is OTF rather than WOFF2 on purpose: `@pdf-lib/fontkit` reads TTF and OTF
only.

    python scripts/subset-cjk-certificate-font.py

Run it against the checked-in source. The emitted filename carries the SHA-256
prefix of its own bytes; the version token in the URL
(`/certificate-assets/font?locale=zh&v=...`) has to move with it, in
app/certificate-assets/font/route.ts, lib/pdf/certificate-client-contract.ts,
server/certificates/issuance.ts, server/admin/certificate-export-archive.ts
and the `outputFileTracingIncludes` entry in next.config.ts.
"""

import argparse
import hashlib
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont


ROOT = Path(__file__).resolve().parents[1]
ASSET_DIRECTORY = ROOT / "lib" / "pdf" / "assets"
DEFAULT_SOURCE = ASSET_DIRECTORY / "NotoSansCJKsc-Regular-Sans2.004.otf"
OUTPUT_STEM = "NotoSansCJKsc-Regular"

RANGES = (
    "U+0000-00FF,U+0100-017F,U+0300-036F,U+0400-052F,"
    "U+2000-206F,U+20A0-20BF,U+2100-214F,U+2190-21FF,U+2460-24FF,"
    "U+3000-303F,U+3040-30FF,U+31F0-31FF,U+FE30-FE4F,U+FF00-FFEF"
)


def national_standard_hanzi() -> str:
    """Every hanzi encodable in GB/T 2312, read out of the codec itself."""
    characters = []
    for codepoint in range(0x4E00, 0xA000):
        character = chr(codepoint)
        try:
            character.encode("gb2312")
        except UnicodeEncodeError:
            continue
        characters.append(character)
    return "".join(characters)


def content_characters() -> str:
    sources = sorted(ROOT.glob("content/localizations/**/zh.json"))
    sources.append(ROOT / "messages" / "zh.json")
    return "".join(path.read_text(encoding="utf-8") for path in sources)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, nargs="?", default=DEFAULT_SOURCE)
    args = parser.parse_args()
    source = args.source.resolve()
    if not source.is_file():
        raise SystemExit(f"Source font not found: {source}")

    corpus = ASSET_DIRECTORY / f"{OUTPUT_STEM}.corpus.tmp.txt"
    corpus.write_text(national_standard_hanzi() + content_characters(), encoding="utf-8")

    temporary_output = ASSET_DIRECTORY / f"{OUTPUT_STEM}.tmp.otf"
    subset.main(
        [
            str(source),
            f"--output-file={temporary_output}",
            f"--unicodes={RANGES}",
            f"--text-file={corpus}",
            "--layout-features=*",
            "--name-IDs=*",
            "--name-legacy",
            "--name-languages=*",
            "--notdef-glyph",
            "--notdef-outline",
            "--recommended-glyphs",
        ]
    )
    corpus.unlink()

    digest = hashlib.sha256(temporary_output.read_bytes()).hexdigest()
    output = ASSET_DIRECTORY / f"{OUTPUT_STEM}-{digest[:8]}.otf"
    if output.exists():
        if output.read_bytes() != temporary_output.read_bytes():
            raise SystemExit(f"Refusing to overwrite non-matching asset: {output}")
        temporary_output.unlink()
    else:
        temporary_output.replace(output)

    font = TTFont(output, lazy=True)
    covered = len(font.getBestCmap())
    font.close()
    print(f"Wrote {output.relative_to(ROOT)}")
    print(f"  bytes  {output.stat().st_size:,}")
    print(f"  sha256 {digest}")
    print(f"  cmap   {covered:,} codepoints")


if __name__ == "__main__":
    main()
