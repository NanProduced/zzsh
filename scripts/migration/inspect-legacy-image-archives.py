import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import tarfile
from collections import Counter
from pathlib import Path


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_no_links(path):
    current = Path(os.path.abspath(path))
    while True:
        st = os.lstat(current)
        if stat.S_ISLNK(st.st_mode) or getattr(st, "st_file_attributes", 0) & 0x400:
            raise RuntimeError("REPARSE_POINT_REFUSED")
        if current.parent == current:
            return
        current = current.parent


def check_private(path):
    if os.name != "nt":
        raise RuntimeError("WINDOWS_PRIVATE_ACL_REQUIRED")
    root = os.path.realpath(r"E:\zzsh-local-state\restricted")
    target = os.path.abspath(path)
    if os.path.commonpath([root.lower(), target.lower()]) != root.lower():
        raise RuntimeError("PRIVATE_OUTPUT_REQUIRED")
    ensure_no_links(target)
    user = subprocess.run(["whoami", "/user", "/fo", "csv", "/nh"], capture_output=True, text=True, check=True)
    sid = re.search(r"S-1-5-[0-9-]+", user.stdout)
    if not sid:
        raise RuntimeError("CURRENT_SID_REQUIRED")
    script = "$a=Get-Acl -LiteralPath $env:ZZSH_MEDIA_ACL_PATH;if(!$a.AreAccessRulesProtected){exit 2};$allowed=@($env:ZZSH_MEDIA_ACL_SID,'S-1-5-18','S-1-5-32-544');foreach($r in $a.Access){$s=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;if($s -notin $allowed){exit 3}}"
    env = dict(os.environ, ZZSH_MEDIA_ACL_PATH=target, ZZSH_MEDIA_ACL_SID=sid.group())
    if subprocess.run(["pwsh.exe", "-NoProfile", "-Command", script], env=env, capture_output=True, timeout=5).returncode:
        raise RuntimeError("PRIVATE_OUTPUT_ACL_UNVERIFIED")


def classify(member, date):
    name = member.name
    while name.startswith("./"):
        name = name[2:]
    parts = name.rstrip("/").split("/")
    if name.startswith("/") or "\\" in name or ":" in name or any(p in ("", ".", "..") for p in parts) or any(ord(c) < 32 for c in name):
        return "UNSAFE_PATH", None
    if member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
        return "LINK_OR_SPECIAL", None
    if member.isdir():
        return "DIRECTORY", None
    if len(parts) != 2 or parts[0] != date:
        return "OTHER_DATE_OR_LAYOUT", None
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,195}", parts[1]) or not re.search(r"\.(?:png|jpe?g|webp|gif|bmp|ico)$", parts[1], re.I):
        return "NON_IMAGE_OR_INVALID_NAME", None
    return "IMAGE", "/".join(parts)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", action="append", required=True, help="YYYYMMDD=absolute archive path")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    check_private(args.out)
    inventory = Path(args.out) / "archive-inventory.jsonl"
    receipt = Path(args.out) / "archive-inventory-receipt.json"
    if inventory.exists() or receipt.exists():
        raise RuntimeError("NEW_INVENTORY_REQUIRED")
    archives, duplicate_keys = [], Counter()
    with inventory.open("x", encoding="utf-8", newline="\n") as output:
        for spec in args.archive:
            date, sep, source = spec.partition("=")
            if not sep or not re.fullmatch(r"\d{8}", date) or not os.path.isabs(source):
                raise RuntimeError("ARCHIVE_BINDING_INVALID")
            ensure_no_links(source)
            before = os.stat(source)
            if not stat.S_ISREG(before.st_mode):
                raise RuntimeError("ARCHIVE_FILE_REQUIRED")
            digest = sha256(source)
            counts, bytes_total, ordinal = Counter(), 0, 0
            with tarfile.open(source, "r|gz") as archive:
                for member in archive:
                    ordinal += 1
                    kind, relative_path = classify(member, date)
                    counts[kind] += 1
                    if kind == "IMAGE":
                        bytes_total += member.size
                        duplicate_keys[relative_path] += 1
                    output.write(json.dumps({"date": date, "ordinal": ordinal, "name": member.name, "type": member.type.decode("latin1"), "size": member.size, "class": kind, "relativePath": relative_path}, ensure_ascii=False) + "\n")
            after = os.stat(source)
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise RuntimeError("ARCHIVE_CHANGED")
            archives.append({"date": date, "file": os.path.basename(source), "compressedBytes": before.st_size, "sha256": digest, "entries": ordinal, "counts": dict(counts), "imageBytes": bytes_total})
    result = {"schema": "legacy-image-archive-inventory-v1", "status": "INVENTORIED_NO_EXTRACTION", "archives": archives,
              "duplicateImagePaths": sum(count > 1 for count in duplicate_keys.values()), "inventorySha256": sha256(inventory), "storageWrites": 0, "dbConnections": 0}
    with receipt.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
