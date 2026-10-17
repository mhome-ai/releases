"""Exercise deletion only in disposable fixtures, never real runner volumes."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cleanup', Path(__file__).with_name('cleanup-job-target.py'))
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)


class CleanupTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / 'cargo-target'
        self.root.mkdir()
        self.mount = patch.object(cleanup.os.path, 'ismount', side_effect=lambda p: p == self.root)
        self.mount.start()
        self.addCleanup(self.mount.stop)

    def cache(self, name):
        target = self.root / name
        (target / 'debug').mkdir(parents=True)
        (target / 'CACHEDIR.TAG').write_text(cleanup.SIGNATURE + '\n')
        (target / 'debug' / 'binary').write_text('compiled')
        return target

    def test_all_profiles_and_baselines_removed_but_mount_and_other_volumes_retained(self):
        (self.root / 'CACHEDIR.TAG').write_text(cleanup.SIGNATURE + '\n')
        for name in ('debian11', 'debug', 'release', 'local-package', 'x86_64-unknown-linux-gnu'):
            self.cache(name)
        protected = self.base / 'cargo-home'
        protected.mkdir()
        (protected / 'credentials').write_text('retain')
        (self.root / 'outside').symlink_to(protected, target_is_directory=True)
        with patch.object(cleanup, 'check_idle'):
            cleanup.clean(self.root)
        self.assertEqual([], list(self.root.iterdir()))
        self.assertEqual('retain', (protected / 'credentials').read_text())

    def test_empty_and_interrupted_targets_can_be_cleaned(self):
        (self.root / 'debian11').mkdir()
        with patch.object(cleanup, 'check_idle'):
            cleanup.clean(self.root)
            (self.root / 'debug').mkdir()
            (self.root / 'debug' / 'partial').write_text('interrupted')
            cleanup.clean(self.root)
            cleanup.clean(self.root)
        self.assertEqual([], list(self.root.iterdir()))

    def test_dry_run_and_busy_target_preserve_files(self):
        target = self.cache('debian11')
        with patch.object(cleanup, 'check_idle'):
            cleanup.clean(self.root, dry_run=True)
        with patch.object(cleanup, 'check_idle', side_effect=RuntimeError('busy')):
            with self.assertRaisesRegex(RuntimeError, 'busy'):
                cleanup.clean(self.root)
        self.assertTrue((target / 'debug' / 'binary').is_file())

    def test_unmounted_symlink_source_and_nested_mount_are_rejected_before_deletion(self):
        target = self.cache('debian11')
        with patch.object(cleanup.os.path, 'ismount', return_value=False):
            with self.assertRaisesRegex(RuntimeError, 'dedicated mount'):
                cleanup.validate(self.root)
        link = self.base / 'link'
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'unsafe'):
            cleanup.validate(link)
        (target / '.git').write_text('worktree')
        with self.assertRaisesRegex(RuntimeError, 'Git source'):
            cleanup.validate(self.root)
        (target / '.git').unlink()
        with patch.object(cleanup.os.path, 'ismount', side_effect=lambda p: p in (self.root, target)):
            with self.assertRaisesRegex(RuntimeError, 'nested mount'):
                cleanup.validate(self.root)
        self.assertTrue((target / 'debug' / 'binary').is_file())

    def test_unrecognized_volume_is_rejected(self):
        (self.root / 'registry').mkdir()
        with self.assertRaisesRegex(RuntimeError, 'unrecognized'):
            cleanup.validate(self.root)

    def process(self, command='Runner.Listener'):
        proc = self.base / 'proc'
        process = proc / '999999'
        (process / 'fd').mkdir(parents=True)
        (process / 'comm').write_text(command)
        (process / 'exe').symlink_to('/bin/true')
        (process / 'cwd').symlink_to(self.base)
        return proc, process

    def test_build_process_and_open_cache_are_detected(self):
        proc, process = self.process('rustc')
        with self.assertRaisesRegex(RuntimeError, 'build process'):
            cleanup.check_idle(self.root, proc)
        (process / 'comm').write_text('server')
        (process / 'fd' / '3').symlink_to(self.root / 'debug' / 'binary')
        with self.assertRaisesRegex(RuntimeError, 'open'):
            cleanup.check_idle(self.root, proc)
        (process / 'fd' / '3').unlink()
        (process / 'fd' / '3').symlink_to(str(self.root) + '-other/binary')
        cleanup.check_idle(self.root, proc)

    def test_manual_maintenance_requires_stopped_runner(self):
        proc, _ = self.process()
        with self.assertRaisesRegex(RuntimeError, 'stop the runner'):
            cleanup.check_idle(self.root, proc)
        cleanup.check_idle(self.root, proc, allow_listener=True)

    def test_after_job_failure_warns_but_before_job_and_maintenance_fail(self):
        for phase, expected in [('before', 1), ('after', 0), ('maintenance', 1)]:
            with patch.object(cleanup.sys, 'argv', ['cleanup', '--phase', phase]), \
                    patch.object(cleanup, 'clean', side_effect=RuntimeError('busy')), \
                    contextlib.redirect_stderr(io.StringIO()) as errors:
                self.assertEqual(expected, cleanup.main())
            self.assertIn('::warning::', errors.getvalue())


if __name__ == '__main__':
    unittest.main()
