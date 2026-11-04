import argparse
import hashlib
import importlib.util
import json
import os
import re
import tarfile
import time
from pathlib import Path


spec = importlib.util.spec_from_file_location("legacy_archive_inspection", Path(__file__).with_name("inspect-legacy-image-archives.py"))
inspection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspection)


def image_mime(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data.startswith(b"BM"):
        return "image/bmp"
    if data.startswith(b"\x00\x00\x01\x00"):
        return "image/x-icon"
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", action="append", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--inventory-receipt-sha", required=True)
    args = parser.parse_args()
    inspection.check_private(args.out)
    root = Path(args.out)
    receipt_path, inventory_path = root / "archive-inventory-receipt.json", root / "archive-inventory.jsonl"
    if inspection.sha256(receipt_path) != args.inventory_receipt_sha:
        raise RuntimeError("INVENTORY_RECEIPT_CHANGED")
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    if receipt.get("status") != "INVENTORIED_NO_EXTRACTION" or receipt.get("duplicateImagePaths") != 0 or inspection.sha256(inventory_path) != receipt.get("inventorySha256"):
        raise RuntimeError("INVENTORY_NOT_USABLE")
    expected = {}
    with inventory_path.open(encoding="utf-8") as stream:
        for line in stream:
            item = json.loads(line)
            key = (item["date"], item["ordinal"])
            if key in expected:
                raise RuntimeError("INVENTORY_DUPLICATE_ORDINAL")
            expected[key] = item
    archives = {}
    for item in args.archive:
        date, separator, source = item.partition("=")
        if not separator or not re.fullmatch(r"\d{8}", date) or not os.path.isabs(source) or date in archives:
            raise RuntimeError("ARCHIVE_BINDING_INVALID")
        inspection.ensure_no_links(source)
        archived = next((a for a in receipt["archives"] if a["date"] == date), None)
        if not archived or os.path.basename(source) != archived["file"] or os.path.getsize(source) != archived["compressedBytes"] or inspection.sha256(source) != archived["sha256"]:
            raise RuntimeError("ARCHIVE_CHANGED")
        archives[date] = source
    if set(archives) != {a["date"] for a in receipt["archives"]}:
        raise RuntimeError("ARCHIVES_INCOMPLETE")
    images, excluded = root / "images", root / "excluded"
    if images.exists() or excluded.exists() or (root / "extraction-manifest.jsonl").exists():
        raise RuntimeError("NEW_EXTRACTION_REQUIRED")
    images.mkdir()
    excluded.mkdir()
    total, size, invalid, seen, started = 0, 0, 0, 0, time.monotonic()
    with (root / "extraction-manifest.jsonl").open("x", encoding="utf-8", newline="\n") as manifest:
        for date, source in sorted(archives.items()):
            (images / date).mkdir()
            (excluded / date).mkdir()
            ordinal = 0
            with tarfile.open(source, "r|gz") as archive:
                for member in archive:
                    ordinal += 1
                    seen += 1
                    original = expected.get((date, ordinal))
                    kind, relative_path = inspection.classify(member, date)
                    if not original or (original["name"], original["type"], original["size"], original["class"], original["relativePath"]) != (member.name, member.type.decode("latin1"), member.size, kind, relative_path):
                        raise RuntimeError("ARCHIVE_ENTRY_CHANGED")
                    if kind != "IMAGE":
                        continue
                    incoming = archive.extractfile(member)
                    if incoming is None:
                        raise RuntimeError("ARCHIVE_IMAGE_UNREADABLE")
                    first = incoming.read(16)
                    mime = image_mime(first)
                    destination = (images if mime else excluded) / relative_path
                    digest, written = hashlib.sha256(), 0
                    with destination.open("xb") as output:
                        if first:
                            output.write(first); digest.update(first); written += len(first)
                        for chunk in iter(lambda: incoming.read(1024 * 1024), b""):
                            output.write(chunk); digest.update(chunk); written += len(chunk)
                    if written != member.size:
                        raise RuntimeError("ARCHIVE_IMAGE_SIZE_MISMATCH")
                    record = {"sourcePath": "accountsImage/" + relative_path, "size": written, "sha256": digest.hexdigest(), "mime": mime, "status": "EXTRACTED" if mime else "EXCLUDED_INVALID_IMAGE"}
                    manifest.write(json.dumps(record, ensure_ascii=False) + "\n")
                    if mime:
                        total += 1; size += written
                    else:
                        invalid += 1
            if ordinal != next(a["entries"] for a in receipt["archives"] if a["date"] == date):
                raise RuntimeError("ARCHIVE_ENTRY_COUNT_CHANGED")
    if seen != len(expected):
        raise RuntimeError("INVENTORY_ENTRY_COUNT_CHANGED")
    result = {"schema": "legacy-image-extraction-v1", "status": "EXTRACTED_NO_UPLOAD", "imageFiles": total, "imageBytes": size, "excludedInvalidImages": invalid,
              "entriesVerified": seen, "manifestSha256": inspection.sha256(root / "extraction-manifest.jsonl"), "elapsedSeconds": round(time.monotonic() - started, 3), "storageWrites": 0, "dbConnections": 0}
    with (root / "extraction-receipt.json").open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2); stream.write("\n")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
