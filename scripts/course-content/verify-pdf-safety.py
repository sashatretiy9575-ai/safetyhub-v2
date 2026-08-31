from __future__ import annotations

import argparse
import json
from pathlib import Path

from pypdf import PdfReader
from pypdf.generic import ArrayObject, DictionaryObject, IndirectObject


UNSAFE_ACTION_TYPES = {"/JavaScript", "/Launch"}
UNSAFE_KEYS = {"/JS", "/JavaScript", "/EmbeddedFiles", "/EmbeddedFile", "/EF"}


def inspect_pdf(path: Path) -> dict[str, object]:
    reader = PdfReader(path, strict=True)
    if reader.is_encrypted:
        raise ValueError(f"{path}: encrypted PDFs are not allowed")

    issues: set[str] = set()
    visited: set[tuple[int, int]] = set()

    def walk(value: object, location: str) -> None:
        if isinstance(value, IndirectObject):
            reference = (value.idnum, value.generation)
            if reference in visited:
                return
            visited.add(reference)
            walk(value.get_object(), location)
            return
        if isinstance(value, DictionaryObject):
            action_type = str(value.get("/S", ""))
            if action_type in UNSAFE_ACTION_TYPES:
                issues.add(f"{location}: action {action_type}")
            if str(value.get("/Type", "")) in {"/EmbeddedFile", "/Filespec"}:
                issues.add(f"{location}: embedded file object")
            for key, child in value.items():
                key_name = str(key)
                if key_name in UNSAFE_KEYS:
                    issues.add(f"{location}{key_name}: unsafe key")
                if key_name not in {"/Parent", "/P"}:
                    walk(child, f"{location}{key_name}/")
            return
        if isinstance(value, ArrayObject):
            for index, child in enumerate(value):
                walk(child, f"{location}[{index}]/")

    walk(reader.trailer, "trailer/")
    attachments = getattr(reader, "attachments", {})
    if attachments:
        issues.add(f"attachments: {len(attachments)}")
    if issues:
        raise ValueError(f"{path}: unsafe PDF features found: {'; '.join(sorted(issues))}")

    return {
        "encrypted": False,
        "unsafeActionCount": 0,
        "embeddedFileCount": 0,
        "pageCount": len(reader.pages),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--snapshot-root",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "content/snapshots/courses",
    )
    parser.add_argument("--record", action="store_true")
    args = parser.parse_args()

    catalog = json.loads((args.snapshot_root / "catalog.json").read_text(encoding="utf-8"))
    results: list[dict[str, object]] = []
    for item in catalog["courses"]:
        slug = item["slug"]
        course_dir = args.snapshot_root / slug
        safety = inspect_pdf(course_dir / "presentation.pdf")
        if safety["pageCount"] != item["pageCount"]:
            raise ValueError(f"{slug}: PDF safety parser found an unexpected page count")
        results.append({"slug": slug, **safety})
        if args.record:
            manifest_path = course_dir / "presentation-manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest.setdefault("validation", {})["safety"] = {
                "status": "passed",
                "encrypted": False,
                "unsafeActionCount": 0,
                "embeddedFileCount": 0,
            }
            manifest_path.write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )

    print(json.dumps({"valid": True, "presentations": results}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
