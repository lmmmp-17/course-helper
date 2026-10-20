import unittest
from unittest import mock

from playwright._impl._errors import TargetClosedError
from playwright.async_api import TimeoutError as PlaywrightTimeoutError

from modules import utils


class _Logger:
    def __init__(self):
        self.throttled = []
        self.exceptions = []

    def debug_throttled(self, key, msg, interval=60):
        self.throttled.append((key, msg))

    def debug(self, msg):
        pass

    def log_exception(self, msg, exc=None, shift=False):
        self.exceptions.append((msg, exc))


class _Page:
    def __init__(self, result=None, error=None, wait_error=None):
        self.result = result
        self.error = error
        self.wait_error = wait_error
        self.scripts = []
        self.evaluate_calls = 0
        self.wait_timeouts = []

    async def evaluate(self, script, arg=None):
        self.evaluate_calls += 1
        self.scripts.append(script)
        if self.error:
            raise self.error
        return self.result

    async def wait_for_selector(self, selector, state=None, timeout=None):
        self.wait_timeouts.append((selector, timeout))
        if self.wait_error:
            raise self.wait_error


class LoggerPatchMixin(unittest.TestCase):
    def setUp(self):
        self.logger = _Logger()
        patcher = mock.patch.object(utils, "logger", self.logger)
        patcher.start()
        self.addCleanup(patcher.stop)


class RunOnTests(LoggerPatchMixin, unittest.IsolatedAsyncioTestCase):
    async def test_returns_value_and_builds_guarded_script(self):
        page = _Page(result=True)
        result = await utils.run_on(
            page, "video", "(el) => el.paused", "读取视频暂停状态"
        )
        self.assertIs(result, True)
        self.assertIn("'video'", page.scripts[0])
        self.assertIn("(el) => el.paused", page.scripts[0])
        self.assertIn("if (!el) return", page.scripts[0])

    async def test_missing_element_returns_none_and_names_selector(self):
        page = _Page(result=utils._MISSING)
        result = await utils.run_on(
            page, ".videoArea", "(el) => el.click()", "点击播放区"
        )
        self.assertIsNone(result)
        self.assertEqual(self.logger.exceptions, [])
        self.assertEqual(len(self.logger.throttled), 1)
        key, msg = self.logger.throttled[0]
        self.assertEqual(key, "run_on:.videoArea")
        self.assertIn("点击播放区", msg)
        self.assertIn(".videoArea", msg)

    async def test_script_error_reports_selector_and_returns_none(self):
        page = _Page(error=RuntimeError("boom"))
        result = await utils.run_on(page, "video", "(el) => el.play()", "恢复播放")
        self.assertIsNone(result)
        self.assertEqual(self.logger.throttled, [])
        self.assertEqual(len(self.logger.exceptions), 1)
        msg, exc = self.logger.exceptions[0]
        self.assertIn("恢复播放失败", msg)
        self.assertIn("video", msg)
        self.assertIsInstance(exc, RuntimeError)

    async def test_target_closed_is_reraised(self):
        page = _Page(error=TargetClosedError("closed"))
        with self.assertRaises(TargetClosedError):
            await utils.run_on(page, "video", "(el) => el.play()", "恢复播放")


class GetVideoAttrTests(LoggerPatchMixin, unittest.IsolatedAsyncioTestCase):
    async def test_returns_none_when_element_not_ready(self):
        page = _Page(wait_error=PlaywrightTimeoutError("not attached"))
        self.assertIsNone(await utils.get_video_attr(page, "duration"))
        self.assertEqual(page.evaluate_calls, 0)
        self.assertEqual(len(self.logger.throttled), 1)
        self.assertIn("duration", self.logger.throttled[0][1])

    async def test_reads_property_without_null_deref(self):
        page = _Page(result=72.5)
        self.assertEqual(await utils.get_video_attr(page, "duration"), 72.5)
        self.assertIn("['duration']", page.scripts[0])

    async def test_missing_video_after_wait_returns_none(self):
        page = _Page(result=utils._MISSING)
        self.assertIsNone(await utils.get_video_attr(page, "paused"))
        self.assertEqual(len(self.logger.throttled), 1)
        self.assertIn("video", self.logger.throttled[0][1])


class _OptionalLocatorPage:
    """locator(...).first 的替身, 模拟"可选弹窗不存在"的页面"""

    def __init__(self, error=None):
        self.error = error
        self.timeouts = []

    def locator(self, selector):
        return self

    @property
    def first(self):
        return self

    async def count(self):
        return 0

    async def is_visible(self):
        return False

    async def click(self, timeout=None):
        raise AssertionError("不存在的弹窗不应被点击")

    async def evaluate(self, js, timeout=None):
        self.timeouts.append(timeout)
        if self.error:
            raise self.error
        return None


class OptionalElementTests(LoggerPatchMixin, unittest.IsolatedAsyncioTestCase):
    async def test_evaluate_js_skips_quietly_when_element_absent(self):
        page = _Page(wait_error=PlaywrightTimeoutError("hidden"))
        await utils.evaluate_js(page, ".studytime-div", "close()")
        self.assertEqual(page.evaluate_calls, 0)
        self.assertEqual(self.logger.exceptions, [])
        self.assertEqual(len(self.logger.throttled), 1)
        key, msg = self.logger.throttled[0]
        self.assertEqual(key, "evaluate_js:.studytime-div")
        self.assertIn(".studytime-div", msg)

    async def test_evaluate_js_default_wait_is_bounded(self):
        page = _Page()
        await utils.evaluate_js(page, ".studytime-div", "close()")
        self.assertEqual(
            page.wait_timeouts, [(".studytime-div", utils.OPTIONAL_POPUP_TIMEOUT_MS)]
        )
        self.assertEqual(page.evaluate_calls, 1)

    async def test_evaluate_js_keeps_explicit_timeout(self):
        page = _Page()
        await utils.evaluate_js(page, ".exploreTip", "remove()", timeout=1500)
        self.assertEqual(page.wait_timeouts, [(".exploreTip", 1500)])

    async def test_evaluate_on_element_skips_quietly_when_absent(self):
        page = _OptionalLocatorPage(error=PlaywrightTimeoutError("hidden"))
        await utils.evaluate_on_element(page, ".aiMsg.once", "el => el.remove()")
        self.assertEqual(self.logger.exceptions, [])
        self.assertEqual(len(self.logger.throttled), 1)
        self.assertEqual(self.logger.throttled[0][0], "evaluate_on_element:.aiMsg.once")
        self.assertEqual(page.timeouts, [utils.OPTIONAL_POPUP_TIMEOUT_MS])

    async def test_optional_popup_timeout_stays_far_below_page_default(self):
        self.assertLessEqual(utils.OPTIONAL_POPUP_TIMEOUT_MS, 60_000)


class OptimizePageTests(LoggerPatchMixin, unittest.IsolatedAsyncioTestCase):
    async def test_legacy_popup_wait_is_bounded(self):
        page = _OptionalLocatorPage()
        config = mock.Mock()
        catalog = mock.Mock()
        catalog.name = "legacy"
        click_optional = mock.AsyncMock()
        with mock.patch.object(utils, "click_optional", click_optional), mock.patch.object(
            utils, "evaluate_on_element", mock.AsyncMock()
        ):
            await utils.optimize_page(page, config, catalog)
        args, kwargs = click_optional.await_args_list[0]
        self.assertEqual(args[1], ".studytime-div")
        self.assertEqual(args[2], ".iconfont.iconguanbi")
        self.assertEqual(kwargs.get("timeout"), utils.OPTIONAL_POPUP_TIMEOUT_MS)

    async def test_modern_catalog_skips_legacy_popup(self):
        page = _OptionalLocatorPage()
        config = mock.Mock()
        catalog = mock.Mock()
        catalog.name = "hike"
        click_optional = mock.AsyncMock()
        with mock.patch.object(utils, "click_optional", click_optional):
            await utils.optimize_page(page, config, catalog)
        click_optional.assert_not_awaited()


class _ClickPage:
    """click_optional 用的页面替身: 记录等待与点击目标"""

    def __init__(self, wait_error=None):
        self.wait_error = wait_error
        self.waited = []
        self.located = []

    async def wait_for_selector(self, selector, timeout=None):
        self.waited.append((selector, timeout))
        if self.wait_error:
            raise self.wait_error

    def locator(self, selector):
        self.located.append(selector)
        return mock.Mock(first=f"first:{selector}")


class ClickOptionalTests(LoggerPatchMixin, unittest.IsolatedAsyncioTestCase):
    async def test_clicks_with_real_input_instead_of_page_script(self):
        page = _ClickPage()
        human_click = mock.AsyncMock()
        with mock.patch.object(utils, "human_click", human_click):
            clicked = await utils.click_optional(page, ".studytime-div", ".iconfont.iconguanbi", 1500)
        self.assertTrue(clicked)
        self.assertEqual(page.waited, [(".studytime-div", 1500)])
        # 只点可见的那一个, 而不是 DOM 里第一个(可能是隐藏节点)
        self.assertEqual(page.located, [".iconfont.iconguanbi:visible"])
        human_click.assert_awaited_once_with("first:.iconfont.iconguanbi:visible", timeout=1500)

    async def test_absent_popup_is_skipped_quietly(self):
        page = _ClickPage(wait_error=PlaywrightTimeoutError("not there"))
        human_click = mock.AsyncMock()
        with mock.patch.object(utils, "human_click", human_click):
            clicked = await utils.click_optional(page, ".studytime-div", ".x", 1500)
        self.assertFalse(clicked)
        human_click.assert_not_awaited()
        self.assertEqual(self.logger.exceptions, [])


class _Window:
    def __init__(self, title):
        self.title = title


class _Windows:
    def __init__(self, titles):
        self.titles = titles

    def getWindowsWithTitle(self, needle):
        return [_Window(t) for t in self.titles() if needle in t]


class _TitledPage:
    def __init__(self, title):
        self.title_value = title
        self.history = [title]

    async def wait_for_load_state(self, *_args, **_kwargs):
        pass

    async def title(self):
        return self.title_value

    async def evaluate(self, _script, arg=None):
        self.title_value = arg
        self.history.append(arg)

    async def wait_for_timeout(self, _ms):
        pass


class BrowserWindowTests(unittest.IsolatedAsyncioTestCase):
    async def test_unique_page_title_leaves_document_untouched(self):
        page = _TitledPage("智慧树-学习")
        windows = _Windows(lambda: ["智慧树-学习 - Microsoft Edge", "记事本"])
        window = await utils.get_browser_window(page, windows=windows)
        self.assertEqual(window.title, "智慧树-学习 - Microsoft Edge")
        self.assertEqual(page.history, ["智慧树-学习"])

    async def test_ambiguous_title_uses_random_token_and_restores(self):
        page = _TitledPage("智慧树-学习")
        windows = _Windows(lambda: [
            f"{page.title_value} - Microsoft Edge",
            "智慧树-学习 - Google Chrome",
        ])
        window = await utils.get_browser_window(page, windows=windows)
        self.assertIsNotNone(window)
        token = page.history[1]
        # 以前写进去的是工具名 "Autovisor - Playwright", 页面一读就知道
        self.assertNotIn("Autovisor", token)
        self.assertNotIn("Playwright", token)
        self.assertEqual(page.history[-1], "智慧树-学习")


if __name__ == "__main__":
    unittest.main()
