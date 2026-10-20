import contextlib
import io
import os
import stat
import tempfile
import unittest
from pathlib import Path

from modules.configs import Config
from modules.utils import normalize_zhihuishu_cookies, save_cookies


CONFIG = """
[user-account]
username =
password =
[browser-option]
driver = Chrome
EXE_PATH = /Applications/Google Chrome.app
attachExistingChrome = False
cdpUrl = http://127.0.0.1:9222
[script-option]
enableAutoCaptcha = False
enableHideWindow = False
showDonateCode = False
[course-option]
soundOff = True
limitMaxTime = 0
limitSpeed = 1
[course-url]
URL1 =
"""


class ConfigTests(unittest.TestCase):
    def test_macos_browser_options(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "config.ini"
            path.write_text(CONFIG, encoding="utf-8")
            mirrors_path = Path(root) / "data" / "mirrors.json"
            mirrors_path.parent.mkdir()
            mirrors_path.write_text('{"primary": "https://mirror.example/simple"}', encoding="utf-8")
            config = Config(path, mirrors_path)
            self.assertEqual(config.driver, "chrome")
            self.assertFalse(config.attach_existing_chrome)
            self.assertTrue(config.exe_path.endswith("Google Chrome.app"))

    @unittest.skipIf(os.name == "nt", "POSIX permission test")
    def test_saved_cookies_are_owner_only(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "cookies.json"
            save_cookies([{"name": "test", "value": "secret"}], path)
            mode = stat.S_IMODE(path.stat().st_mode)
            self.assertEqual(mode, 0o600)

    @unittest.skipIf(os.name == "nt", "POSIX permission test")
    def test_cookie_overwrite_tightens_existing_permissions(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "cookies.json"
            path.write_text("{}", encoding="utf-8")
            path.chmod(0o644)
            save_cookies([{"name": "test", "value": "secret"}], path)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_cookie_normalization_filters_domains_and_expiry(self):
        cookies = normalize_zhihuishu_cookies(
            [
                {"name": "ok", "value": "1", "domain": ".zhihuishu.com", "path": "/"},
                {"name": "old", "value": "2", "domain": ".zhihuishu.com", "expires": 99},
                {"name": "other", "value": "3", "domain": ".example.com"},
                {"name": "lookalike", "value": "4", "domain": ".evilzhihuishu.com"},
                {"name": "blank", "value": "4", "domain": ""},
            ],
            now=100,
        )
        self.assertEqual([cookie["name"] for cookie in cookies], ["ok"])

    def test_cookie_normalization_preserves_top_level_http_only(self):
        cookies = normalize_zhihuishu_cookies(
            [
                {
                    "name": "session",
                    "value": "secret",
                    "domain": "passport.zhihuishu.com",
                    "httpOnly": True,
                }
            ],
            now=100,
        )
        self.assertTrue(cookies[0]["httpOnly"])


class BlankCourseUrlTests(unittest.TestCase):
    """模板里 URL2~URLn 默认是空的, 没填不是错。

    以前每条空值都会打印一行 '"" 不是一个有效网址,将忽略该网址.', 一次启动
    刷四行, 真正填错的那条反而被淹没。
    """

    def _urls(self, body):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "config.ini")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(body)
            mirrors = os.path.join(tmp, "mirrors.json")
            with open(mirrors, "w", encoding="utf-8") as handle:
                handle.write('{"官方": "https://pypi.org/simple"}')
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                config = Config(path, mirrors)
            return config.course_urls, buffer.getvalue()

    BODY = """[user-account]
username =
password =

[browser-option]
driver = Chrome
EXE_PATH =

[script-option]
enableAutoCaptcha = False
enableHideWindow = False
showDonateCode = False

[course-option]
limitMaxTime = 30
limitSpeed = 0
soundOff = True

[course-url]
URL1 = {url1}
URL2 =
URL3 =
URLn =
"""

    def test_blank_urls_are_silent(self):
        urls, output = self._urls(self.BODY.format(url1="https://example.com/x"))
        self.assertEqual(urls, ["https://example.com/x"])
        self.assertNotIn("不是一个有效网址", output)

    def test_a_real_typo_is_still_reported(self):
        urls, output = self._urls(self.BODY.format(url1="不是网址"))
        self.assertEqual(urls, [])
        self.assertIn("不是一个有效网址", output)


class LimitSpeedTests(unittest.TestCase):
    """limitSpeed 支持 max: 切到菜单里最高的一档。"""

    def _read(self, value, attr):
        # Config 的属性是懒加载、每次重读文件, 所以必须在临时目录还在的时候取值
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "config.ini")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(BlankCourseUrlTests.BODY.format(url1="https://example.com/x")
                             .replace("limitSpeed = 0", f"limitSpeed = {value}"))
            mirrors = os.path.join(tmp, "mirrors.json")
            with open(mirrors, "w", encoding="utf-8") as handle:
                handle.write('{"官方": "https://pypi.org/simple"}')
            return getattr(Config(path, mirrors), attr)

    def _label(self, value):
        return self._read(value, "limitSpeedLabel")

    def _speed(self, value):
        return self._read(value, "limitSpeed")

    def test_max_means_no_upper_bound(self):
        self.assertEqual(self._speed("max"), float("inf"))
        self.assertEqual(self._speed("MAX"), float("inf"))

    def test_zero_still_means_hands_off(self):
        self.assertEqual(self._speed("0"), 0.0)

    def test_a_number_is_still_a_cap(self):
        self.assertEqual(self._speed("1.25"), 1.25)

    def test_log_label_is_readable(self):
        # 日志里打 "inf" 对用户没意义
        self.assertEqual(self._label("max"), "max(菜单里最高的一档)")
        self.assertEqual(self._label("0"), "0(不干预)")
        self.assertEqual(self._label("1.25"), "不超过 1.25")
