from __future__ import annotations

import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree


FINAL_CTA = 'Нажмите «Начать тест»'
OLD_CTA_FRAGMENT = "отдельном документе с тестами"
LOCAL_PATH_PATTERN = re.compile(r"(?:[A-Za-z]:\\|file://|/Users/)", re.IGNORECASE)
TEXT_TAG = "{http://schemas.openxmlformats.org/drawingml/2006/main}t"

DECKS = [
    ("plotnik", "01_Плотник.pptx", "d3b84cbe64a5376c61168ee798b5130c4e593ba39c302f785a13293125766948", 25),
    ("armaturshchik", "02_Арматурщик.pptx", "480cd55c460114d9210fae0a1b7232a71345587c676cdecc644351ec2497ffbe", 31),
    ("lesomontazhnye-raboty", "03_Лесомонтажные_работы.pptx", "7b8b4b247ba1fe3ff3480ded219417ece9710daa0fd12875f81db10d058228d6", 42),
    ("biot", "04_БИОТ.pptx", "aaca0cb2b612774e7d574f66d0bf2c103536333bb575dca43db4cf657b601c8f", 59),
    ("pozharnaya-bezopasnost", "05_Пожарная_безопасность.pptx", "eb0c64b3aa83a3d63d74631d899def9f7683d06858baca516cc8fc254b46d68a", 41),
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def slide_number(name: str) -> int:
    match = re.fullmatch(r"ppt/slides/slide(\d+)\.xml", name)
    if not match:
        raise ValueError(f"Invalid slide part name: {name}")
    return int(match.group(1))


def visible_text(payload: bytes) -> str:
    root = ElementTree.fromstring(payload)
    return "".join(node.text or "" for node in root.iter(TEXT_TAG))


def normalize_text(value: str) -> str:
    return re.sub(r"[\s\u00a0]+", " ", value).strip()


def textual_package_content(archive: zipfile.ZipFile) -> str:
    values: list[str] = []
    for name in archive.namelist():
        if name.endswith((".xml", ".rels")):
            values.append(archive.read(name).decode("utf-8", errors="replace"))
    return "\n".join(values)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument(
        "--derived-root",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "content/source-materials/derived",
    )
    parser.add_argument("--manifest", type=Path)
    args = parser.parse_args()

    results: list[dict[str, object]] = []
    for slug, source_filename, expected_source_sha, expected_slides in DECKS:
        source_path = args.source_dir / source_filename
        derived_path = args.derived_root / slug / "presentation.pptx"
        actual_source_sha = sha256(source_path)
        if actual_source_sha != expected_source_sha:
            raise ValueError(f"{source_filename}: source hash changed: {actual_source_sha}")
        if not derived_path.is_file():
            raise ValueError(f"{slug}: missing derived PPTX: {derived_path}")

        with zipfile.ZipFile(source_path) as source, zipfile.ZipFile(derived_path) as derived:
            source_slides = sorted(
                (name for name in source.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)),
                key=slide_number,
            )
            slides = sorted(
                (name for name in derived.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)),
                key=slide_number,
            )
            if len(slides) != expected_slides:
                raise ValueError(f"{slug}: expected {expected_slides} slides, found {len(slides)}")
            if len(source_slides) != len(slides):
                raise ValueError(f"{slug}: source and derived slide counts differ")
            note_parts = [name for name in derived.namelist() if name.startswith("ppt/notesSlides/")]
            if note_parts:
                raise ValueError(f"{slug}: derived PPTX still contains {len(note_parts)} speaker-note parts")
            source_theme = source.read("ppt/theme/theme1.xml")
            derived_theme = derived.read("ppt/theme/theme1.xml")
            if source_theme != derived_theme:
                raise ValueError(f"{slug}: theme1.xml differs from the source template")

            source_texts = [normalize_text(visible_text(source.read(name))) for name in source_slides]
            derived_texts = [normalize_text(visible_text(derived.read(name))) for name in slides]
            for page_index, (source_text, derived_text) in enumerate(
                zip(source_texts[:-1], derived_texts[:-1]), start=1
            ):
                if source_text != derived_text:
                    raise ValueError(f"{slug}: unexpected visible-text change on slide {page_index}")
            old_cta_match = re.search(
                r"Перейдите к разделу «[^»]+» в отдельном документе с тестами\.",
                source_texts[-1],
            )
            if old_cta_match is None:
                raise ValueError(f"{slug}: expected source CTA is absent")
            expected_final_text = (
                source_texts[-1][: old_cta_match.start()]
                + FINAL_CTA
                + source_texts[-1][old_cta_match.end() :]
            )
            if derived_texts[-1] != expected_final_text:
                raise ValueError(f"{slug}: final slide has changes beyond the approved CTA")

            final_text = derived_texts[-1]
            all_slide_text = "\n".join(derived_texts)
            if FINAL_CTA not in final_text:
                raise ValueError(f"{slug}: final CTA is absent from the final slide")
            if all_slide_text.count(FINAL_CTA) != 1:
                raise ValueError(f"{slug}: final CTA must occur exactly once")
            if OLD_CTA_FRAGMENT in re.sub(r"\s+", " ", all_slide_text):
                raise ValueError(f"{slug}: old test-document CTA remains")

            package_text = textual_package_content(derived)
            if "[Sources]" in package_text:
                raise ValueError(f"{slug}: source-note marker remains")
            if LOCAL_PATH_PATTERN.search(package_text):
                raise ValueError(f"{slug}: local filesystem path remains")

        results.append(
            {
                "slug": slug,
                "sourceSha256": actual_source_sha,
                "derivedSha256": sha256(derived_path),
                "slideCount": expected_slides,
                "speakerNoteParts": 0,
                "themePreserved": True,
                "unchangedNonFinalSlideTextCount": expected_slides - 1,
                "approvedVisibleTextChanges": 1,
                "finalCta": FINAL_CTA,
            }
        )

    payload = {
        "schemaVersion": 1,
        "valid": True,
        "finalCta": FINAL_CTA,
        "slideCount": sum(int(item["slideCount"]) for item in results),
        "presentations": results,
    }
    if args.manifest:
        args.manifest.parent.mkdir(parents=True, exist_ok=True)
        args.manifest.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
