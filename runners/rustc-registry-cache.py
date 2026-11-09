#!/usr/bin/env python3
"""Cache registry libraries; compile workspace, path and Git sources directly."""
import os
from pathlib import Path
import sys

REGISTRY = Path('/home/runner/.cargo/registry/src')
SCCACHE = '/usr/local/bin/sccache'


def command(arguments, manifest_dir):
    manifest = Path(manifest_dir).resolve() if manifest_dir else None
    eligible = (manifest is not None and REGISTRY.resolve() == REGISTRY
                and manifest.is_relative_to(REGISTRY))
    emits_link = any(arg.startswith('--emit=') and 'link' in arg[7:].split(',')
                     for arg in arguments)
    # Checking, linking executables, procedural macros and incremental workspace
    # builds do not benefit from sccache. Keep their ordinary compiler path.
    library = any(arguments[i:i + 2] in (['--crate-type', 'lib'], ['--crate-type', 'rlib'])
                  for i in range(len(arguments)))
    if eligible and emits_link and library and '--test' not in arguments:
        return [SCCACHE, *arguments]
    return arguments


if __name__ == '__main__':
    args = command(sys.argv[1:], os.environ.get('CARGO_MANIFEST_DIR'))
    os.execvp(args[0], args)
