"""端到端: 用本机真实浏览器验证"降低自动化特征"的改动。

桩页面(fixtures/trusted_only.html)只接受 isTrusted 的事件, 合成事件一律记进
rejected 且不产生效果。所以这里通过, 就说明 Autovisor 现在的每一种点击、滚动、
输入都是浏览器自己构造的输入, 而不是页面脚本派发的。

需要真实浏览器与图形环境, 默认跳过。运行时浏览器窗口会弹到前台并抢走键盘焦点,
期间别碰键盘:
    AUTOVISOR_E2E=1 uv run python -m unittest tests.test_e2e_browser -v
可用 AUTOVISOR_E2E_DRIVER=chrome|edge|chromium 指定浏览器, 默认 chrome。
"""
import asyncio
import os
import sys
import threading
import unittest
from functools import partial
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

ENABLED = os.environ.get("AUTOVISOR_E2E") == "1"
FIXTURES = Path(__file__).resolve().parent / "fixtures"


class _QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


class _Config:
    attach_existing_chrome = False
    cdp_url = "http://127.0.0.1:9222"
    driver = os.environ.get("AUTOVISOR_E2E_DRIVER", "chrome")
    exe_path = ""


class _Logger:
    runtime_root = str(FIXTURES)

    def info(self, *_a, **_k): pass
    def debug(self, *_a, **_k): pass
    def event(self, *_a, **_k): pass
    def log_exception(self, *_a, **_k): pass

    def summarize_exception(self, exc):
        return str(exc)


# 页面里能读到的那些特征。真实浏览器: webdriver 是原生 getter 返回的 false,
# 'webdriver' in navigator 为 true, 各 getter 都是原生函数。
FINGERPRINT_JS = r"""() => {
  const native = (fn) => /\{\s*\[native code\]\s*\}\s*$/.test(Function.prototype.toString.call(fn));
  const getter = (proto, name) => (Object.getOwnPropertyDescriptor(proto, name) || {}).get;
  let renderer = '';
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    renderer = gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL);
  } catch (e) {}
  return {
    webdriver: navigator.webdriver,
    webdriverIn: 'webdriver' in navigator,
    webdriverNative: !!getter(Navigator.prototype, 'webdriver') && native(getter(Navigator.prototype, 'webdriver')),
    languagesNative: native(getter(Navigator.prototype, 'languages')),
    concurrencyNative: native(getter(Navigator.prototype, 'hardwareConcurrency')),
    headlessUA: /Headless/i.test(navigator.userAgent),
    renderer,
    title: document.title,
    inner: [innerWidth, innerHeight],
    outer: [outerWidth, outerHeight],
    screen: [screen.width, screen.height],
  };
}"""


@unittest.skipUnless(ENABLED, "设置 AUTOVISOR_E2E=1 才运行真实浏览器测试")
class TrustedInputE2E(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from playwright.async_api import async_playwright
        from modules.browser import create_browser_session

        self.server = HTTPServer(
            ("127.0.0.1", 0), partial(_QuietHandler, directory=str(FIXTURES))
        )
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/trusted_only.html"

        self.playwright = await async_playwright().start()
        self.session = await create_browser_session(self.playwright, _Config(), None, _Logger())
        self.page = self.session.page
        await self.page.goto(self.url)

    async def asyncTearDown(self):
        await self.session.close()
        await self.playwright.stop()
        self.server.shutdown()
        self.server.server_close()

    async def probe(self):
        return await self.page.evaluate("() => window.__probe")

    async def test_page_sees_a_plain_browser(self):
        fp = await self.page.evaluate(FINGERPRINT_JS)
        self.assertIs(fp["webdriver"], False)
        self.assertTrue(fp["webdriverIn"], "stealth 删属性的痕迹: 'webdriver' in navigator 为 false")
        self.assertTrue(fp["webdriverNative"])
        self.assertTrue(fp["languagesNative"])
        self.assertTrue(fp["concurrencyNative"])
        self.assertFalse(fp["headlessUA"])
        self.assertNotEqual(fp["renderer"], "Intel Iris OpenGL Engine", "stealth 写死的 Mac 显卡串")
        # 视口不能比窗口大: Python 版里 viewport=None 仍会模拟 1280x720,
        # 实测出现过 innerWidth 1280 > outerWidth 1050
        self.assertLessEqual(fp["inner"][0], fp["outer"][0], fp)
        self.assertLessEqual(fp["inner"][1], fp["outer"][1], fp)
        self.assertLessEqual(fp["outer"][0], fp["screen"][0] + 16, fp)

    async def test_all_interactions_are_trusted(self):
        from modules import login, utils
        from modules.fusion_adapter import FusionAdapter
        from modules.pointer import human_click

        # 学前必读弹窗 + 夜间模式按钮(以前是页面里的 el.click())
        self.assertTrue(await utils.click_optional(self.page, ".studytime-div", ".iconfont.iconguanbi", 5000))
        self.assertTrue(await utils.click_optional(self.page, None, ".Patternbtn-div", 3000))

        # 登录: 逐字输入, 勾选协议时不能点开协议链接
        username = "13800000000"
        await login.type_like_human(self.page.locator("#lUsername"), username)
        await login.type_like_human(self.page.locator("#lPassword"), "secret12")
        await login.accept_login_terms(self.page)
        await human_click(self.page.locator(".wall-sub-btn"), timeout=5000)

        # 课时目录: 最后一节在滚动容器可视区之外, 要用真实滚轮滚过去
        await human_click(self.page.locator(".lesson").last, timeout=10_000)

        # 融合课: 逐个展开折叠目录, AI 随堂弹窗选项 + 提交
        expanded = await FusionAdapter.expand_catalog(self.page)
        handled = await FusionAdapter.skip_ai_exercise(self.page)

        probe = await self.probe()
        self.assertEqual(probe["rejected"], [], f"出现了不可信事件: {probe['rejected']}")
        log = probe["log"]
        for entry in ("popup-closed", "night-mode", "terms-clicked", "submit", "lesson:14",
                      "ai-option:A", "ai-submit"):
            self.assertIn(entry, log)
        self.assertNotIn("agreement-link", log, "勾选协议时点开了协议链接")
        self.assertGreater(probe["wheels"], 0, "应当用真实滚轮滚动目录")
        # 每个输入框: 全选(修饰键 + a) + 退格, 然后每个字符一个 keydown。
        # 断言"期望序列是实际序列的子序列"而不是完全相等: 有界面的窗口会抢系统焦点,
        # 这台机器上真实按下的键会混进来(实测遇到过 PageUp 和 WakeUp)。用 fill()
        # 那种一次性写入的话一个按键都不会有, 这个断言照样挂。
        for field, text in (("lUsername", username), ("lPassword", "secret12")):
            typed = [k.split("@")[0] for k in probe["keys"] if k.endswith("@" + field)]
            modifier = "Meta" if sys.platform == "darwin" else "Control"
            expected = [modifier, "a", "Backspace", *text]
            remaining = iter(typed)
            missing = [k for k in expected if not any(seen == k for seen in remaining)]
            self.assertEqual(missing, [], f"{field} 少了按键 {missing}; 实际 {typed}")
        self.assertEqual(expanded, 3)
        self.assertTrue(handled)
        self.assertEqual(await self.page.input_value("#lUsername"), username)
        self.assertTrue(await self.page.locator("input.el-checkbox__original").is_checked())
        active = await self.page.locator(".el-collapse-item.is-active").count()
        self.assertEqual(active, 3)

    async def test_losing_focus_does_not_fire_blur(self):
        # 验证的是结果: 焦点模拟由 Playwright 默认开启, harden_focus 再显式发一次
        other = await self.page.context.new_page()
        await other.goto("about:blank")
        await other.bring_to_front()
        await asyncio.sleep(0.5)
        state = await self.page.evaluate("() => ({ focus: document.hasFocus(), blurs: window.__probe.blurs })")
        await other.close()
        self.assertTrue(state["focus"])
        self.assertEqual(state["blurs"], 0)

    async def test_window_lookup_does_not_rename_the_page(self):
        from modules import utils

        class _OneWindow:
            def getWindowsWithTitle(self, needle):
                return [object()] if needle else []

        before = await self.page.title()
        await utils.get_browser_window(self.page, windows=_OneWindow())
        self.assertEqual(await self.page.title(), before)


if __name__ == "__main__":
    unittest.main()
