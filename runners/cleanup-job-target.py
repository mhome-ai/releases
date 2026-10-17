#!/usr/bin/env python3
"""Discard this Linux runner's compiled artifacts between jobs."""
import argparse
import os
from pathlib import Path
import re
import shutil
import signal
import sys


TARGET_ROOT = Path('/home/runner/.cache/cargo-target')
SIGNATURE = 'Signature: 8a477f597d28d172789f06886806bc55'
BUILD_PROCESSES = {'cargo', 'rustc', 'rustdoc', 'clippy-driver', 'cc', 'c++',
                   'gcc', 'g++', 'clang', 'clang++', 'ld', 'ld.lld', 'cmake',
                   'ninja', 'make'}


def validate(root):
    if root.is_symlink() or root.resolve() != root or not root.is_dir():
        raise RuntimeError(f'unsafe target root: {root}')
    if not os.path.ismount(root):
        raise RuntimeError(f'target root is not a dedicated mount: {root}')
    # Cargo may have used the volume root before the Debian 11 transition.
    # A new/empty volume needs no marker; all existing output must be recognizable.
    markers = []
    for base, directories, files in os.walk(root, followlinks=False):
        if '.git' in directories or '.git' in files:
            raise RuntimeError(f'Git source found in target volume: {base}')
        directories[:] = [name for name in directories
                          if not (Path(base) / name).is_symlink()]
        if 'CACHEDIR.TAG' in files:
            marker = Path(base) / 'CACHEDIR.TAG'
            if not marker.is_symlink() and marker.read_text().startswith(SIGNATURE):
                markers.append(marker.parent)
    entries = list(root.iterdir())
    if entries and root not in markers:
        # Recognize partially removed caches too, so interrupted cleanup can resume.
        names = {'debian11', 'debug', 'release', 'local-package', 'android-release',
                 'tmp', 'doc', 'package', 'sherpa-onnx-prebuilt', 'CACHEDIR.TAG',
                 '.rustc_info.json', '.future-incompat-report.json'}
        for entry in entries:
            if (entry.name not in names and entry not in markers
                    and not re.fullmatch(r'(aarch64|x86_64|i686|armv7|wasm32)-[a-z0-9_.-]+', entry.name)):
                raise RuntimeError(f'unrecognized target volume entry: {entry}')
    # Do not descend into another mounted filesystem while deleting this volume.
    for base, directories, _ in os.walk(root, followlinks=False):
        for name in directories:
            child = Path(base) / name
            if not child.is_symlink() and os.path.ismount(child):
                raise RuntimeError(f'nested mount in target volume: {child}')


def check_idle(root, proc=Path('/proc'), *, allow_listener=False):
    prefix = str(root) + '/'
    for process in proc.iterdir():
        if not process.name.isdigit() or process.name == str(os.getpid()):
            continue
        try:
            command = (process / 'comm').read_text().strip()
            if command in BUILD_PROCESSES:
                raise RuntimeError(f'build process {process.name} ({command}) is active')
            if not allow_listener and command in {'Runner.Listener', 'Runner.Worker'}:
                raise RuntimeError('stop the runner before manual maintenance')
            for link in [process / 'exe', process / 'cwd', *(process / 'fd').iterdir()]:
                try:
                    target = os.readlink(link).removesuffix(' (deleted)')
                except FileNotFoundError:
                    continue
                if target == str(root) or target.startswith(prefix):
                    raise RuntimeError(f'target volume is open in process {process.name}')
        except (FileNotFoundError, ProcessLookupError):
            continue


def clean(root, *, dry_run=False, allow_listener=False):
    validate(root)
    check_idle(root, allow_listener=allow_listener)
    entries = list(root.iterdir())
    if dry_run:
        print(f'[runner-cleanup] would remove {len(entries)} entries from {root}')
        return
    # Keep the root marker until the directories are gone if deletion is interrupted.
    for entry in sorted(entries, key=lambda entry: entry.name == 'CACHEDIR.TAG'):
        if entry.is_symlink() or not entry.is_dir():
            entry.unlink()
        else:
            shutil.rmtree(entry)
    print(f'[runner-cleanup] removed {len(entries)} entries from {root}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', choices=('before', 'after', 'maintenance'), default='maintenance')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    def timed_out(*_):
        raise TimeoutError('cleanup exceeded 300 seconds')
    signal.signal(signal.SIGALRM, timed_out)
    signal.alarm(300)
    try:
        clean(TARGET_ROOT, dry_run=args.dry_run, allow_listener=args.phase != 'maintenance')
    except (OSError, RuntimeError, ValueError) as error:
        # Completed publication stays successful. A failed pre-job/maintenance
        # cleanup is actionable and must prevent a new build from reusing leftovers.
        print(f'::warning::Runner target cleanup failed: {error}', file=sys.stderr)
        return 0 if args.phase == 'after' else 1
    finally:
        signal.alarm(0)
    return 0


if __name__ == '__main__':
    sys.exit(main())
