# encoding=utf-8
"""智慧树【新版融合共享课】适配层 (迁移自旧版 modules/fusion.py)

背景
----
官方 Autocar(3.18.3) 已把课程主循环重构进 ``modules/course_runner.py`` 的
``run_course()``, 并通过 ``modules/lesson_navigation`` 内置了
``FUSION_CATALOG``(识别 ``.chapter-content-second / .finish-icon / .item-name``)。
即"目录识别"和"课时循环"官方已支持。本适配器补齐官方缺失的三个融合页专有行为:

1. ``skip_ai_class_exercise`` — **AI 随堂练习弹窗**自动选选项并提交(官方没有)。
   - 视频播到 AI 时间点时, 智慧树会暂停视频并弹出 ``.ai-class-exercise-dialog``;
     右上角的关闭图标在没作答时不让关("未作答的弹题不能关闭"), 选任意选项并提交即可关闭。
   - 关闭后视频处于暂停, 由 ``tasks.play_video`` 点视频区域恢复; 弹窗开着时它把这里
     当成遮挡, 不会在弹窗底下起播。
2. ``expand_catalog`` — 融合目录的折叠小节展开 (官方 `get_filtered_class` 不展开)。

设计原则
--------
与官方 3.18.3 对齐: 复用 ``modules.logger.Logger`` 的
``event`` / ``debug_throttled`` / ``summarize_exception``; 只提供"适配小函数",
由官方 ``tasks.skip_questions`` 或 ``course_runner`` 在融合 catalog 分支调用,
不复制官方主循环, 便于独立测试与回退。
"""
from playwright.async_api import Page
from playwright._impl._errors import TargetClosedError

from modules import human
from modules.logger import Logger
from modules.pointer import human_click

logger = Logger()

# AI 随堂练习弹窗及其内部操作元素选择器。
AI_CLASS_EXERCISE_DIALOG = ".ai-class-exercise-dialog"
_OPTION_SELECTOR = ".ai-class-exercise-dialog .option"
_SUBMIT_SELECTOR = ".ai-class-exercise-dialog .el-dialog__footer button.el-button"
# 折叠章节头(Element-UI collapse), 需展开以采集完整课时列表。
COLLAPSE_HEADER_SELECTOR = ".el-collapse-item__header"
_COLLAPSED_HEADER_SELECTOR = ".el-collapse-item:not(.is-active) > .el-collapse-item__header"
# 单次点击的等待上限: 弹窗里的元素要么马上在, 要么不会再出现
_CLICK_TIMEOUT_MS = 3000


class FusionAdapter:
    """融合课适配层: 只做官方 run_course / tasks 未覆盖的融合页附加行为。"""

    @staticmethod
    async def ai_exercise_visible(page: Page) -> bool:
        """AI 随堂弹窗当前是否可见(考虑祖先 display/visibility, 过滤隐藏的)。"""
        try:
            return bool(
                await page.evaluate(
                    """() => {
                        const dlg = document.querySelector(%s);
                        if (!dlg) return false;
                        let p = dlg.parentElement;
                        while (p && p !== document.body) {
                            const s = getComputedStyle(p);
                            if (s.display==='none' || s.visibility==='hidden')
                                return false;
                            p = p.parentElement;
                        }
                        return dlg.offsetWidth > 0 &&
                               getComputedStyle(dlg).display !== 'none';
                    }"""
                    % ("'" + AI_CLASS_EXERCISE_DIALOG + "'",)
                )
            )
        except Exception as exc:
            logger.debug_throttled(
                "fusion:ai_visible",
                f"AI随堂弹窗检测跳过: {logger.summarize_exception(exc)}",
            )
            return False

    @staticmethod
    async def expand_catalog(page: Page) -> int:
        """展开折叠目录里未激活的章节头, 返回展开个数。"""
        # 以前在页面里批量执行 h.click(): 同一毫秒内展开所有章节, 事件还都是
        # isTrusted=false。现在逐个真实点击, 点一个就重新数一次——点开之后
        # 节点会带上 is-active, 剩余的折叠项随之变少。
        # 点完数量没减少就立刻停: 否则会对同一个章节头反复点, 来回展开收起。
        try:
            collapsed = page.locator(_COLLAPSED_HEADER_SELECTOR)
            n = 0
            for _ in range(60):
                before = await collapsed.count()
                if not before:
                    break
                await human_click(collapsed.first, timeout=_CLICK_TIMEOUT_MS)
                n += 1
                await human.sleep_between(0.25, 0.7)
                if await collapsed.count() >= before:
                    logger.debug_throttled("fusion:expand_stall", "点击后折叠项没有减少, 停止展开")
                    break
            if n:
                logger.debug(f"融合目录已展开 {n} 个折叠项")
            return n
        except Exception as e:
            logger.debug_throttled(
                "fusion:expand", f"展开折叠目录失败: {logger.summarize_exception(e)}"
            )
            return 0

    @staticmethod
    async def skip_ai_exercise(page: Page) -> bool:
        """检测 AI 随堂弹窗并自动选选项+提交, 成功(或已处理)返回 True。

        顺序: 选第一个选项 -> 点提交。恢复播放交给 tasks.play_video: 以前这里在页面里
        直接调 video.play(), 那是脚本调用, 不是点出来的。
        """
        if not await FusionAdapter.ai_exercise_visible(page):
            return False
        logger.info("检测到 AI随堂练习弹窗, 自动选择并提交.")
        try:
            # 真实点击。以前是页面里的 opt.click() / btn.click(), 事件 isTrusted=false。
            clicked = await _click_if_present(page, _OPTION_SELECTOR)
            if not clicked:
                logger.debug_throttled("fusion:ai_opt", "未找到选项按钮")
            await human.sleep_between(0.5, 1.4)
            submitted = await _click_if_present(page, _SUBMIT_SELECTOR)
            await human.sleep_between(0.8, 1.6)
            logger.info("AI 随堂练习已自动提交关闭.")
            return bool(clicked or submitted)
        except TargetClosedError:
            logger.debug("fusion:ai 浏览器已关闭.")
            return False
        except Exception as exc:
            logger.debug_throttled(
                "fusion:ai", f"AI随堂自动提交失败: {logger.summarize_exception(exc)}"
            )
            return False


async def _click_if_present(page: Page, selector: str) -> bool:
    target = page.locator(selector).first
    if not await target.count():
        return False
    await human_click(target, timeout=_CLICK_TIMEOUT_MS)
    return True
