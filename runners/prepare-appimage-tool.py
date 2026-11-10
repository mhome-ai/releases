#!/usr/bin/env python3
"""Prepare Tauri's optional x64 output plugin for binfmt-based build hosts."""
import hashlib
from pathlib import Path
import platform
import subprocess
import tempfile

ORIGINAL = '49d6a17160675a6bd1781699aae6bdf7692d98552e02a3671d2183d10547842e'
PREPARED = 'cab589f80516042e408e33fce459d42704e32f6c96ed332fc5b8af6c2e0866fd'
URL = 'https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/continuous/linuxdeploy-plugin-appimage-x86_64.AppImage'


def prepare():
    if platform.machine() != 'x86_64':
        return
    cache = Path.home() / '.cache/tauri'
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / 'linuxdeploy-plugin-appimage.AppImage'
    if target.is_symlink():
        raise RuntimeError('AppImage tool must be a regular file')
    with tempfile.TemporaryDirectory(dir=cache, prefix='.appimage-tool-') as temporary:
        staging = Path(temporary) / 'plugin'
        if target.exists():
            data = target.read_bytes()
        else:
            subprocess.run(['curl', '--fail', '--location', '--silent', '--show-error',
                            '--retry', '2', '--connect-timeout', '15', '--max-time', '90',
                            URL, '--output', str(staging)], check=True, timeout=300)
            data = staging.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if digest == PREPARED:
            print('Reuse prepared x64 AppImage output plugin')
            return
        if digest != ORIGINAL or data[8:11] != b'AI\x02':
            raise RuntimeError('AppImage output plugin differs from its pinned upstream bytes')
        # Match Tauri's handling of the main linuxdeploy executable. These ELF
        # padding bytes advertise AppImage integration, but are rejected by the
        # current Docker x64 execution environment. Program code stays
        # intact; the tool still uses AppImage's extract-and-run interface.
        prepared = data[:8] + bytes(3) + data[11:]
        assert hashlib.sha256(prepared).hexdigest() == PREPARED
        staging.write_bytes(prepared)
        staging.chmod(0o770)
        staging.replace(target)
        print('Prepared pinned x64 AppImage output plugin')


if __name__ == '__main__':
    prepare()
