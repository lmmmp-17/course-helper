import asyncio
import time

from playwright.async_api import TimeoutError
from playwright.async_api import Page
from modules.configs import Config
from modules import human, player, quiz
from modules.utils import get_video_attr, display_window, hide_window, run_on
from playwright._impl._errors import TargetClosedError
from modules.logger import Logger
from modules.video_state import video_at_end

logger = Logger()

VERIFICATION_SELECTORS = (
    ".yidun_popup .yidun_modal",
    ".yidun_modal__title",
    "[id^='tcaptcha_transform']",
)

BLOCKING_OVERLAY_SELECTORS = (
    ".topic-title",
    ".ss2077-custom-dialog",
    # 融合共享课的 AI 随堂练习: 盖住播放器, 点视频区域起不了播, 以前会退回到
    # 在弹窗底下用脚本 video.play() 硬播(真实页面上看到过)
    ".ai-class-exercise-dialog",
)


async def has_visible_element(page: Page, selectors: tuple[str, ...]) -> bool:
    for selector in selectors:
        try:
            visible = await page.locator(selector).evaluate_all(
                """elements => elements.some(element => {
                    const style = getComputedStyle(element);
                    const rect = element.getBoundingClientRect();
                    const opacity = Number.parseFloat(style.opacity || "1");
                    return style.display !== "none" &&
                        style.visibility !== "hidden" &&
                        opacity > 0.05 &&
                        rect.width > 0 && rect.height > 0 &&
                        rect.bottom > 0 && rect.right > 0 &&
                        rect.top < innerHeight && rect.left < innerWidth;
                })"""
            )
            if visible:
                return True
        except TargetClosedError:
            raise
        except Exception as exc:
            logger.debug_throttled(
                "has_visible_element",
                f"可见元素检测遇到页面切换({', '.join(selectors)}): "
                f"{logger.summarize_exception(exc)}",
            )
    return False


async def has_visible_verification(page: Page) -> bool:
    return await has_visible_element(page, VERIFICATION_SELECTORS)


async def has_blocking_overlay(page: Page) -> bool:
    return await has_visible_verification(page) or await has_visible_element(
        page, BLOCKING_OVERLAY_SELECTORS
    )


async def wait_until_verification_hidden(page: Page) -> None:
    while await has_visible_verification(page):
        await asyncio.sleep(0.5)


def is_expected_polling_error(exc: Exception) -> bool:
    if isinstance(exc, TimeoutError):
        return True
    message = str(exc)
    expected_signals = [
        "waiting for locator",
        "waiting for selector",
        "ElementHandle.press",
        "No node found for selector",
        "Execution context was destroyed",
    ]
    return any(signal in message for signal in expected_signals)


async def task_monitor(tasks: list[asyncio.Task]) -> None:
    checked_tasks = set()
    logger.info("任务监控已启动.")
    while any(not task.done() for task in tasks):
        for i, task in enumerate(tasks):
            if task.done() and task not in checked_tasks:
                checked_tasks.add(task)
                exc = task.exception()
                func_name = task.get_coro().__name__
                if exc is not None:
                    logger.log_exception(f"任务函数 {func_name} 出现异常.", exc, shift=True)
        await asyncio.sleep(1)
    logger.info("任务监控已退出.", shift=True)


# 倍速菜单走不通时隔多久再试(秒): 4、8、16、32, 之后每 60 秒一次
SPEED_RETRY_FIRST = 4
SPEED_RETRY_MAX = 60


class SpeedGate:
    """记下哪个 (视频地址, 倍速) 已经处理过, 不再反复去点倍速菜单。

    倍速设成 max 时 "rate < limitSpeed" 永远成立: 没有这道闸, 已经在最高档了还会
    每 2 秒去菜单里再点一次(Windows 上实测, 看起来就是在无限选倍速)。
    换了视频, 或者播放器把倍速改回去了, key 跟着变, 会重新处理。

    菜单走不通(控制栏还没出来、菜单打不开)时不放弃, 只是越隔越久再试, 免得指针
    一直在控制栏上晃。曾经试 3 次就不管了: 页面刚打开那十几秒控制栏点不动, 正好
    失败 3 次, 这个视频就一直停在 1 倍速(真实页面上看到过)。
    """

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.settled = None
        self.failing = None
        self.failures = 0
        self.retry_at = 0.0

    def wants(self, key) -> bool:
        if key == self.settled:
            return False
        return key != self.failing or self.clock() >= self.retry_at

    def succeeded(self, key) -> None:
        self.settled = key
        self.failing, self.failures, self.retry_at = None, 0, 0.0

    def failed(self, key) -> None:
        self.failures = self.failures + 1 if key == self.failing else 1
        self.failing = key
        delay = min(SPEED_RETRY_MAX, SPEED_RETRY_FIRST * 2 ** (self.failures - 1))
        self.retry_at = self.clock() + delay
        logger.debug(f"倍速菜单第 {self.failures} 次没走通, {delay} 秒后再试")


async def video_optimize(page: Page, config: Config) -> None:
    # timeout=0: 一直等, 后台任务不能因为页面加载慢就退出
    await page.wait_for_load_state("domcontentloaded", timeout=0)
    speed_gate = SpeedGate()
    while True:
        try:
            await human.sleep(2.0)
            try:
                await page.wait_for_selector("video", state="attached", timeout=3000)
            except TimeoutError:
                logger.debug_throttled(
                    "video:optimize",
                    "视频调节跳过: 页面未找到元素 video",
                )
                continue
            # 弹题/安全验证的弹窗会盖住播放器, 这时控制栏点不到, 真实控件那条路
            # 必然失败并退回写属性(实测日志里就出现过 "倍速 1->1.25(写属性)")。
            # 等弹窗消失再调, 没必要在被挡住的时候硬来。
            if await has_blocking_overlay(page):
                logger.debug_throttled(
                    "video:overlay", "播放器被弹窗挡住, 这一轮不调节"
                )
                continue

            volume = await get_video_attr(page, "volume")
            muted = await get_video_attr(page, "muted")
            rate = await get_video_attr(page, "playbackRate")
            changes = []

            # volume 为 None 说明这一刻读不到播放器状态(课时切换中), 什么都别做
            if config.soundOff and volume is not None and not muted and volume != 0:
                # 先点播放器自己的音量按钮: 图标由它自己切换, 不用我们伪造 volumeNone
                if await player.mute_by_button(page):
                    changes.append(f"音量 {volume}->静音(点控件)")
                else:
                    await run_on(page, "video", "(el) => { el.volume = 0; }", "设置静音")
                    await run_on(
                        page,
                        ".volumeBox",
                        '(el) => el.classList.add("volumeNone")',
                        "更新静音图标",
                    )
                    changes.append(f"音量 {volume}->0(写属性)")

            # limitSpeed = 0 表示完全不碰倍速: 播放器自己记住的倍速也是用户的真实
            # 状态, 中途改它会产生一次 ratechange, 没必要。
            # limitSpeed = max 则切到菜单里最高的一档。
            #
            # 只用菜单里有的档位, 不再退回写 playbackRate: 菜单里没有的值只能靠
            # 写属性加伪造标签文字, 页面一眼就能看出来, 而且那也不是平台允许的档位。
            if config.limitSpeed > 0 and rate is not None and rate < config.limitSpeed:
                src = await get_video_attr(page, "currentSrc")
                if speed_gate.wants((src, rate)):
                    logger.debug(f"倍速 {rate} 低于上限, 去菜单里调(视频 ...{str(src)[-40:]})")
                    chosen = await player.raise_rate(page, config.limitSpeed)
                    if chosen is None:
                        speed_gate.failed((src, rate))
                    else:
                        if chosen != rate:
                            changes.append(f"倍速 {rate}->{chosen}(点菜单)")
                        # 记下切完之后 video 上真实的倍速: 下一轮读到的就是它
                        after = await get_video_attr(page, "playbackRate")
                        speed_gate.succeeded((src, chosen if after is None else after))

            if changes:
                logger.event("播放器调节", 项目=", ".join(changes))
        except TargetClosedError:
            logger.debug("浏览器已关闭, 视频调节模块停止运行.")
            return
        except Exception as e:
            if is_expected_polling_error(e):
                logger.debug_throttled(
                    "video_optimize",
                    f"视频调节模块轮询未命中: {logger.summarize_exception(e)}",
                )
            else:
                logger.log_exception("视频调节模块执行失败.", e)
            continue


# 播放器未就绪时最多等这么多轮(每轮约 2 秒)再退回脚本起播
MAX_NOT_READY_ROUNDS = 4


async def play_video(
    page: Page, playback_enabled: asyncio.Event | None = None
) -> None:
    # timeout=0: 一直等, 后台任务不能因为页面加载慢就退出
    await page.wait_for_load_state("domcontentloaded", timeout=0)
    not_ready_rounds = 0
    while True:
        try:
            await human.sleep(2.0)
            try:
                await page.wait_for_selector("video", state="attached", timeout=1000)
            except TimeoutError:
                logger.debug_throttled(
                    "video:play",
                    "视频播放跳过: 页面未找到元素 video",
                )
                continue
            if playback_enabled is not None and not playback_enabled.is_set():
                paused = await run_on(
                    page, "video", "(el) => el.paused", "读取视频暂停状态"
                )
                if paused is False:
                    await run_on(page, "video", "(el) => el.pause()", "暂停视频")
                continue
            state = await run_on(
                page,
                "video",
                """(el) => ({
                    paused: el.paused,
                    ended: el.ended,
                    readyState: el.readyState,
                    currentTime: el.currentTime,
                    duration: el.duration,
                })""",
                "读取播放器状态",
            )
            if state is None:
                continue
            paused = state["paused"]
            blocked = await has_blocking_overlay(page)
            if blocked:
                if not paused:
                    await run_on(page, "video", "(el) => el.pause()", "遮罩层暂停视频")
                    logger.info("检测到遮罩层,已暂停视频等待处理.")
                    logger.event("遮罩层暂停", 播放器时间=round(state["currentTime"], 1))
                continue
            at_end = state["ended"] or video_at_end(
                state["currentTime"], state["duration"]
            )
            if paused and not at_end:
                logger.info("检测到视频暂停,正在尝试播放.")
                try:
                    await page.wait_for_selector(".videoArea", timeout=1000)
                except TimeoutError:
                    logger.debug_throttled(
                        "videoArea",
                        "尝试播放跳过: 页面未找到元素 .videoArea",
                    )
                    continue
                # 先点视频区域: 真人就是这么起播的, 事件也是浏览器生成的。
                # 这个区域是开关, 所以只在上面确认 paused 之后才点。
                #
                # 课时刚切过去时播放器还在初始化, 点了也起不来。以前这里会立刻
                # 退回 el.play(), 于是每节课的第一次起播都是脚本调用。现在先让它
                # 装一会儿, 连着几轮都没就绪才退回去。
                ready = (state["readyState"] or 0) >= 3
                by_click = await player.play_by_click(page) if ready else False
                if not by_click and not ready and not_ready_rounds < MAX_NOT_READY_ROUNDS:
                    not_ready_rounds += 1
                    logger.debug_throttled(
                        "video:not_ready",
                        f"播放器还没就绪(readyState={state['readyState']}), 等下一轮再起播",
                    )
                    continue
                if not by_click:
                    await run_on(page, "video", "(el) => el.play()", "恢复播放")
                not_ready_rounds = 0
                logger.debug("视频已恢复播放.")
                logger.event(
                    "恢复播放",
                    方式="点视频区域" if by_click else "脚本调用",
                    播放器时间=round(state["currentTime"], 1),
                    总时长=round(state["duration"], 1),
                )
        except TargetClosedError:
            logger.debug("浏览器已关闭, 视频播放模块停止运行.")
            return
        except Exception as e:
            if is_expected_polling_error(e):
                logger.debug_throttled(
                    "play_video",
                    f"视频播放模块轮询未命中: {logger.summarize_exception(e)}",
                )
            else:
                logger.log_exception("视频播放模块执行失败.", e)
            continue


async def skip_questions(page: Page, event_loop) -> None:
    # timeout=0: 一直等, 后台任务不能因为页面加载慢就退出
    await page.wait_for_load_state("domcontentloaded", timeout=0)
    while True:
        try:
            if "studywisdomh5.zhihuishu.com" in page.url:
                await asyncio.sleep(2)
                if not await has_visible_element(page, (".topic-title",)):
                    continue
                logger.warn("检测到新版课中弹题,请在浏览器中手动处理.", shift=True)
                logger.event("新版课中弹题", 处理方式="手动", 地址=page.url)
                while await has_visible_element(page, (".topic-title",)):
                    await asyncio.sleep(0.5)
                event_loop.set()
                continue
            if "hike.zhihuishu.com" in page.url:
                logger.warn("当前课程为新版本,不支持自动答题.", shift=True)
                logger.event("答题", 结果="跳过", 原因="课程版本不支持")
                return
            await human.sleep(2.0)
            await page.wait_for_selector(
                quiz.QUESTION_PANEL, state="attached", timeout=1000
            )
            total_ques, answered, already = await quiz.answer_visible_questions(page)
            closed = await quiz.dismiss_dialog(page)
            if total_ques:
                logger.event(
                    "课中答题",
                    题目数=total_ques,
                    本次作答=answered,
                    已有答案=already,
                    已关闭=closed,
                )
            event_loop.set()
        except TargetClosedError:
            logger.debug("浏览器已关闭, 答题模块停止运行.")
            return
        except Exception as e:
            if is_expected_polling_error(e):
                logger.debug_throttled(
                    "skip_questions",
                    f"答题模块轮询未命中(元素 .el-scrollbar__view/.el-dialog): "
                    f"{logger.summarize_exception(e)}",
                )
            else:
                logger.log_exception("答题模块执行失败.", e)
            if "fusioncourseh5" in page.url:
                not_finish_close = await page.query_selector(".el-dialog")
                if not_finish_close:
                    await page.press(".el-dialog", "Escape", timeout=1000)
            elif "hike.zhihuishu.com" in page.url:
                logger.warn("当前课程为新版本,不支持自动答题.", shift=True)
                return
            else:
                not_finish_close = await page.query_selector(".el-message-box__headerbtn")
                if not_finish_close:
                    await not_finish_close.click()
            continue


async def wait_for_verify(page: Page, config, event_loop) -> None:
    # timeout=0: 一直等, 后台任务不能因为页面加载慢就退出
    await page.wait_for_load_state("domcontentloaded", timeout=0)
    while True:
        try:
            await asyncio.sleep(2)
            if not await has_visible_verification(page):
                continue
            event_loop.clear()
            logger.warn("检测到安全验证,请手动完成验证...", shift=True)
            logger.event("安全验证", 状态="开始", 地址=page.url)
            wait_start = time.time()
            if config.enableHideWindow:
                await display_window(page)
            await wait_until_verification_hidden(page)
            event_loop.set()
            if config.enableHideWindow:
                await hide_window(page)
            logger.info("安全验证已完成.", shift=True)
            logger.event("安全验证", 状态="完成", 耗时=f"{time.time() - wait_start:.1f}s")
            await asyncio.sleep(2)
        except TargetClosedError:
            logger.debug("浏览器已关闭, 安全验证模块停止运行.")
            return
        except Exception as e:
            if is_expected_polling_error(e):
                logger.debug_throttled(
                    "wait_for_verify",
                    f"安全验证模块轮询未命中(元素 .yidun_modal/.yidun_popup/tcaptcha): "
                    f"{logger.summarize_exception(e)}",
                )
            else:
                logger.log_exception("安全验证模块执行失败.", e)
            continue
