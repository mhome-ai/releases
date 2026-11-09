"""Use disposable directories only; never inspect or mutate real runner caches."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cache = load('compiler_cache', 'compiler-cache.py')
wrapper = load('registry_wrapper', 'rustc-registry-cache.py')
IMAGE = 'sha256:' + 'a' * 64
NEW_IMAGE = 'sha256:' + 'b' * 64


class CacheTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name).resolve()
        self.root = self.base / 'compiler-cache'
        self.root.mkdir()
        for mock in [patch.object(cache.os.path, 'ismount', side_effect=lambda p: p == self.root),
                     patch.object(cache.cleanup, 'check_idle')]:
            mock.start()
            self.addCleanup(mock.stop)

    def seed(self):
        cache.maintain(self.root, IMAGE)
        artifact = self.root / 'artifacts' / 'object'
        artifact.write_bytes(b'compiled registry dependency')
        return artifact

    def test_same_image_reuses_objects_but_changed_image_resets_only_owned_volume(self):
        artifact = self.seed()
        source = self.base / 'sources'
        source.mkdir()
        (source / 'Cargo.toml').write_text('preserve')
        cache.maintain(self.root, IMAGE)
        self.assertTrue(artifact.exists())
        cache.maintain(self.root, NEW_IMAGE)
        self.assertFalse(artifact.exists())
        self.assertEqual(NEW_IMAGE, json.loads((self.root / 'owner.json').read_text())['image'])
        self.assertEqual('preserve', (source / 'Cargo.toml').read_text())

    def test_limit_reset_and_dry_run(self):
        artifact = self.seed()
        with patch.object(cache, 'LIMIT', 1):
            cache.maintain(self.root, IMAGE, dry_run=True)
            self.assertTrue(artifact.exists())
            cache.maintain(self.root, IMAGE)
        self.assertFalse(artifact.exists())

    def test_busy_unknown_or_unowned_cache_is_preserved(self):
        artifact = self.seed()
        with patch.object(cache.cleanup, 'check_idle', side_effect=RuntimeError('busy')):
            with self.assertRaisesRegex(RuntimeError, 'busy'):
                cache.maintain(self.root, NEW_IMAGE)
        (self.root / 'owner.json').unlink()
        with self.assertRaisesRegex(RuntimeError, 'ownership'):
            cache.maintain(self.root, NEW_IMAGE)
        (self.root / 'owner.json').write_text('[]')
        with self.assertRaisesRegex(RuntimeError, 'unowned'):
            cache.maintain(self.root, NEW_IMAGE)
        self.assertTrue(artifact.exists())
        (self.root / 'owner.json').write_text(json.dumps({'owner': cache.OWNER, 'image': 5}))
        with self.assertRaisesRegex(RuntimeError, 'unowned'):
            cache.maintain(self.root, NEW_IMAGE)

    def test_mount_source_symlink_and_unknown_entry_guards(self):
        artifact = self.seed()
        with patch.object(cache.os.path, 'ismount', return_value=False):
            with self.assertRaisesRegex(RuntimeError, 'dedicated'):
                cache.maintain(self.root, NEW_IMAGE)
        git = self.root / 'artifacts/.git'
        git.mkdir()
        with self.assertRaisesRegex(RuntimeError, 'Git source'):
            cache.maintain(self.root, NEW_IMAGE)
        git.rmdir()
        link = self.root / 'artifacts/link'
        link.symlink_to(self.base)
        with self.assertRaisesRegex(RuntimeError, 'symlink'):
            cache.maintain(self.root, NEW_IMAGE)
        link.unlink()
        with patch.object(cache.os.path, 'ismount', side_effect=lambda p: p in (self.root, artifact.parent)):
            with self.assertRaisesRegex(RuntimeError, 'nested mount'):
                cache.maintain(self.root, NEW_IMAGE)
        unknown = self.root / 'unregistered'
        unknown.mkdir()
        with self.assertRaisesRegex(RuntimeError, 'unrecognized'):
            cache.maintain(self.root, NEW_IMAGE)
        self.assertTrue(artifact.exists())

    def test_configuration_is_idempotent_and_never_overwrites_existing_user_settings(self):
        home = self.base / 'cargo'
        home.mkdir()
        with patch.object(cache, 'CARGO_HOME', home):
            cache.configure()
            cache.configure()
            config = home / 'config.toml'
            config.write_text('[net]\noffline=true\n')
            with self.assertRaisesRegex(RuntimeError, 'preserving'):
                cache.configure()
            self.assertEqual('[net]\noffline=true\n', config.read_text())

    def test_image_identity_reads_only_own_container_image_and_rejects_bad_values(self):
        with patch.object(cache.socket, 'gethostname', return_value='meow-linux-amd64-runner'), \
                patch.object(cache.subprocess, 'check_output', return_value=IMAGE + '\n') as run:
            self.assertEqual(IMAGE, cache.image_identity())
            self.assertEqual(['docker', 'inspect', '--format', '{{.Image}}', 'meow-linux-amd64-runner'], run.call_args.args[0])
            run.return_value = 'invalid'
            with self.assertRaisesRegex(RuntimeError, 'identity'):
                cache.image_identity()
        with patch.object(cache.socket, 'gethostname', return_value='other-host'):
            with self.assertRaisesRegex(RuntimeError, 'hostname'):
                cache.image_identity()

    def test_before_failure_blocks_but_after_failure_warns(self):
        for phase, result in [('before', 1), ('after', 0)]:
            with patch.object(cache.sys, 'argv', ['cache', '--phase', phase]), \
                    patch.object(cache, 'stop_server', side_effect=RuntimeError('busy')), \
                    contextlib.redirect_stderr(io.StringIO()) as errors:
                self.assertEqual(result, cache.main())
            self.assertIn('::warning::', errors.getvalue())

    def test_busy_build_is_checked_before_stopping_a_server(self):
        with patch.object(cache.cleanup, 'check_idle', side_effect=RuntimeError('build active')), \
                patch.object(cache.subprocess, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'build active'):
                cache.stop_server()
            run.assert_not_called()

    def test_dead_server_zombies_do_not_block_the_next_job(self):
        proc = self.base / 'proc'
        for pid, state in [('10', 'Z (zombie)'), ('11', 'S (sleeping)')]:
            directory = proc / pid
            directory.mkdir(parents=True)
            (directory / 'comm').write_text('sccache\n')
            (directory / 'status').write_text(f'Name:\tsccache\nState:\t{state}\n')
        self.assertEqual(['11'], cache.active_servers(proc))

    def test_disk_budget_matches_the_tool_configuration(self):
        config = Path(__file__).with_name('compiler-cache-config.toml').read_text()
        self.assertIn(f'size = {cache.LIMIT}', config)
        self.assertNotIn('basedirs', config)


class WrapperTest(unittest.TestCase):
    def test_registry_libraries_use_cache_and_workspace_git_and_symlink_sources_do_not(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve()
            registry = base / 'registry/src'
            package = registry / 'index/package-1.0'
            package.mkdir(parents=True)
            workspace = base / 'workspace'
            workspace.mkdir()
            (registry / 'redirect').symlink_to(workspace, target_is_directory=True)
            args = ['/toolchain/rustc', '/source/lib.rs', '--crate-type', 'lib', '--emit=dep-info,metadata,link']
            with patch.object(wrapper, 'REGISTRY', registry):
                self.assertEqual([wrapper.SCCACHE, *args], wrapper.command(args, str(package)))
                for manifest in [str(workspace), str(base / 'git/checkouts/pkg'), str(registry / 'redirect'), None]:
                    self.assertEqual(args, wrapper.command(args, manifest))
                for altered in [args + ['--test'], args[:-1] + ['--emit=metadata'],
                                args[:3] + ['proc-macro', args[-1]]]:
                    self.assertEqual(altered, wrapper.command(altered, str(package)))


if __name__ == '__main__':
    unittest.main()
