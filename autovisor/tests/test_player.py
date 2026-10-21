"""播放器控件操作的测试。

纯逻辑部分(标签解析、退回路径)不需要浏览器; 真实控件交互放在
PlayerControlsE2E 里, 需要本机浏览器, 用 AUTOVISOR_E2E=1 打开。

桩页面(fixtures/player_controls.html)照线上结构做: 控制栏默认收起、倍速选项要
悬停才出现、只接受 isTrusted 事件, 并且把"写 video 属性"记成一条日志——所以
一旦退回旧做法, 测试看得见。
"""
import asyncio
import os
import threading
import unittest
from functools import partial
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from unittest import mock

from modules import player

ENABLED = os.environ.get("AUTOVISOR_E2E") == "1"
FIXTURES = Path(__file__).resolve().parent / "fixtures"


class RateLabelTests(unittest.TestCase):
    def test_parses_player_labels(self):
        self.assertEqual(player.parse_rate_label("X 1.0"), 1.0)
        self.assertEqual(player.parse_rate_label("X 1.25"), 1.25)
        self.assertEqual(player.parse_rate_label("X 1.5"), 1.5)
        self.assertEqual(player.parse_rate_label("1.5倍"), 1.5)

    def test_returns_none_without_a_number(self):
        self.assertIsNone(player.parse_rate_label("倍速"))
        self.assertIsNone(player.parse_rate_label(""))
        self.assertIsNone(player.parse_rate_label(None))

    def test_class_suffix_is_not_the_rate(self):
        # 线上 .speedTab10 的文字是 "X 1.25": 类名后缀不能当倍速用
        self.assertEqual(player.parse_rate_label("X 1.25"), 1.25)
        self.assertNotEqual(player.parse_rate_label("X 1.25"), 1.0)


class _Locator:
    def __init__(self, count=0, box=None, text=""):
        self._count = count
        self._box = box
        self._text = text

    @property
    def first(self):
        return self

    def nth(self, _index):
        return self

    async def count(self):
        return self._count

    async def bounding_box(self):
        return self._box

    async def inner_text(self):
        return self._text

    async def is_visible(self):
        return self._count > 0


class _Page:
    """控制栏拿不到尺寸的页面: 用于验证退回路径"""

    def __init__(self, boxes=None):
        self.boxes = boxes or {}

    def locator(self, selector):
        return _Locator(count=1, box=self.boxes.get(selector), text="")

    async def evaluate(self, _script, _arg=None):
        return None


class _Mouse:
    def __init__(self):
        self.moves = []
        self.downs = 0
        self.ups = 0

    async def move(self, x, y):
        self.moves.append((x, y))

    async def down(self):
        self.downs += 1

    async def up(self):
        self.ups += 1


class _MousePage(_Page):
    """控件有尺寸的页面: 用于走通 _move_onto / _click_here 的真实代码路径"""

    def __init__(self, boxes):
        super().__init__(boxes)
        self.mouse = _Mouse()
        self.viewport_size = {"width": 1440, "height": 766}


class MoveOntoTests(unittest.IsolatedAsyncioTestCase):
    """不开浏览器也要覆盖到落点计算: 之前 aim_at 写成了 pointer.aim_at,
    AttributeError 被宽泛的 except 吞掉, 三个控件操作全部静默退化成 False。"""

    async def test_lands_inside_the_element_and_nudges(self):
        box = {"x": 860, "y": 700, "width": 72, "height": 40}
        page = _MousePage({".speedBox": box})
        with mock.patch.object(player.human, "sleep_between", mock.AsyncMock()):
            self.assertTrue(await player._move_onto(page, ".speedBox"))
        self.assertTrue(page.mouse.moves, "应当真的移动了指针")
        x, y = page.mouse.moves[-1]
        self.assertTrue(box["x"] <= x <= box["x"] + box["width"] + 1, (x, box))
        self.assertTrue(box["y"] <= y <= box["y"] + box["height"], (y, box))
        # 最后一下必须是补的那次微动: 控制栏靠它才会重新命中测试
        self.assertEqual(page.mouse.moves[-1][0] - round(page.mouse.moves[-2][0]), 1)

    async def test_click_here_presses_and_releases(self):
        page = _MousePage({})
        with mock.patch.object(player.human, "sleep_between", mock.AsyncMock()):
            await player._click_here(page)
        self.assertEqual((page.mouse.downs, page.mouse.ups), (1, 1))

    async def test_zero_sized_element_is_reported_not_clicked(self):
        page = _MousePage({".speedBox": {"x": 0, "y": 0, "width": 0, "height": 0}})
        self.assertFalse(await player._move_onto(page, ".speedBox"))
        self.assertEqual(page.mouse.moves, [], "收起的控件不应该被点")


class FallbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_reveal_fails_without_a_video_area_box(self):
        self.assertFalse(await player.reveal_controls(_Page()))

    async def test_set_rate_reports_failure_when_controls_stay_hidden(self):
        with mock.patch.object(player.human, "sleep", mock.AsyncMock()):
            self.assertIsNone(await player.raise_rate(_Page(), 1.5))

    async def test_mute_reports_failure_when_controls_stay_hidden(self):
        with mock.patch.object(player.human, "sleep", mock.AsyncMock()):
            self.assertFalse(await player.mute_by_button(_Page()))


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
    def debug_throttled(self, *_a, **_k): pass

    def summarize_exception(self, exc):
        return str(exc)


@unittest.skipUnless(ENABLED, "设置 AUTOVISOR_E2E=1 才运行真实浏览器测试")
class PlayerControlsE2E(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from playwright.async_api import async_playwright
        from modules.browser import create_browser_session

        self.server = HTTPServer(
            ("127.0.0.1", 0), partial(_QuietHandler, directory=str(FIXTURES))
        )
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{self.server.server_address[1]}/player_controls.html"

        self.playwright = await async_playwright().start()
        self.session = await create_browser_session(self.playwright, _Config(), None, _Logger())
        self.page = self.session.page
        await self.page.goto(url)

    async def asyncTearDown(self):
        await self.session.close()
        await self.playwright.stop()
        self.server.shutdown()
        self.server.server_close()

    async def probe(self):
        return await self.page.evaluate("() => window.__probe")

    async def video_state(self):
        return await self.page.evaluate(
            """() => {
                const v = document.querySelector('video');
                return { rate: v.playbackRate, muted: v.muted, paused: v.paused };
            }"""
        )

    async def test_controls_need_two_reveal_steps(self):
        # 线上是两级: 指针进视频区域 -> 控制栏展开; 再悬停倍速框 -> 选项才出来。
        # 不断言 .speedBox 的可见性: Playwright 不把 opacity:0 当隐藏, 线上那层
        # 收起的控制栏也是靠祖先的 pointer-events 挡住的, 看尺寸看不出来。
        tab = self.page.locator(player.SPEED_TAB).first
        self.assertFalse(await tab.is_visible(), "倍速选项应当默认不可见")
        self.assertTrue(await player.reveal_controls(self.page))
        self.assertFalse(await tab.is_visible(), "只展开控制栏还不够, 菜单仍应收起")
        self.assertTrue(await player._open_speed_menu(self.page))
        self.assertTrue(await tab.is_visible(), "悬停倍速框后选项应当出现")

    async def test_rate_is_set_by_clicking_the_menu(self):
        self.assertEqual(await player.raise_rate(self.page, 1.5), 1.5)
        self.assertEqual((await self.video_state())["rate"], 1.5)
        probe = await self.probe()
        self.assertEqual(probe["rejected"], [], f"出现不可信事件: {probe['rejected']}")
        self.assertIn("click-rate:1.5", probe["log"])
        self.assertFalse(
            [e for e in probe["log"] if e.startswith("rate-write")],
            "走通菜单时不应再写 playbackRate",
        )
        # 标签由播放器自己更新, 不需要我们改写它
        self.assertEqual(await player.current_rate_label(self.page), 1.5)

    async def test_rate_absent_from_the_menu_falls_back_to_the_highest_below_it(self):
        # 1.8 不在菜单里: 取不超过它的最高一档(1.5), 而不是写属性硬设 1.8
        self.assertEqual(await player.raise_rate(self.page, 1.8), 1.5)
        probe = await self.probe()
        self.assertFalse([e for e in probe["log"] if e.startswith("rate-write")])
        self.assertEqual((await self.video_state())["rate"], 1.5)

    async def test_max_picks_the_highest_option_in_the_menu(self):
        self.assertEqual(await player.raise_rate(self.page, float("inf")), 1.5)
        self.assertEqual((await self.video_state())["rate"], 1.5)
        self.assertEqual(await player.current_rate_label(self.page), 1.5)

    async def test_optimize_loop_picks_the_speed_once(self):
        # 倍速设成 max 时 "倍速 < 上限" 永远成立: 以前已经在最高档了, 每一轮(约 2 秒)
        # 还会去菜单里再点一次, 看起来就是在无限选倍速
        from modules import tasks

        class _Settings:
            soundOff = False
            limitSpeed = float("inf")

        loop = asyncio.create_task(tasks.video_optimize(self.page, _Settings()))
        await asyncio.sleep(14)
        loop.cancel()
        clicks = [e for e in (await self.probe())["log"] if e.startswith("click-rate")]
        self.assertEqual(clicks, ["click-rate:1.5"])

    async def test_mute_is_set_by_clicking_the_volume_button(self):
        self.assertTrue(await player.mute_by_button(self.page))
        self.assertTrue((await self.video_state())["muted"])
        probe = await self.probe()
        self.assertEqual(probe["rejected"], [])
        self.assertIn("click-mute", probe["log"])
        self.assertFalse(
            [e for e in probe["log"] if e.startswith("volume-write")],
            "走通音量按钮时不应再写 volume",
        )
        # 静音图标由播放器自己切, 不需要我们加 volumeNone
        self.assertTrue(
            await self.page.locator(".volumeBox.volumeNone").count(),
            "播放器应当自己更新了静音图标",
        )

    async def test_playback_starts_by_clicking_the_video_area(self):
        self.assertTrue((await self.video_state())["paused"])
        self.assertTrue(await player.play_by_click(self.page))
        self.assertFalse((await self.video_state())["paused"])
        probe = await self.probe()
        self.assertEqual(probe["rejected"], [])
        self.assertIn("click-play", probe["log"])
        self.assertNotIn("scripted-play", probe["log"], "走通点击时不应再调 play()")


if __name__ == "__main__":
    unittest.main()


class PickRateTests(unittest.TestCase):
    """从菜单档位里挑一档: max 取最高, 给数字取不超过它的最高一档。"""

    MENU = [1.5, 1.25, 1.0]

    def test_max_takes_the_highest(self):
        self.assertEqual(player.pick_rate(self.MENU, float("inf")), 1.5)

    def test_cap_takes_the_highest_below_it(self):
        self.assertEqual(player.pick_rate(self.MENU, 1.8), 1.5)
        self.assertEqual(player.pick_rate(self.MENU, 1.25), 1.25)
        self.assertEqual(player.pick_rate(self.MENU, 1.3), 1.25)

    def test_nothing_usable_returns_none(self):
        self.assertIsNone(player.pick_rate(self.MENU, 0.5))
        self.assertIsNone(player.pick_rate([None, None], float("inf")))


class SpeedGateTests(unittest.TestCase):
    """同一个视频、同一个倍速只处理一次; 换视频或倍速被改回去再处理。"""

    def test_settled_key_is_not_wanted_again(self):
        from modules.tasks import SpeedGate

        gate = SpeedGate()
        self.assertTrue(gate.wants(("a.mp4", 1.0)))
        gate.succeeded(("a.mp4", 1.5))
        self.assertFalse(gate.wants(("a.mp4", 1.5)))
        # 播放器把倍速改回去了, 或者换了下一个视频
        self.assertTrue(gate.wants(("a.mp4", 1.0)))
        self.assertTrue(gate.wants(("b.mp4", 1.5)))

    def test_gives_up_after_repeated_failures(self):
        from modules.tasks import MAX_SPEED_TRIES, SpeedGate

        gate = SpeedGate()
        for _ in range(MAX_SPEED_TRIES - 1):
            gate.failed(("a.mp4", 1.0))
            self.assertTrue(gate.wants(("a.mp4", 1.0)))
        gate.failed(("a.mp4", 1.0))
        self.assertFalse(gate.wants(("a.mp4", 1.0)), "菜单走不通时不该一直去点")
        self.assertTrue(gate.wants(("b.mp4", 1.0)), "换了视频要重新试")

    def test_failures_on_another_video_start_over(self):
        from modules.tasks import MAX_SPEED_TRIES, SpeedGate

        gate = SpeedGate()
        for _ in range(MAX_SPEED_TRIES - 1):
            gate.failed(("a.mp4", 1.0))
        gate.failed(("b.mp4", 1.0))
        self.assertTrue(gate.wants(("b.mp4", 1.0)))
