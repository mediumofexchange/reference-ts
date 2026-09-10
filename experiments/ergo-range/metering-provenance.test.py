"""Worker-free regressions for engine provenance; no WASM controls execute."""
import pathlib
import runpy
import unittest
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).with_name("metering-check.py")


class Provenance(unittest.TestCase):
    def test_missing_scratch_install_cannot_fall_back(self):
        with patch("pathlib.Path.is_file", return_value=False):
            with self.assertRaisesRegex(RuntimeError, "install the pinned"):
                runpy.run_path(str(SCRIPT))

    def test_wrong_dll_hash_is_refused_before_loading(self):
        with patch("hashlib.sha256") as digest:
            digest.return_value.hexdigest.return_value = "0" * 64
            with self.assertRaisesRegex(RuntimeError, "wrong native engine artifact"):
                runpy.run_path(str(SCRIPT))

    def test_loaded_package_path_is_checked(self):
        probe = runpy.run_path(str(SCRIPT))
        with patch.object(probe["wt"], "__file__", str(SCRIPT)):
            with self.assertRaisesRegex(RuntimeError, "wrong loaded Python engine"):
                probe["main"]()

    def test_loaded_dll_path_is_checked(self):
        probe = runpy.run_path(str(SCRIPT))
        with patch.object(probe["wt"]._ffi, "filename", SCRIPT):
            with self.assertRaisesRegex(RuntimeError, "wrong loaded native engine"):
                probe["main"]()


if __name__ == "__main__":
    unittest.main()
