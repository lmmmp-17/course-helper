"""课中弹题作答。

改动前的行为(modules/tasks.py 里的 skip_questions):

    for each in choices[:2]:          # 固定点"前两个"选项
        await each.click(timeout=500)
        await page.wait_for_timeout(100)

问题不在于乱选——这类弹题本来就是随便选一个关掉——而在于它选得太有规律:

* 单选题点第一个再点第二个, 最终答案永远落在第二个选项上, 并且产生两次选择事件;
* 选项之间固定 100ms, 弹题出现到关闭总共一秒多, 没有任何读题时间;
* 用 Playwright 的 locator.click(), 一步瞬移到选项几何中心, 按下抬起没有间隔。

现在改成: 随机选一个, 带读题停顿, 走有轨迹的真实点击, 并且小概率"改一次主意"
(先点一个再换另一个)——人确实会这么做, 但不是每道题都做。

依旧不尝试答对: 判断对错要另外一套东西, 不在这里的职责范围内。
"""
import asyncio

from playwright.async_api import Page
from playwright._impl._errors import TargetClosedError

from modules import human
from modules.logger import Logger
from modules.pointer import human_click

logger = Logger()

# 以下选择器都是 --check-quiz 在真实弹题上取到的。
#
# 弹题弹窗有唯一 id, 必须用它: 页面上同时存在 12 个 .el-dialog(AI 助教、异常提示
# 等等, 大多是隐藏的), 原来按 ".el-dialog" 定位会打在第一个隐藏的"温馨提示"上,
# 所以那句 page.press(".el-dialog", "Escape") 一直在超时, 弹窗从来不是它关掉的。
DIALOG = "#playTopic-dialog"
# 关闭按钮是 footer 里的 div.btn(文字"关闭"), 不是 el-button; header 上还有个 ×
DIALOG_CLOSE = f"{DIALOG} .dialog-footer .btn"
DIALOG_CLOSE_X = f"{DIALOG} .el-dialog__headerbtn"

QUESTION_PANEL = f"{DIALOG} .el-scrollbar__view"
# 一道题一个 .topic; 题号是 Element UI 分页器里的页码
QUESTION = f"{QUESTION_PANEL} .topic"
QUESTION_NUMBER = f"{QUESTION_PANEL} .el-pager li.number"
# 题型写在标题里: 【多选题】/【单选题】/【判断题】
QUESTION_KIND = f"{QUESTION_PANEL} .topic-title .title-tit"
# .answer 是答过之后显示的"正确答案：X", 作用等于"这道题不用再答了"。
# 它在 .topic 内部, 所以按当前题判断, 不扫全页(别的隐藏弹窗里也有 .answer)
EXISTING_ANSWER = f"{QUESTION} .answer"
OPTION = f"{QUESTION_PANEL} .topic-list .topic-item"

# 单次点击的等待上限: 弹题上的元素要么在, 要么这道题不长这样
OPTION_CLICK_TIMEOUT_MS = 4000

# 读题时间按题目的文字量算, 不是一个与内容无关的固定区间。
#
# 本地靶场实测: 真人的「作答用时 ~ 题干长度」相关系数稳定在 +0.81~+0.99,
# 因为用时确实由题干长度驱动; 而固定区间的随机等待与内容无关, 相关系数
# 期望为 0。所以这里按字数估算, 再抖动。
READ_BASE_S = 1.2            # 弹窗出现到看清题目在哪、是什么题型
READ_SPEED_CPS = (4.5, 9.0)  # 中文阅读速度, 字/秒
READ_MIN_S = 1.8
READ_MAX_S = 25.0
# 选项之间、题目之间
BETWEEN_OPTIONS_S = (0.6, 1.8)
BETWEEN_QUESTIONS_S = (1.2, 3.5)
# 答完到关掉弹窗
BEFORE_DISMISS_S = (0.8, 2.4)
# 改主意的概率: 先点一个, 再换成另一个
RECONSIDER_CHANCE = 0.18

MULTI_CHOICE_MARK = "多选"


def pick_option(count: int, exclude: int | None = None) -> int | None:
    """从 count 个选项里随机挑一个, 可以排除某一个(用于改主意)。"""
    if count <= 0:
        return None
    candidates = [i for i in range(count) if i != exclude]
    if not candidates:
        return None
    return human.pick(candidates)


def pick_options(count: int, multiple: bool) -> list[int]:
    """按题型决定选哪几个。

    单选只选一个。多选选两个以上——多选题只勾一个很反常——但避开"全选":
    那会让多选题的答案永远是同一个固定模式, 和原来固定点前两个一样显眼。
    依旧不尝试答对, 这里只负责让交互形态符合题型。
    """
    if count <= 0:
        return []
    if not multiple or count < 3:
        choice = pick_option(count)
        return [] if choice is None else [choice]
    how_many = human.pick(range(2, count))
    return sorted(human.sample(range(count), how_many))


def reading_seconds(chars: int) -> float:
    """读 chars 个字需要多久。速度取区间中部附近, 保证用时主要由字数决定。"""
    speed = human.gauss_within(*READ_SPEED_CPS)
    return min(READ_MAX_S, max(READ_MIN_S, READ_BASE_S + max(0, chars) / speed))


async def read_current_question(page: Page) -> float:
    """按当前这道题的文字量停一会儿再动手, 返回实际停了多久。"""
    chars = 0
    topic = page.locator(QUESTION).first
    try:
        if await topic.count():
            chars = len((await topic.inner_text() or "").strip())
    except TargetClosedError:
        raise
    except Exception as exc:
        logger.debug_throttled("quiz:read", f"读题干失败: {logger.summarize_exception(exc)}")
    seconds = reading_seconds(chars)
    await asyncio.sleep(seconds)
    return seconds


async def question_is_multiple(page: Page) -> bool:
    kind = page.locator(QUESTION_KIND).first
    if not await kind.count():
        return False
    return MULTI_CHOICE_MARK in (await kind.inner_text() or "")


async def _click_option(page: Page, index: int) -> bool:
    options = page.locator(OPTION)
    if index >= await options.count():
        return False
    await human_click(options.nth(index), timeout=OPTION_CLICK_TIMEOUT_MS)
    return True


async def answer_one_question(page: Page) -> bool:
    """给当前显示的这道题作答。选了返回 True。"""
    await read_current_question(page)
    count = await page.locator(OPTION).count()
    multiple = await question_is_multiple(page)
    choices = pick_options(count, multiple)
    if not choices:
        logger.debug_throttled("quiz:no_option", "这道题没有可选项, 跳过")
        return False

    for position, choice in enumerate(choices):
        if position > 0:
            await human.sleep_between(*BETWEEN_OPTIONS_S)
        if not await _click_option(page, choice):
            return position > 0

    # 偶尔改一次主意: 人会先点一个再换, 但不是每题都换。单选换成另一个,
    # 多选再补一个没选过的。
    if count > 1 and human.chance(RECONSIDER_CHANCE):
        extra = pick_option(count, exclude=choices[-1] if not multiple else None)
        if multiple:
            remaining = [i for i in range(count) if i not in choices]
            extra = human.pick(remaining) if remaining else None
        if extra is not None:
            await human.sleep_between(*BETWEEN_OPTIONS_S)
            await _click_option(page, extra)
    return True


async def answer_visible_questions(page: Page) -> tuple[int, int, int]:
    """逐题作答, 返回 (题目数, 本次作答数, 已有答案数)。

    已有答案的题跳过——同一个弹题在之前的运行里答过时就是这种情况, 日志里把两者
    分开记, 免得"已作答=0"看起来像是答题坏了。
    """
    numbers = page.locator(QUESTION_NUMBER)
    total = await numbers.count()
    if total == 0:
        return 0, 0, 0

    # 弹窗刚弹出来, 先反应一下; 具体的读题时间按每道题的字数另算
    await human.sleep_between(0.6, 1.8)

    answered = 0
    already = 0
    for index in range(total):
        if index > 0:
            await human.sleep_between(*BETWEEN_QUESTIONS_S)
        try:
            await human_click(numbers.nth(index), timeout=OPTION_CLICK_TIMEOUT_MS)
        except TargetClosedError:
            raise
        except Exception as exc:
            logger.debug_throttled(
                "quiz:number", f"切到第 {index + 1} 题失败: {logger.summarize_exception(exc)}"
            )
            continue
        if await page.locator(EXISTING_ANSWER).count():
            already += 1
            continue
        if await answer_one_question(page):
            answered += 1

    await human.sleep_between(*BEFORE_DISMISS_S)
    return total, answered, already


async def dismiss_dialog(page: Page) -> bool:
    """点弹题弹窗自己的关闭按钮。关掉了返回 True。

    原来是 page.press(".el-dialog", "Escape"): 那个选择器会命中页面上第一个
    (隐藏的)对话框, 一直超时。
    """
    for selector in (DIALOG_CLOSE, DIALOG_CLOSE_X):
        target = page.locator(selector).first
        try:
            if not await target.count() or not await target.is_visible():
                continue
            await human_click(target, timeout=OPTION_CLICK_TIMEOUT_MS)
            await human.sleep_between(*BETWEEN_OPTIONS_S)
            if not await page.locator(f"{DIALOG} .el-dialog").first.is_visible():
                return True
        except TargetClosedError:
            raise
        except Exception as exc:
            logger.debug_throttled(
                "quiz:dismiss", f"关闭弹题失败({selector}): {logger.summarize_exception(exc)}"
            )
    return False
