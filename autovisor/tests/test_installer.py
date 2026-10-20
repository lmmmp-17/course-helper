import unittest
from types import SimpleNamespace
from contextlib import redirect_stdout
from io import StringIO
from unittest import mock
from unittest.mock import patch

from modules import installer
from modules.installer import (
    DEFAULT_PACKAGES,
    build_wheel_url,
    install_package,
    is_compatible_wheel,
    runtime_packages,
    validate_python_version,
    wheel_tags,
)
from modules.progress import show_progress


class InstallerTests(unittest.TestCase):
    def test_rejects_unsupported_python_version(self):
        for minor in (9, 14):
            with self.assertRaises(RuntimeError):
                validate_python_version(SimpleNamespace(major=3, minor=minor))

    def test_accepts_supported_python_versions(self):
        for minor in (10, 11, 12, 13):
            validate_python_version(SimpleNamespace(major=3, minor=minor))

    def test_runtime_packages_match_python_version(self):
        self.assertEqual(
            {"numpy": "2.1.3", "opencv-python": "4.10.0.84"},
            runtime_packages(SimpleNamespace(major=3, minor=13)),
        )
        for minor in (10, 11, 12):
            self.assertEqual(
                DEFAULT_PACKAGES,
                runtime_packages(SimpleNamespace(major=3, minor=minor)),
            )

    def test_parses_wheel_tags(self):
        self.assertEqual(
            wheel_tags("numpy-1.26.4-cp311-cp311-win_amd64.whl"),
            ("1.26.4", "cp311", "cp311", "win_amd64"),
        )

    def test_requires_matching_python_abi_and_platform(self):
        self.assertTrue(is_compatible_wheel(
            "numpy-1.26.4-cp311-cp311-win_amd64.whl",
            "numpy", "1.26.4", "cp311", "cp311", "win_amd64",
        ))
        self.assertFalse(is_compatible_wheel(
            "numpy-1.26.4-cp310-cp310-win_amd64.whl",
            "numpy", "1.26.4", "cp311", "cp311", "win_amd64",
        ))

    def test_accepts_opencv_abi3_wheel(self):
        self.assertTrue(is_compatible_wheel(
            "opencv_python-4.10.0.82-cp37-abi3-win_amd64.whl",
            "opencv-python", "4.10.0.82", "cp311", "cp311", "win_amd64",
        ))

    def test_rejects_free_threaded_wheel(self):
        self.assertTrue(is_compatible_wheel(
            "numpy-2.1.3-cp313-cp313-win_amd64.whl",
            "numpy", "2.1.3", "cp313", "cp313", "win_amd64",
        ))
        self.assertFalse(is_compatible_wheel(
            "numpy-2.1.3-cp313-cp313t-win_amd64.whl",
            "numpy", "2.1.3", "cp313", "cp313", "win_amd64",
        ))

    def test_progress_handles_missing_content_length(self):
        output = StringIO()
        with redirect_stdout(output):
            show_progress("下载进度:", current=512, total=0)
        self.assertIn("已下载 512 bytes", output.getvalue())

    def test_resolves_relative_mirror_wheel_url(self):
        url = build_wheel_url(
            "https://mirrors.example/repository/pypi/simple/numpy/",
            "../../packages/abc/numpy-1.26.4-cp310-cp310-win_amd64.whl#sha256=test",
        )
        self.assertEqual(
            url,
            "https://mirrors.example/repository/pypi/packages/abc/numpy-1.26.4-cp310-cp310-win_amd64.whl",
        )

    @patch("modules.installer.import_module")
    @patch("modules.installer.extract_whl")
    @patch("modules.installer.clear_package_files")
    @patch("modules.installer.download_wheel")
    def test_falls_back_when_a_mirror_fails(
        self, download_wheel, clear_package_files, extract_whl, import_module
    ):
        download_wheel.side_effect = [
            RuntimeError("429 Client Error"),
            "numpy-1.26.4.whl",
        ]
        import_module.return_value = object()

        with patch("modules.installer.get_res_dir", return_value="packages"):
            result = install_package(
                "numpy", "1.26.4", [("华为", "https://huawei"), ("清华", "https://tsinghua")]
            )

        self.assertIsNotNone(result)
        self.assertEqual(download_wheel.call_count, 2)
        self.assertEqual(download_wheel.call_args_list[1].args[:3],
                         ("清华", "https://tsinghua", "numpy"))


if __name__ == "__main__":
    unittest.main()


class SourceRunSkipsBundledDownloaderTests(unittest.TestCase):
    """"自己下 wheel 解压到 packages/" 只给 Windows 发行版用。

    源码运行时依赖是 uv 按 uv.lock 装在 .venv 里的。再跑一遍下载器会把另一个
    版本下到 packages/(实测 numpy 2.1.3 对 .venv 里的 2.5.1), 两边对不上,
    而且每次启动都重下一遍。
    """

    def _start(self, frozen, platform):
        downloaded = []
        with mock.patch.object(installer.os, "name", platform), \
             mock.patch.object(installer.sys, "frozen", frozen, create=True), \
             mock.patch.object(installer, "install_package",
                               lambda *a, **k: downloaded.append(a) or object()), \
             mock.patch.object(installer, "test_mirrors", lambda *a, **k: {"m": "u"}), \
             mock.patch.object(installer, "is_installed", lambda *a, **k: (None, False)), \
             mock.patch.object(installer, "import_module", lambda name: object()):
            installer.start(object())
        return downloaded

    def test_source_run_on_windows_only_imports(self):
        self.assertEqual(self._start(frozen=False, platform="nt"), [])

    def test_frozen_release_still_downloads(self):
        self.assertNotEqual(self._start(frozen=True, platform="nt"), [])

    def test_source_run_tells_you_how_to_install_when_missing(self):
        with mock.patch.object(installer.os, "name", "posix"), \
             mock.patch.object(installer, "import_module", side_effect=ImportError):
            with self.assertRaises(RuntimeError) as caught:
                installer.start(object())
        self.assertIn("uv sync --extra captcha", str(caught.exception))
