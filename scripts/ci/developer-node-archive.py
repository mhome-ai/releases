"""Normalize verified official Node archives to a deterministic tar.gz for the CLI installer."""
import copy
import gzip
import io
import pathlib
import posixpath
import sys
import tarfile
import zipfile

source, output = map(pathlib.Path, sys.argv[1:])
entries = []

def relative(name):
    parts = pathlib.PurePosixPath(name).parts
    if not parts or parts[0] in {"/", ".", ".."} or ".." in parts:
        raise ValueError("Unsafe archive path")
    return "/".join(parts[1:])

if source.suffix == ".zip":
    with zipfile.ZipFile(source) as archive:
        for original in archive.infolist():
            name = relative(original.filename)
            if not name:
                continue
            info = tarfile.TarInfo(name)
            info.type = tarfile.DIRTYPE if original.is_dir() else tarfile.REGTYPE
            body = b"" if original.is_dir() else archive.read(original)
            info.size = len(body)
            entries.append((info, body))
else:
    with tarfile.open(source, "r:gz") as archive:
        for original in archive:
            name = relative(original.name)
            if not name:
                continue
            info = copy.copy(original)
            info.name = name
            if info.issym():
                target = posixpath.normpath(posixpath.join(posixpath.dirname(name), info.linkname))
                if target == ".." or target.startswith(("../", "/")):
                    raise ValueError("Unsafe Node link")
            elif not (info.isfile() or info.isdir()):
                raise ValueError("Unexpected Node archive member")
            body = archive.extractfile(original).read() if info.isfile() else b""
            entries.append((info, body))
with output.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
    with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for info, body in sorted(entries, key=lambda entry: entry[0].name):
            info.uid = info.gid = info.mtime = 0
            info.uname = info.gname = ""
            info.pax_headers = {}
            info.mode = 0o755 if info.isdir() or info.issym() or info.name in {"bin/node", "node.exe"} else 0o644
            archive.addfile(info, io.BytesIO(body) if info.isfile() else None)
