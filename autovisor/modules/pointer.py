"""真实指针操作。

page.mouse.* 走 CDP 的 Input.dispatchMouseEvent, 事件由浏览器自己构造,
isTrusted 为 true, movementX/Y 也由 Blink 按真实语义填。相比之下,
页面里执行 el.click() 得到的事件 isTrusted 恒为 false, 而且这个属性是
[LegacyUnforgeable] 的, 页面脚本无论如何改不掉。

但"输入可信"不等于"像人操作"。Playwright 的 locator.click() 会把指针一步
瞬移到元素几何中心, 按下与抬起之间 0 毫秒, 视口外的元素则用协议级滚动直接
挪过来(只有 scroll 事件, 没有任何 wheel 事件)。这里补上的是:
  - 三次贝塞尔轨迹 + 缓入缓出, 步数随距离变化, 偶有迟疑与过冲回修
  - 落点按截断正态集中在元素中部, 不是几何正中心
  - 停住后再按下, 按住几十到一百多毫秒
  - 目标在视口外时用真实滚轮滚过去

任何一步走不通(元素被遮挡、拿不到尺寸)都退回 locator.click(), 保证不会比
原来的点击更不可靠。
"""
import asyncio
import math
import weakref

from playwright.async_api import Locator, Page
from playwright._impl._errors import TargetClosedError

from modules import human
from modules.logger import Logger

logger = Logger()

# 读元素在自身 frame 里的位置; 与 bounding_box(主 frame 坐标)相减即得 frame 偏移
_LOCAL_RECT_JS = """el => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top }; }"""

# 页面默认超时被设成了 24 小时(等人工过验证), 点击绝不能沿用它:
# 可选元素不出现时, 一次点击就会挂一整天。
DEFAULT_CLICK_TIMEOUT_MS = 10_000

# 只读的命中测试: 落点下面是不是这个元素(或它的子孙), 防止点到遮罩层上
_HIT_TEST_JS = """(el, p) => {
    const hit = el.ownerDocument.elementFromPoint(p.x, p.y);
    return !!hit && (hit === el || el.contains(hit));
}"""

# 最近的可滚动祖先, 滚轮事件要落在它上面才能滚动目录列表
_SCROLL_PARENT_JS = """el => {
    for (let p = el.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 1) {
            const r = p.getBoundingClientRect();
            return { x: r.left, y: r.top, width: r.width, height: r.height };
        }
    }
    return null;
}"""


def bezier_at(points, t):
    (x0, y0), (x1, y1), (x2, y2), (x3, y3) = points
    u = 1 - t
    return (
        u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
        u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
    )


def ease(t: float) -> float:
    """缓入缓出: 起步与收尾慢、中段快。"""
    return 2 * t * t if t < 0.5 else 1 - ((-2 * t + 2) ** 2) / 2


def curve(start, end):
    """控制点在起终点连线两侧随机偏, 距离越远弧度越大。"""
    (x0, y0), (x3, y3) = start, end
    dx, dy = x3 - x0, y3 - y0
    distance = math.hypot(dx, dy)
    bow = min(120.0, 8 + distance * human.uniform(0.06, 0.22))
    side = 1 if human.chance(0.5) else -1
    nx, ny = (0.0, 0.0) if distance == 0 else (-dy / distance, dx / distance)

    def control(ratio, scale):
        return (
            x0 + dx * ratio + nx * bow * scale * side,
            y0 + dy * ratio + ny * bow * scale * side,
        )

    return [
        start,
        control(human.uniform(0.2, 0.4), human.uniform(0.6, 1.0)),
        control(human.uniform(0.6, 0.8), human.uniform(0.3, 0.8)),
        end,
    ]


def aim_at(box: dict) -> tuple[float, float]:
    """落点靠中心, 但避开边缘、也不总是正中心。"""
    return (
        box["x"] + human.gauss_within(box["width"] * 0.22, box["width"] * 0.78),
        box["y"] + human.gauss_within(box["height"] * 0.26, box["height"] * 0.74),
    )


class Pointer:
    """记住指针位置: CDP 的鼠标有状态, Playwright 不会告诉我们它在哪。

    起点必须是 (0, 0)。Blink 用"上一次指针坐标"计算 movementX/Y, 页面刚打开时
    那个坐标就是 (0, 0); 若假设指针在别处, 第一次移动就会带一个巨大位移,
    等于一上来就瞬移。
    """

    def __init__(self, page: Page, x: float = 0.0, y: float = 0.0):
        self.page = page
        self.x = x
        self.y = y
        # 一次完整的指针操作(移过去、悬停、按下抬起)做完之前, 别的任务不能动指针。
        # 后台任务是并发的: 展开目录在点章节时, 调节模块去悬停倍速菜单, 指针被拉来
        # 拉去, 菜单一打开就收起, 倍速一直调不上(真实页面上连续失败过 4 次)。
        self.lock = asyncio.Lock()

    async def _viewport(self) -> tuple[float, float]:
        size = self.page.viewport_size
        if size:
            return size["width"], size["height"]
        # viewport=None 时尺寸跟随真实窗口, 只能问页面
        size = await self.page.evaluate("() => ({ w: innerWidth, h: innerHeight })")
        return size["w"], size["h"]

    async def move_to(self, x: float, y: float) -> None:
        start = (self.x, self.y)
        distance = math.hypot(x - self.x, y - self.y)
        if distance < 1:
            return
        points = curve(start, (x, y))
        # 步数随距离走, 但每次重新抽; 固定步数本身也是节拍
        steps = max(6, min(48, round(distance / human.uniform(9, 26))))
        for i in range(1, steps + 1):
            px, py = bezier_at(points, ease(i / steps))
            await self.page.mouse.move(round(px), round(py))
            self.x, self.y = px, py
            if human.chance(0.06):
                await human.sleep_between(0.018, 0.07)
            else:
                await human.sleep_between(0.001, 0.009)

    async def _frame_offset(
        self, locator: Locator, box: dict, timeout: float = DEFAULT_CLICK_TIMEOUT_MS
    ) -> tuple[float, float]:
        local = await locator.evaluate(_LOCAL_RECT_JS, timeout=timeout)
        return box["x"] - local["x"], box["y"] - local["y"]

    async def _reveal(
        self, locator: Locator, timeout: float = DEFAULT_CLICK_TIMEOUT_MS
    ) -> dict | None:
        """目标在视口或滚动容器外时, 把指针挪到容器上用真实滚轮滚过去。

        每一步都带上超时: 页面的默认超时是 24 小时(等登录用的), 元素在"确认可见"之后
        消失的话(弹窗被平台自己收掉了), 不限时的 bounding_box 会一直等下去。真实页面
        上这样卡死过整个流程: 关学前必读弹窗时, 它被 AI 随堂练习的弹窗顶掉了。
        """
        _, view_h = await self._viewport()
        for _ in range(14):
            box = await locator.bounding_box(timeout=timeout)
            if box is None:
                return None
            offset_x, offset_y = await self._frame_offset(locator, box, timeout)
            parent = await locator.evaluate(_SCROLL_PARENT_JS, timeout=timeout)
            if parent:
                top = max(0.0, parent["y"] + offset_y)
                bottom = min(view_h, parent["y"] + offset_y + parent["height"])
                anchor = {
                    "x": parent["x"] + offset_x,
                    "y": top,
                    "width": parent["width"],
                    "height": max(1.0, bottom - top),
                }
            else:
                top, bottom = 0.0, view_h
                anchor = None

            margin = min(40.0, (bottom - top) / 6)
            if box["y"] >= top + margin and box["y"] + box["height"] <= bottom - margin:
                return box

            if anchor:
                await self.move_to(*aim_at(anchor))
            wanted = (box["y"] + box["height"] / 2) - (top + bottom) / 2
            delta = max(-420.0, min(420.0, wanted)) * human.uniform(0.55, 0.95)
            if abs(delta) < 8:
                return box
            await self.page.mouse.wheel(0, round(delta))
            await human.sleep_between(0.09, 0.28)

        # 滚轮滚不到位(比如容器不响应 wheel)就交给协议级滚动, 保证能继续
        await locator.scroll_into_view_if_needed(timeout=timeout)
        return await locator.bounding_box(timeout=timeout)

    async def click(self, locator: Locator, timeout: float | None = None) -> bool:
        """真实点击。走完人类化路径返回 True, 退回 locator.click() 返回 False。"""
        async with self.lock:
            return await self._click(locator, timeout)

    async def _click(self, locator: Locator, timeout: float | None) -> bool:
        if timeout is None:
            timeout = DEFAULT_CLICK_TIMEOUT_MS
        try:
            await locator.wait_for(state="visible", timeout=timeout)
            box = await self._reveal(locator, timeout)
            if box is None:
                raise LookupError("元素没有可点击的区域")
            target_x, target_y = aim_at(box)
            await self.move_to(target_x, target_y)
            # 快速移动后人常会再修一下落点
            if human.chance(0.28):
                target_x += human.uniform(-0.12, 0.12) * box["width"]
                target_y += human.uniform(-0.12, 0.12) * box["height"]
                target_x = min(box["x"] + box["width"] - 1, max(box["x"] + 1, target_x))
                target_y = min(box["y"] + box["height"] - 1, max(box["y"] + 1, target_y))
                await self.move_to(target_x, target_y)

            offset_x, offset_y = await self._frame_offset(locator, box, timeout)
            local = {"x": self.x - offset_x, "y": self.y - offset_y}
            if not await locator.evaluate(_HIT_TEST_JS, local, timeout=timeout):
                raise LookupError("落点被其它元素遮挡")

            # 停住之后再按下: 人不会在指针停稳的同一毫秒按键
            await human.sleep_between(0.045, 0.19)
            await self.page.mouse.down()
            await human.sleep_between(0.048, 0.132)
            await self.page.mouse.up()
            return True
        except TargetClosedError:
            raise
        except Exception as exc:
            logger.debug_throttled(
                "pointer:fallback",
                f"人类化点击未完成, 改用 locator.click(): {logger.summarize_exception(exc)}",
            )
            await locator.click(timeout=timeout)
            return False

    async def drift(self) -> None:
        """看视频时的低频指针微动: 一整节课零输入事件本身就是信号。"""
        async with self.lock:
            width, height = await self._viewport()
            await self.move_to(human.uniform(0.12, 0.88) * width, human.uniform(0.15, 0.85) * height)


_pointers: "weakref.WeakKeyDictionary[Page, Pointer]" = weakref.WeakKeyDictionary()


def pointer_for(page: Page) -> Pointer:
    """每个页面一支指针, 位置在多次点击之间保持连续。"""
    pointer = _pointers.get(page)
    if pointer is None:
        pointer = Pointer(page)
        _pointers[page] = pointer
    return pointer


async def human_click(locator: Locator, timeout: float | None = None) -> bool:
    return await pointer_for(locator.page).click(locator, timeout=timeout)
