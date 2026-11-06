"""Exercise the shipped template copy API using isolated local files."""

from contextlib import contextmanager
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

sys.path.insert(0, str(Path(sys.argv.pop(1)) / "scripts"))
import tender_template as helper


class TemplateCopyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="tender-copy-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.source = self.root / "模板.docx"
        with zipfile.ZipFile(self.source, "w") as archive:
            archive.writestr("word/styles.xml", b"original style")
            archive.writestr("word/document.xml", b"controlled content")
        self.spec = {
            "mode": "copy", "path": self.source.name, "format": "docx",
            "sha256": hashlib.sha256(self.source.read_bytes()).hexdigest(),
        }
        self.target = self.root / "交付" / "输出.docx"

    def copy(self, target=None):
        return helper.copy_template(self.root, self.spec, target or self.target)

    def assert_copy_failure(self, stage):
        self.target.parent.mkdir()
        self.target.write_bytes(b"previous output")
        error = PermissionError(f"controlled {stage} failure")
        create_temporary = helper.tempfile.NamedTemporaryFile

        @contextmanager
        def fail_flush(*args, **kwargs):
            with create_temporary(*args, **kwargs) as temporary:
                with mock.patch.object(temporary, "flush", side_effect=error):
                    yield temporary

        def fail_copy(source, destination):
            destination.write(b"partial copy")
            raise error

        if stage == "creation":
            fault = mock.patch.object(helper.tempfile, "NamedTemporaryFile", side_effect=error)
        elif stage == "copy":
            fault = mock.patch.object(helper.shutil, "copyfileobj", side_effect=fail_copy)
        elif stage == "flush":
            fault = mock.patch.object(helper.tempfile, "NamedTemporaryFile", side_effect=fail_flush)
        else:
            fault = mock.patch.object(helper.os, stage, side_effect=error)
        with fault, self.assertRaises(helper.TemplateError) as caught:
            self.copy()
        self.assertIs(caught.exception.__cause__, error)
        self.assertEqual(self.target.read_bytes(), b"previous output")
        self.assertEqual(list(self.target.parent.iterdir()), [self.target])
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), self.spec["sha256"])

    def test_creation_failure_preserves_cause_and_output(self):
        self.assert_copy_failure("creation")

    def test_copy_failure_preserves_cause_and_output(self):
        self.assert_copy_failure("copy")

    def test_flush_failure_preserves_cause_and_output(self):
        self.assert_copy_failure("flush")

    def test_fsync_failure_preserves_cause_and_output(self):
        self.assert_copy_failure("fsync")

    def test_replace_failure_preserves_cause_and_output(self):
        self.assert_copy_failure("replace")

    def test_new_output_copies_template(self):
        output = self.copy(Path("交付/输出.docx"))
        self.assertEqual(output, self.target)
        self.assertEqual(output.read_bytes(), self.source.read_bytes())
        self.assertEqual(list(output.parent.iterdir()), [output])

    def test_existing_output_is_replaced(self):
        self.target.parent.mkdir()
        self.target.write_bytes(b"previous output")
        self.assertEqual(self.copy().read_bytes(), self.source.read_bytes())

    def assert_link_rejected(self, victim):
        self.target.parent.mkdir()
        self.target.symlink_to(victim)
        before = victim.read_bytes() if victim.exists() else None
        with self.assertRaisesRegex(helper.TemplateError, "must not be a symlink"):
            self.copy()
        self.assertTrue(self.target.is_symlink())
        self.assertEqual(self.target.readlink(), victim)
        self.assertEqual(victim.read_bytes() if victim.exists() else None, before)
        self.assertEqual(list(self.target.parent.iterdir()), [self.target])

    def test_existing_final_symlink_preserves_victim(self):
        victim = self.root / "victim.docx"
        victim.write_bytes(b"unrelated output")
        self.assert_link_rejected(victim)

    def test_dangling_final_symlink_remains_dangling(self):
        self.assert_link_rejected(self.root / "missing.docx")

    def test_final_symlink_to_source_is_rejected(self):
        self.assert_link_rejected(self.source)

    def test_same_source_is_unchanged(self):
        with mock.patch.object(helper.tempfile, "NamedTemporaryFile") as create:
            self.assertEqual(self.copy(self.source), self.source)
        create.assert_not_called()
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), self.spec["sha256"])

    def test_traversal_is_rejected(self):
        with self.assertRaisesRegex(helper.TemplateError, "project-relative"):
            self.copy(Path("../outside.docx"))

    def test_in_root_intermediate_symlink_retains_contract(self):
        self.target.parent.mkdir()
        (self.root / "alias").symlink_to(self.target.parent, target_is_directory=True)
        self.assertEqual(self.copy(Path("alias/输出.docx")), self.target)
        self.assertEqual(self.target.read_bytes(), self.source.read_bytes())

    def test_escaping_intermediate_symlink_is_rejected(self):
        (self.root / "alias").symlink_to(self.root.parent, target_is_directory=True)
        with self.assertRaisesRegex(helper.TemplateError, "project-relative"):
            self.copy(Path("alias/outside.docx"))


unittest.main(verbosity=2)
