"""点播放器自己的控件, 而不是在页面里写 video 属性。

结构来自线上页面(``--check-player`` 实测):

    .videoArea                        指针移上去控制栏才展开, 平时是收起的
    .volumeBox > .volumeIcon          静音开关
    .speedBox  > span                 当前倍速标签, 文字形如 "X 1.0"
    .speedBox  > .speedList
        .speedTab 'X 1.5' / 'X 1.25' / 'X 1.0'

两个坑:

1. 控制栏默认收起, 不先把指针移到视频区域, 下面的控件拿不到尺寸也点不动。
2. ``.speedTab`` 的类名后缀和倍速值对不上(``speedTab10`` 是 1.25 倍), 所以按
   标签文字里的数字匹配, 不按类名。

每个函数都返回"是否走通了真实控件"。走不通时由调用方退回原来的属性写入——
那样会留下痕迹, 但不会把功能弄坏。
"""
import re

from playwright.async_api import Page
from playwright._impl._errors import TargetClosedError

from modules import human
from modules.logger import Logger
from modules.pointer import aim_at, pointer_for

logger = Logger()

VIDEO_AREA = ".videoArea"
VOLUME_BOX = ".volumeBox"
VOLUME_ICON = ".volumeBox .volumeIcon"
SPEED_BOX = ".speedBox"
SPEED_LABEL = ".speedBox span"
SPEED_TAB = ".speedBox .speedList .speedTab"

# 控制栏在指针静止约 2.5 秒后自动收起(实测)。所有控件操作必须在这个窗口内做完,
# 所以这条路径上的等待都取短的固定区间, 不用 human.sleep 那条会偶发拉长的长尾。
CONTROL_VISIBLE_MS = 2500
# 读控件位置、文字的上限。页面默认超时是 24 小时, 控件刚好消失(换课时、弹窗)时
# 不限时的读取会一直等下去, 调节模块就此不再工作
CONTROL_READ_MS = 2000

_RATE_IN_LABEL = re.compile(r"(\d+(?:\.\d+)?)")


def parse_rate_label(text: str) -> float | None:
    """从 "X 1.25" 这类标签里取出倍速值。"""
    match = _RATE_IN_LABEL.search(text or "")
    return float(match.group(1)) if match else None


async def _move_onto(page: Page, selector: str) -> bool:
    """把指针移到元素上, 落点之后再补一次极小的移动。

    补这一下是必须的, 不是为了像人: 控制栏(.controlsBar)平时是 display:none,
    指针进入播放器区域才显示, 而移动轨迹带弧度, 中途可能甩出去让它重新收起。
    浏览器要再收到一个鼠标事件才会重新做命中测试, 少了这一步, 悬停才展开的
    倍速菜单会间歇性打不开。
    """
    box = await page.locator(selector).first.bounding_box(timeout=CONTROL_READ_MS)
    if not box or box["width"] <= 0 or box["height"] <= 0:
        return False
    pointer = pointer_for(page)
    await pointer.move_to(*aim_at(box))
    await page.mouse.move(round(pointer.x) + 1, round(pointer.y))
    pointer.x += 1
    await human.sleep_between(0.12, 0.3)
    return True


async def _click_here(page: Page) -> None:
    """指针已经在目标上了, 直接按下抬起。

    不走 human_click: 它会重新定位元素、再移动一次、并等元素满足可点击条件,
    这些加起来经常超过控制栏 2.5 秒的展开窗口, 导致静音/倍速间歇性失败。
    按下到抬起仍保持人手量级的间隔。操作是否生效由调用方读播放器状态确认,
    比命中测试更可靠。
    """
    await human.sleep_between(0.05, 0.14)
    await page.mouse.down()
    await human.sleep_between(0.048, 0.132)
    await page.mouse.up()


async def _pointer_on(page: Page, selector: str) -> str | None:
    """指针下面是不是这个控件; 是就返回它的文字, 不是返回 None。

    按下之前必须确认: 控制栏没动静 2.5 秒就收起, 菜单也会收起, 这时按下去会落在
    视频区域上——那是播放/暂停开关, 视频就被暂停了。用户朋友在 Windows 上的日志里
    视频每隔几秒停一次("不点它也会自己停"), 就是倍速菜单反复点空落在了视频上。
    """
    pointer = pointer_for(page)
    return await page.evaluate(
        """([selector, x, y]) => {
            const hit = document.elementFromPoint(x, y);
            const target = hit && hit.closest(selector);
            return target ? (target.innerText || "") : null;
        }""",
        [selector, round(pointer.x), round(pointer.y)],
    )


async def reveal_controls(page: Page) -> bool:
    """把指针移到视频区域, 让控制栏展开。

    用原始鼠标移动而不是 locator.hover(): 后者带可交互性检查, 而这里要的只是
    "指针在那儿", 元素不需要先满足可点击条件。
    """
    return await _move_onto(page, VIDEO_AREA)


async def _open_speed_menu(page: Page) -> bool:
    """悬停倍速框展开选项。实测这个菜单响应悬停, 不需要点。"""
    if not await _move_onto(page, SPEED_BOX):
        return False
    return await page.locator(SPEED_TAB).first.is_visible()


async def current_rate_label(page: Page) -> float | None:
    label = page.locator(SPEED_LABEL).first
    if not await label.count():
        return None
    return parse_rate_label(await label.inner_text(timeout=CONTROL_READ_MS))


def pick_rate(labels: list[float | None], cap: float) -> float | None:
    """从菜单档位里挑不超过 cap 的最高一档。cap 为 inf 就是菜单里最高的那档。"""
    usable = [value for value in labels if value and value <= cap]
    return max(usable) if usable else None


async def raise_rate(page: Page, cap: float) -> float | None:
    # 整个操作期间占住指针, 不让别的任务把它拉走(见 Pointer.lock)
    async with pointer_for(page).lock:
        return await _raise_rate(page, cap)


async def _raise_rate(page: Page, cap: float) -> float | None:
    """用播放器的倍速菜单切到不超过 cap 的最高一档, 返回实际切到的档位。

    只用菜单里列出来的档位: 那才是平台允许的, 倍速标签也由播放器自己更新。
    已经在这一档就不点, 直接返回它。
    菜单打不开或者没有合适的档位就返回 None, 保持原速——不去写 playbackRate,
    那等于绕过平台自己的控件, 而且页面一眼就能看出来。
    """
    try:
        if not await reveal_controls(page):
            logger.debug_throttled("player:reveal", "倍速菜单跳过: 控制栏没有展开")
            return None
        if not await _open_speed_menu(page):
            logger.debug_throttled("player:speed_menu", "倍速菜单跳过: 选项没有出现")
            return None

        # 先把所有档位的文字读出来再动指针: 边读边移会白耗展开窗口
        tabs = page.locator(SPEED_TAB)
        labels = [
            parse_rate_label(await tabs.nth(i).inner_text(timeout=CONTROL_READ_MS))
            for i in range(await tabs.count())
        ]
        target = pick_rate(labels, cap)
        if target is None:
            logger.debug_throttled(
                "player:speed_absent",
                f"倍速菜单里没有不超过 {cap} 的档位, 可选: {[l for l in labels if l]}",
            )
            return None
        if await current_rate_label(page) == target:
            return target

        await _move_onto(page, f"{SPEED_TAB} >> nth={labels.index(target)}")
        under = await _pointer_on(page, ".speedTab")
        if under is None or parse_rate_label(under) != target:
            logger.debug_throttled("player:speed_missed", "倍速选项不在指针下面了(菜单收起), 这次不按")
            return None
        await _click_here(page)
        await human.sleep_between(0.3, 0.6)
        return target if await current_rate_label(page) == target else None
    except TargetClosedError:
        raise
    except Exception as exc:
        logger.debug_throttled(
            "player:speed", f"倍速菜单操作失败: {logger.summarize_exception(exc)}"
        )
        return None


async def mute_by_button(page: Page) -> bool:
    # 整个操作期间占住指针, 不让别的任务把它拉走(见 Pointer.lock)
    async with pointer_for(page).lock:
        return await _mute_by_button(page)


async def _mute_by_button(page: Page) -> bool:
    """点播放器的音量按钮静音。走通返回 True。

    静音图标由播放器自己切换, 不需要我们去加 volumeNone 这个类。
    """
    try:
        if not await reveal_controls(page):
            return False
        if not await page.locator(VOLUME_ICON).first.count():
            logger.debug_throttled("player:volume_absent", "静音跳过: 没有音量按钮")
            return False
        if not await _move_onto(page, VOLUME_ICON):
            return False
        if await _pointer_on(page, ".volumeIcon") is None:
            logger.debug_throttled("player:volume_missed", "音量按钮不在指针下面了(控制栏收起), 这次不按")
            return False
        await _click_here(page)
        await human.sleep_between(0.3, 0.5)
        state = await page.evaluate(
            """() => {
                const v = document.querySelector('video');
                return v ? { muted: v.muted, volume: v.volume } : null;
            }"""
        )
        return bool(state) and (state["muted"] or state["volume"] == 0)
    except TargetClosedError:
        raise
    except Exception as exc:
        logger.debug_throttled(
            "player:volume", f"音量按钮操作失败: {logger.summarize_exception(exc)}"
        )
        return False


async def play_by_click(page: Page) -> bool:
    # 整个操作期间占住指针, 不让别的任务把它拉走(见 Pointer.lock)
    async with pointer_for(page).lock:
        return await _play_by_click(page)


async def _play_by_click(page: Page) -> bool:
    """点视频区域起播。走通(视频确实在放了)返回 True。

    只在确认处于暂停时调用: 这个区域是开关, 正在播放时点一下会变成暂停。
    """
    try:
        if not await page.locator(VIDEO_AREA).first.count():
            return False
        if not await _move_onto(page, VIDEO_AREA):
            return False
        await _click_here(page)
        await human.sleep_between(0.5, 0.9)
        paused = await page.evaluate(
            "() => { const v = document.querySelector('video'); return v ? v.paused : null; }"
        )
        return paused is False
    except TargetClosedError:
        raise
    except Exception as exc:
        logger.debug_throttled(
            "player:play", f"点击起播失败: {logger.summarize_exception(exc)}"
        )
        return False
