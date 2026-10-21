import os
import tempfile
import unittest
import unittest.mock
from pathlib import Path

from modules.browser import (
    AUTOMATION_DEFAULT_ARGS,
    FOCUS_STEPS,
    BrowserSession,
    _launch_args,
    playwright_disabled_features,
    create_browser_session,
    get_effective_driver,
    is_loopback_cdp_endpoint,
    resolve_browser_channel,
    resolve_cdp_endpoint,
    resolve_executable_path,
)


class BrowserResolutionTests(unittest.TestCase):
    def test_driver_is_normalized_from_config_alone(self):
        self.assertEqual(get_effective_driver("Edge"), "edge")
        self.assertEqual(get_effective_driver(" chrome "), "chrome")
        self.assertEqual(get_effective_driver("edge"), "edge")

    def test_driver_does_not_read_environment_variables(self):
        with unittest.mock.patch.dict(
            os.environ, {"AUTOVISOR_DRIVER": "chromium"}, clear=False
        ):
            self.assertEqual(get_effective_driver("edge"), "edge")

    def test_channels(self):
        self.assertEqual(resolve_browser_channel("edge"), "msedge")
        self.assertEqual(resolve_browser_channel("chrome"), "chrome")
        self.assertIsNone(resolve_browser_channel("chromium"))

    @unittest.skipIf(os.name == "nt", "POSIX path test")
    def test_macos_app_path(self):
        self.assertEqual(
            resolve_executable_path("chrome", "/Applications/Google Chrome.app"),
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        )

    def test_devtools_active_port_endpoint(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "DevToolsActivePort"
            path.write_text("9222\n/devtools/browser/test-id\n", encoding="utf-8")
            self.assertEqual(
                resolve_cdp_endpoint("http://127.0.0.1:9224", path),
                "ws://127.0.0.1:9222/devtools/browser/test-id",
            )

    def test_cdp_endpoint_must_be_local(self):
        self.assertTrue(is_loopback_cdp_endpoint("ws://127.0.0.1:9222/devtools/browser/x"))
        self.assertTrue(is_loopback_cdp_endpoint("http://localhost:9222"))
        self.assertFalse(is_loopback_cdp_endpoint("ws://example.com:9222/devtools/browser/x"))


class _CDPSession:
    def __init__(self, unsupported=()):
        self.sent = []
        self.unsupported = set(unsupported)

    async def send(self, method, params=None):
        if method in self.unsupported:
            raise RuntimeError(f"'{method}' wasn't found")
        self.sent.append((method, params))
        if method == "Browser.getWindowForTarget":
            return {"windowId": 7}
        return {}


class _Page:
    def __init__(self, context=None):
        self.closed = False
        self.timeout = None
        self.init_scripts = []
        self.context = context

    async def close(self):
        self.closed = True

    def is_closed(self):
        return self.closed

    async def add_init_script(self, *args, **kwargs):
        self.init_scripts.append((args, kwargs))

    def set_default_timeout(self, timeout):
        self.timeout = timeout


class _Context:
    def __init__(self, unsupported=()):
        self.cdp = _CDPSession(unsupported)
        self.page = _Page(self)
        self.cookies = None

    async def new_page(self):
        return self.page

    async def new_cdp_session(self, page):
        assert page is self.page
        return self.cdp

    async def add_cookies(self, cookies):
        self.cookies = cookies


class _Browser:
    def __init__(self):
        self.contexts = [_Context()]
        self.closed = False
        self.context_kwargs = None
        self.version = "test"

    async def new_context(self, **kwargs):
        self.context_kwargs = kwargs
        return self.contexts[0]

    async def close(self):
        self.closed = True


class _Chromium:
    def __init__(self):
        self.browser = _Browser()
        self.cdp_url = None

    async def connect_over_cdp(self, url):
        self.cdp_url = url
        return self.browser

    async def launch(self, **kwargs):
        self.launch_kwargs = kwargs
        return self.browser


class _Playwright:
    def __init__(self):
        self.chromium = _Chromium()


class _Config:
    attach_existing_chrome = True
    cdp_url = "http://127.0.0.1:9222"
    driver = "chrome"
    exe_path = ""


class _OwnedConfig(_Config):
    attach_existing_chrome = False


class _Logger:
    def __init__(self, root):
        self.runtime_root = root
        self.events = []

    def info(self, *_args, **_kwargs):
        pass

    def debug(self, *_args, **_kwargs):
        pass

    def event(self, name, **fields):
        self.events.append((name, fields))

    def summarize_exception(self, exc):
        return str(exc)


class BrowserSessionTests(unittest.IsolatedAsyncioTestCase):
    async def test_attached_session_closes_only_its_page(self):
        with tempfile.TemporaryDirectory() as root:
            playwright = _Playwright()
            session = await create_browser_session(
                playwright, _Config(), None, _Logger(root)
            )
            self.assertTrue(session.attached)
            await session.close()
            self.assertTrue(session.page.closed)
            self.assertFalse(session.browser.closed)

    async def test_owned_session_closes_browser(self):
        browser = _Browser()
        session = BrowserSession(browser, browser.contexts[0], _Page(), False)
        await session.close()
        self.assertTrue(browser.closed)

    async def test_close_after_the_driver_quit_is_quiet(self):
        # 真实控制台里 Ctrl+C 也发给了 Playwright 的驱动, 它先退出了 (pc 在 Windows 上实测)
        class _GoneBrowser(_Browser):
            async def close(self):
                raise Exception("Browser.close: Connection closed while reading from the driver")

        browser = _GoneBrowser()
        await BrowserSession(browser, browser.contexts[0], _Page(), False).close()

        class _BrokenBrowser(_Browser):
            async def close(self):
                raise RuntimeError("别的错")

        broken = _BrokenBrowser()
        with self.assertRaises(RuntimeError):
            await BrowserSession(broken, broken.contexts[0], _Page(), False).close()


class LaunchArgsTests(unittest.TestCase):
    def test_browser_starts_maximized(self):
        args = _launch_args(_OwnedConfig())["args"]
        self.assertIn("--start-maximized", args)

    def test_window_size_only_comes_from_a_real_screen_size(self):
        # 以前非 Windows 一律写死 1920x1080, 小屏幕上窗口会超出屏幕
        with unittest.mock.patch("modules.browser.get_screen_size", return_value=None):
            args = _launch_args(_OwnedConfig())["args"]
        self.assertFalse([a for a in args if a.startswith("--window-size")])
        with unittest.mock.patch("modules.browser.get_screen_size", return_value=(2560, 1440)):
            args = _launch_args(_OwnedConfig())["args"]
        self.assertIn("--window-size=2560,1440", args)
        self.assertIn("--window-position=0,0", args)

    def test_automation_flag_is_dropped_at_launch(self):
        # 不带 --enable-automation, 并关掉 AutomationControlled:
        # navigator.webdriver 才是原生的 false, 而不是靠脚本删掉属性得到的 undefined
        launch = _launch_args(_OwnedConfig())
        self.assertEqual(launch["ignore_default_args"], AUTOMATION_DEFAULT_ARGS)
        self.assertIn("--enable-automation", launch["ignore_default_args"])
        self.assertIn("--disable-blink-features=AutomationControlled", launch["args"])

    def test_never_headless(self):
        self.assertIs(_launch_args(_OwnedConfig())["headless"], False)

    def test_sound_off_mutes_the_whole_browser(self):
        # 播放器上的静音要等视频出现才点得上, 课开头会先外放一小段
        class _Quiet(_OwnedConfig):
            soundOff = True

        class _Loud(_OwnedConfig):
            soundOff = False

        self.assertIn("--mute-audio", _launch_args(_Quiet())["args"])
        self.assertNotIn("--mute-audio", _launch_args(_Loud())["args"])

    def test_keeps_playwrights_occlusion_switch(self):
        # Windows 上窗口被完全盖住会变 hidden, 视频直接停; Playwright 默认带的
        # --disable-backgrounding-occluded-windows 兜住了这一条, 不能被忽略掉
        ignored = _launch_args(_OwnedConfig()).get("ignore_default_args", [])
        self.assertNotIn("--disable-backgrounding-occluded-windows", ignored)
        self.assertNotEqual(ignored, True, "忽略全部默认参数也会把它一起去掉")


class PreparePageTests(unittest.IsolatedAsyncioTestCase):
    async def test_owned_session_uses_window_sized_viewport_and_injects_nothing(self):
        with tempfile.TemporaryDirectory() as root:
            playwright = _Playwright()
            session = await create_browser_session(
                playwright, _OwnedConfig(), [{"name": "a"}], _Logger(root)
            )
            self.assertFalse(session.attached)
            # Python 版里 viewport=None 等于没传, 视口与 screen 仍被模拟成 1280x720
            self.assertEqual(playwright.chromium.browser.context_kwargs, {"no_viewport": True})
            self.assertIn(
                ("Browser.setWindowBounds", {"windowId": 7, "bounds": {"windowState": "maximized"}}),
                session.context.cdp.sent,
            )
            # stealth.min.js 已移除: 页面里不再注入任何脚本
            self.assertEqual(session.page.init_scripts, [])
            self.assertEqual(session.context.cookies, [{"name": "a"}])

    async def test_attached_session_injects_nothing_and_leaves_the_window_alone(self):
        with tempfile.TemporaryDirectory() as root:
            session = await create_browser_session(
                _Playwright(), _Config(), None, _Logger(root)
            )
            self.assertEqual(session.page.init_scripts, [])
            sent = [method for method, _ in session.context.cdp.sent]
            self.assertNotIn("Browser.setWindowBounds", sent, "不能替用户改他自己浏览器的窗口")

    async def test_focus_emulation_is_applied(self):
        with tempfile.TemporaryDirectory() as root:
            logger = _Logger(root)
            session = await create_browser_session(_Playwright(), _Config(), None, logger)
            sent = [method for method, _ in session.context.cdp.sent]
            self.assertEqual(sent, [method for _, method, _ in FOCUS_STEPS])
            self.assertIn(("Emulation.setFocusEmulationEnabled", {"enabled": True}),
                          session.context.cdp.sent)
            self.assertIn("焦点模拟", [name for name, _ in logger.events])

    async def test_missing_cdp_command_does_not_block_the_rest(self):
        with tempfile.TemporaryDirectory() as root:
            playwright = _Playwright()
            playwright.chromium.browser.contexts = [_Context(unsupported={"Page.setWebLifecycleState"})]
            session = await create_browser_session(playwright, _Config(), None, _Logger(root))
            sent = [method for method, _ in session.context.cdp.sent]
            self.assertIn("Emulation.setFocusEmulationEnabled", sent)
            self.assertIn("Emulation.setIdleOverride", sent)
            self.assertNotIn("Page.setWebLifecycleState", sent)


class MainFlowWiringTests(unittest.TestCase):
    def test_main_flow_goes_through_create_browser_session(self):
        # PR #149 合并时冲突解决把主流程改回了自带的 init_page, attachExistingChrome
        # 在正式运行里从此被静默忽略。主流程和诊断必须共用同一个启动入口。
        source = (Path(__file__).resolve().parent.parent / "Autovisor.py").read_text(encoding="utf-8")
        self.assertIn("create_browser_session(", source)
        self.assertNotIn("def init_page", source)
        self.assertNotIn("stealth", source)
        # 连接模式下不能把用户真实浏览器的 Cookie 落盘
        self.assertIn("if logged_in and not session.attached:\n                    await persist_login_cookies", source)
        # 没登录就停了不落盘: 匿名 Cookie 存下来, 下次启动会白白校验一遍再报"已失效"
        self.assertIn("logged_in = False", source)


class ParallelPortTests(unittest.TestCase):
    def test_default_cdp_port_stays_clear_of_the_other_tools(self):
        # 学习通的专用浏览器用 9222、雨课堂用 9223; 三个工具同时跑时连接模式不能撞上它们
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(resolve_cdp_endpoint("", Path(root) / "none"), "http://127.0.0.1:9224")
        for name in ("config.ini.example", "config.linux.ini.example", "config.macos.ini.example"):
            text = (Path(__file__).resolve().parent.parent / name).read_text(encoding="utf-8")
            self.assertIn("cdpUrl = http://127.0.0.1:9224", text, name)
            self.assertNotIn("showDonateCode", text, name)


class EdgeSignInTests(unittest.TestCase):
    class _Edge(_OwnedConfig):
        driver = "edge"

    def test_edge_keeps_playwrights_list_and_adds_implicit_signin(self):
        # Chromium 只认最后一条 --disable-features: 只写 msImplicitSignin 的话,
        # Playwright 自己那一串(含 msForceBrowserSignIn)会整条作废, 所以要合并成一条
        args = _launch_args(self._Edge())["args"]
        flags = [a for a in args if a.startswith("--disable-features=")]
        self.assertEqual(len(flags), 1, args)
        features = flags[0].split("=", 1)[1].split(",")
        self.assertIn("msImplicitSignin", features)
        self.assertIn("msForceBrowserSignIn", features, "Playwright 自带的那几项要保留")
        self.assertEqual(features[: len(playwright_disabled_features())], playwright_disabled_features())

    def test_chrome_args_are_untouched(self):
        args = _launch_args(_OwnedConfig())["args"]
        self.assertFalse([a for a in args if a.startswith("--disable-features=")])

    def test_unreadable_playwright_list_adds_nothing(self):
        # 读不出来就不加: 加一条残缺的会把 Playwright 自己的那条冲掉
        with unittest.mock.patch("modules.browser.playwright_disabled_features", return_value=None):
            args = _launch_args(self._Edge())["args"]
        self.assertFalse([a for a in args if a.startswith("--disable-features=")])
