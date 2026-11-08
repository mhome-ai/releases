"""Deterministic Kit archive; preserve executable bits, reject links and special files."""
import gzip
import pathlib
import sys
import tarfile
root, output = map(pathlib.Path, sys.argv[1:])
with output.open('wb') as raw, gzip.GzipFile(filename='',mode='wb',fileobj=raw,mtime=0) as compressed:
    with tarfile.open(fileobj=compressed,mode='w',format=tarfile.PAX_FORMAT) as archive:
        for item in sorted(root.rglob('*')):
            if item.is_symlink() or not (item.is_file() or item.is_dir()):
                raise ValueError(f'Kit must contain regular files/directories: {item}')
            info=archive.gettarinfo(str(item),str(item.relative_to(root)))
            info.uid=info.gid=info.mtime=0
            info.uname=info.gname=''
            info.mode=0o755 if item.is_dir() or item.stat().st_mode & 0o111 else 0o644
            if item.is_file():
                with item.open('rb') as stream: archive.addfile(info,stream)
            else: archive.addfile(info)
