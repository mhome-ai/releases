#!/usr/bin/env python3
"""Manage the Linux runner's image-bound, 16 GiB registry compiler cache."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import time

spec = importlib.util.spec_from_file_location('target_cleanup', Path(__file__).with_name('cleanup-job-target.py'))
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)

ROOT = Path('/home/runner/.cache/compiler-cache')
LIMIT = 16 * 1024 ** 3
OWNER = 'mhome-linux-runner-registry-cache-v1'
CARGO_HOME = Path('/home/runner/.cargo')
CARGO_CONFIG = '[build]\nrustc-wrapper = "/usr/local/bin/rustc-registry-cache.py"\n'


def configure():
    home = CARGO_HOME
    config = home / 'config.toml'
    if (home / 'config').exists() or (home / 'config').is_symlink() or config.is_symlink():
        raise RuntimeError('existing Cargo configuration requires review; preserving it')
    if config.exists() and config.read_text() != CARGO_CONFIG:
        raise RuntimeError('existing Cargo config.toml requires review; preserving it')
    if not config.exists():
        config.write_text(CARGO_CONFIG)


def image_identity():
    name = socket.gethostname()
    if not re.fullmatch(r'meow-linux-(arm64|amd64)-runner', name):
        raise RuntimeError('unexpected runner hostname')
    image = subprocess.check_output(['docker', 'inspect', '--format', '{{.Image}}', name],
                                    text=True, timeout=20).strip()
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
        raise RuntimeError('invalid runner image identity')
    return image


def validate(root):
    if root.is_symlink() or root.resolve() != root or not root.is_dir() or not os.path.ismount(root):
        raise RuntimeError('compiler cache must be its dedicated, nonsymlink volume')
    if any(entry.name not in {'owner.json', 'artifacts'} for entry in root.iterdir()):
        raise RuntimeError('unrecognized compiler cache volume contents')
    size = 0
    for base, directories, files in os.walk(root, followlinks=False):
        if '.git' in directories or '.git' in files:
            raise RuntimeError('Git source found in compiler cache')
        for name in directories + files:
            child = Path(base) / name
            if child.is_symlink() or os.path.ismount(child):
                raise RuntimeError('symlink or nested mount in compiler cache')
            if child.is_file():
                info = child.stat()
                size += max(info.st_size, getattr(info, 'st_blocks', 0) * 512)
    return size


def active_servers(proc=Path('/proc')):
    active = []
    for path in proc.glob('[0-9]*/comm'):
        try:
            if (path.read_text().strip() == 'sccache'
                    and not re.search(r'^State:\s+Z', path.with_name('status').read_text(), re.M)):
                active.append(path.parent.name)
        except FileNotFoundError:
            continue
    return active


def stop_server():
    # Check build activity before stopping the daemon that serves compilers.
    cleanup.check_idle(cleanup.TARGET_ROOT, allow_listener=True)
    if active_servers():
        result = subprocess.run(['/usr/local/bin/sccache', '--stop-server'], capture_output=True,
                                text=True, timeout=30)
        deadline = time.monotonic() + 10
        while active_servers() and time.monotonic() < deadline:
            time.sleep(0.1)
        if active_servers():
            raise RuntimeError('sccache server did not stop; cache preserved')
        if result.returncode:
            print('[compiler-cache] server had already stopped', flush=True)


def maintain(root, image, *, dry_run=False):
    size = validate(root)
    cleanup.check_idle(root, allow_listener=True)
    marker = root / 'owner.json'
    artifacts = root / 'artifacts'
    previous = json.loads(marker.read_text()) if marker.exists() else None
    if previous is not None and (not isinstance(previous, dict) or previous.get('owner') != OWNER
                                 or not isinstance(previous.get('image'), str)
                                 or not re.fullmatch(r'sha256:[0-9a-f]{64}', previous.get('image', ''))):
        raise RuntimeError('unowned compiler cache marker')
    if previous is None and artifacts.exists() and any(artifacts.iterdir()):
        raise RuntimeError('nonempty compiler cache has no ownership marker')
    reset = previous is not None and (previous['image'] != image or size > LIMIT)
    reason = 'image changed' if previous and previous['image'] != image else 'size limit'
    print(f'[compiler-cache] {"reset: " + reason if reset else "retain"}; {size} bytes; limit {LIMIT}', flush=True)
    if dry_run:
        return
    if reset and artifacts.exists():
        shutil.rmtree(artifacts)
    artifacts.mkdir(exist_ok=True)
    marker.write_text(json.dumps({'owner': OWNER, 'image': image}) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--configure', action='store_true')
    parser.add_argument('--phase', choices=('before', 'after'))
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    if args.configure:
        configure()
        return 0
    if not args.phase:
        parser.error('--phase is required for cache maintenance')
    def timed_out(*_):
        raise TimeoutError('compiler cache maintenance exceeded 300 seconds')
    signal.signal(signal.SIGALRM, timed_out)
    signal.alarm(300)
    try:
        stop_server()
        maintain(ROOT, image_identity(), dry_run=args.dry_run)
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        print(f'::warning::Compiler cache maintenance failed: {error}', file=sys.stderr)
        return 0 if args.phase == 'after' else 1
    finally:
        signal.alarm(0)
    return 0


if __name__ == '__main__':
    sys.exit(main())
