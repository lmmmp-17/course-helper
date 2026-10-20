import math
import unittest
from unittest import mock

from modules import fusion_adapter, login, pointer


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

    async def wheel(self, _dx, _dy):
        pass


class _Page:
    def __init__(self):
        self.mouse = _Mouse()
        self.viewport_size = {"width": 1280, "height": 800}


class _Locator:
    """固定在视口内的元素; hit 控制命中测试结果"""

    def __init__(self, page, hit=True, box=None):
        self.page = page
        self.hit = hit
        self.box = box or {"x": 400, "y": 300, "width": 160, "height": 32}
        self.fallback_clicks = []
        self.waits = []

    async def wait_for(self, state=None, timeout=None):
        self.waits.append(timeout)

    async def bounding_box(self):
        return self.box

    async def evaluate(self, script, arg=None):
        if script is pointer._LOCAL_RECT_JS:
            return {"x": self.box["x"], "y": self.box["y"]}
        if script is pointer._SCROLL_PARENT_JS:
            return None
        if script is pointer._HIT_TEST_JS:
            return self.hit
        raise AssertionError(script)

    async def click(self, timeout=None):
        self.fallback_clicks.append(timeout)


def _no_sleep():
    return mock.patch.object(pointer.human, "sleep_between", mock.AsyncMock())


class GeometryTests(unittest.TestCase):
    def test_curve_is_not_a_straight_line(self):
        points = pointer.curve((100, 100), (900, 600))
        samples = [pointer.bezier_at(points, pointer.ease(i / 30)) for i in range(31)]
        slope = 500 / 800
        off_line = [p for p in samples if abs((p[1] - 100) - slope * (p[0] - 100)) > 2]
        self.assertTrue(off_line, "轨迹不应是直线")
        self.assertAlmostEqual(samples[-1][0], 900)
        self.assertAlmostEqual(samples[-1][1], 600)

    def test_ease_starts_slow(self):
        first = pointer.ease(1 / 20) - pointer.ease(0)
        middle = pointer.ease(11 / 20) - pointer.ease(10 / 20)
        self.assertLess(first, middle)

    def test_aim_stays_inside_and_is_not_always_dead_center(self):
        box = {"x": 100, "y": 200, "width": 200, "height": 40}
        points = [pointer.aim_at(box) for _ in range(80)]
        for x, y in points:
            self.assertTrue(100 < x < 300 and 200 < y < 240)
        self.assertTrue(any(round(x) != 200 or round(y) != 220 for x, y in points))
        mean_x = sum(x for x, _ in points) / len(points)
        self.assertLess(abs(mean_x - 200), 22, "落点应当集中在中部")


class PointerTests(unittest.IsolatedAsyncioTestCase):
    async def test_pointer_starts_at_origin(self):
        # Blink 用"上一次坐标"算 movementX/Y, 页面刚打开时那个坐标就是 (0, 0)
        p = pointer.Pointer(_Page())
        self.assertEqual((p.x, p.y), (0.0, 0.0))

    async def test_move_ends_exactly_on_target(self):
        page = _Page()
        p = pointer.Pointer(page)
        with _no_sleep():
            await p.move_to(640, 400)
        self.assertGreaterEqual(len(page.mouse.moves), 6)
        self.assertEqual(page.mouse.moves[-1], (640, 400))
        steps = [math.dist(a, b) for a, b in zip(page.mouse.moves, page.mouse.moves[1:])]
        self.assertTrue(all(step < 200 for step in steps), "不应有瞬移式的大跳")

    async def test_click_presses_and_releases_inside_the_element(self):
        page = _Page()
        target = _Locator(page)
        with _no_sleep():
            used_path = await pointer.Pointer(page).click(target, timeout=1234)
        self.assertTrue(used_path)
        self.assertEqual((page.mouse.downs, page.mouse.ups), (1, 1))
        x, y = page.mouse.moves[-1]
        box = target.box
        self.assertTrue(box["x"] <= x <= box["x"] + box["width"])
        self.assertTrue(box["y"] <= y <= box["y"] + box["height"])
        self.assertEqual(target.fallback_clicks, [])

    async def test_covered_target_falls_back_to_locator_click(self):
        page = _Page()
        target = _Locator(page, hit=False)
        with _no_sleep():
            used_path = await pointer.Pointer(page).click(target, timeout=1234)
        self.assertFalse(used_path)
        self.assertEqual(page.mouse.downs, 0, "落点被遮挡时不应按下")
        self.assertEqual(target.fallback_clicks, [1234])

    async def test_click_never_inherits_the_24h_page_timeout(self):
        page = _Page()
        target = _Locator(page)
        with _no_sleep():
            await pointer.Pointer(page).click(target)
        self.assertEqual(target.waits, [pointer.DEFAULT_CLICK_TIMEOUT_MS])

    async def test_one_pointer_per_page_keeps_position(self):
        page = _Page()
        self.assertIs(pointer.pointer_for(page), pointer.pointer_for(page))


class _Field:
    def __init__(self):
        self.pressed = []
        self.typed = []

    async def press(self, key):
        self.pressed.append(key)

    async def press_sequentially(self, text):
        self.typed.append(text)


class TypingTests(unittest.IsolatedAsyncioTestCase):
    async def test_types_one_key_at_a_time_after_clearing(self):
        field = _Field()
        with mock.patch.object(login, "human_click", mock.AsyncMock()), mock.patch.object(
            login.human, "sleep_between", mock.AsyncMock()
        ):
            await login.type_like_human(field, "ab1")
        self.assertEqual(field.pressed, ["ControlOrMeta+a", "Backspace"])
        self.assertEqual(field.typed, ["a", "b", "1"])


class _Checkbox:
    def __init__(self, checks_on_box_click=True, has_box=True):
        self.checked = False
        self.checks_on_box_click = checks_on_box_click
        self.has_box = has_box
        self.script_clicks = 0

    @property
    def first(self):
        return self

    async def count(self):
        return 1

    async def is_checked(self):
        return self.checked

    def locator(self, _selector):
        return _Box(self)

    async def evaluate(self, _script):
        self.script_clicks += 1
        self.checked = True


class _Box:
    def __init__(self, checkbox):
        self.checkbox = checkbox

    @property
    def first(self):
        return self

    async def count(self):
        return 1 if self.checkbox.has_box else 0


class _LoginPage:
    def __init__(self, checkbox):
        self.checkbox = checkbox

    def locator(self, _selector):
        return self.checkbox


class LoginTermsTests(unittest.IsolatedAsyncioTestCase):
    async def test_clicks_the_visible_box_with_real_input(self):
        checkbox = _Checkbox()

        async def click(box, timeout=None):
            box.checkbox.checked = box.checkbox.checks_on_box_click

        with mock.patch.object(login, "human_click", side_effect=click) as human_click:
            await login.accept_login_terms(_LoginPage(checkbox))
        human_click.assert_awaited_once()
        self.assertTrue(checkbox.checked)
        self.assertEqual(checkbox.script_clicks, 0, "真实点击生效后不应再走页面脚本")

    async def test_falls_back_to_script_when_structure_differs(self):
        checkbox = _Checkbox(checks_on_box_click=False)
        with mock.patch.object(login, "human_click", mock.AsyncMock()):
            await login.accept_login_terms(_LoginPage(checkbox))
        self.assertTrue(checkbox.checked)
        self.assertEqual(checkbox.script_clicks, 1)


class _Collapsed:
    def __init__(self, counts):
        self.counts = list(counts)

    @property
    def first(self):
        return self

    async def count(self):
        return self.counts.pop(0) if len(self.counts) > 1 else self.counts[0]


class _FusionPage:
    def __init__(self, collapsed):
        self.collapsed = collapsed

    def locator(self, _selector):
        return self.collapsed


class ExpandCatalogTests(unittest.IsolatedAsyncioTestCase):
    async def test_stops_when_clicking_does_not_expand(self):
        # 点了之后折叠项数量不变: 不能对同一个章节头反复点、来回展开收起
        page = _FusionPage(_Collapsed([3, 3]))
        with mock.patch.object(fusion_adapter, "human_click", mock.AsyncMock()) as click, \
                mock.patch.object(fusion_adapter.human, "sleep_between", mock.AsyncMock()):
            expanded = await fusion_adapter.FusionAdapter.expand_catalog(page)
        self.assertEqual(click.await_count, 1)
        self.assertEqual(expanded, 1)

    async def test_expands_one_by_one_until_none_left(self):
        page = _FusionPage(_Collapsed([2, 1, 1, 0, 0]))
        with mock.patch.object(fusion_adapter, "human_click", mock.AsyncMock()) as click, \
                mock.patch.object(fusion_adapter.human, "sleep_between", mock.AsyncMock()):
            expanded = await fusion_adapter.FusionAdapter.expand_catalog(page)
        self.assertEqual(click.await_count, 2)
        self.assertEqual(expanded, 2)


if __name__ == "__main__":
    unittest.main()
