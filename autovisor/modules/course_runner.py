import time
from enum import Enum

from playwright.async_api import Page, TimeoutError

from modules.course_playback import elapsed_minutes, learn_lesson, review_lesson
from modules.lesson_navigation import (
    CatalogSelectors,
    detect_catalog,
    lesson_progress,
    wait_for_lesson_active,
)
from modules.tasks import has_visible_verification, wait_until_verification_hidden
from modules.utils import get_filtered_class, get_lesson_name
from modules.fusion_adapter import FusionAdapter
from modules import human
from modules.pointer import human_click

# 课时项(<li>)的点击发生在 set_default_timeout(10000) 之前, 不显式限时就会沿用
# 页面默认的 24 小时; 弹窗未关、被遮挡等异常情况下会一直卡在可操作性等待上。
LESSON_CLICK_TIMEOUT_MS = 10_000

# 目录节点在 detect_catalog 里刚确认过存在, 这里只做一次快速复核。
CATALOG_ATTACH_TIMEOUT_MS = 5_000

# 等课时里的 video 出现。等不到就说明这一节不是视频(计分测验、PPT/PDF 等),
# 跳过去学下一个, 不要卡在这里, 也不要让整门课失败。
VIDEO_ATTACH_TIMEOUT_MS = 10_000


class CourseOutcome(Enum):
    COMPLETED = "completed"
    TIME_LIMIT = "time_limit"
    FAILED = "failed"


async def detect_catalog_after_verification(
    page: Page, course_url: str
) -> CatalogSelectors:
    deadline = time.monotonic() + 20
    while True:
        if await has_visible_verification(page):
            await wait_until_verification_hidden(page)
            deadline = time.monotonic() + 20
        remaining_ms = int(max(0, deadline - time.monotonic()) * 1000)
        if remaining_ms <= 0:
            raise RuntimeError("课程目录加载超时，且未检测到可处理的安全验证")
        try:
            return await detect_catalog(
                page, course_url, timeout_ms=min(1000, remaining_ms)
            )
        except RuntimeError:
            continue


async def run_course(
    page: Page,
    catalog: CatalogSelectors,
    config,
    logger,
    playback_enabled,
) -> CourseOutcome:
    await page.wait_for_selector(
        catalog.item, state="attached", timeout=CATALOG_ATTACH_TIMEOUT_MS
    )
    # 融合共享课: 默认折叠的目录需先展开, 否则 get_filtered_class 采不全课时。
    if catalog.name == "fusion":
        # 一个个点开, 章节多的要几十秒(实测 16 个约 45 秒), 不说一声会以为卡住了
        logger.info("正在展开折叠的课程目录, 章节多的话要几十秒.")
        # AI 随堂练习的弹窗可能晚几秒才弹出来, 盖住目录的话展开时一个都点不到
        await FusionAdapter.skip_ai_exercise(page)
        await FusionAdapter.expand_catalog(page)
        await page.wait_for_timeout(400)
    to_learn = await get_filtered_class(page, catalog)
    learning = bool(to_learn)
    lessons = (
        to_learn
        if learning
        else await get_filtered_class(page, catalog, include_all=True)
    )
    logger.event(
        "目录筛选",
        模式="学习" if learning else "复习",
        待学课时=len(to_learn),
        本轮课时=len(lessons),
    )
    if not lessons:
        logger.error("课程目录中没有可播放的视频课时.")
        logger.event("课程结果", 结果="无可用课时")
        return CourseOutcome.FAILED

    start_time = time.time()
    paused_time = 0.0
    skipped: list[str] = []
    for index, lesson in enumerate(lessons):
        position = f"{index + 1}/{len(lessons)}"
        playback_enabled.clear()
        await human_click(lesson, timeout=LESSON_CLICK_TIMEOUT_MS)
        active = await wait_for_lesson_active(lesson, catalog)
        if not active:
            logger.warn("课时切换超时,正在重试一次.", shift=True)
            logger.event(
                "课时激活超时",
                序号=position,
                目录类型=catalog.name,
                选择器=catalog.active,
            )
            await human_click(lesson, timeout=LESSON_CLICK_TIMEOUT_MS)
            active = await wait_for_lesson_active(lesson, catalog)
        if not active:
            logger.error(f"无法选中课时,目录类型: {catalog.name}")
            logger.event("课程结果", 结果="课时无法选中", 序号=position)
            return CourseOutcome.FAILED

        await human.sleep(1.0)
        title = await get_lesson_name(page, lesson, catalog)
        logger.info(f"正在学习:{title}")
        initial_progress = await lesson_progress(lesson, catalog)
        logger.context(课时序号=position, 课时名称=title)
        logger.event(
            "课时开始",
            序号=position,
            标题=title,
            平台进度=f"{initial_progress}%",
        )
        lesson_start = time.time()
        page.set_default_timeout(10000)
        try:
            await page.wait_for_selector(
                "video", state="attached", timeout=VIDEO_ATTACH_TIMEOUT_MS
            )
        except TimeoutError:
            # 计分的测验、课件这类课时不在我们的职责范围内, 需要你自己完成。
            # 以前这里会抛出超时, 整门课就此中断; 现在跳过去学下一个视频。
            skipped.append(title)
            logger.info(f'"{title}" 没有视频(多半是测验或课件), 跳过.', shift=True)
            logger.event("课时跳过", 序号=position, 标题=title, 原因="没有视频")
            continue
        playback_enabled.set()

        if learning:
            added_pause, completed, reached_limit = await learn_lesson(
                page, start_time, paused_time, lesson, catalog, config, logger
            )
        else:
            added_pause, completed, reached_limit = await review_lesson(
                page, start_time, paused_time, config, logger
            )
        paused_time += added_pause

        final_progress = await lesson_progress(lesson, catalog)
        logger.event(
            "课时结果",
            序号=position,
            标题=title,
            完成=completed,
            达到时限=reached_limit,
            平台进度=f"{final_progress}%",
            本课用时=f"{time.time() - lesson_start:.0f}s",
        )
        if reached_limit:
            logger.info(f"当前课程已达时限:{config.limitMaxTime}min", shift=True)
            logger.info("即将进入下门课程!")
            logger.event("课程结果", 结果="达到时限", 课时数=len(lessons))
            return CourseOutcome.TIME_LIMIT
        if not completed:
            logger.warn(
                f'"{title}" 未能确认播放完成,本轮停止切换下一课.',
                shift=True,
            )
            logger.event(
                "课程结果",
                结果="课时未确认完成",
                序号=position,
                平台进度=f"{final_progress}%",
            )
            return CourseOutcome.FAILED

        if index < len(lessons) - 1:
            logger.info(f'"{title}" 已完成!', shift=True)
            logger.info(
                f"本次课程已学习:{elapsed_minutes(start_time, paused_time):.1f} min"
            )

    if learning:
        logger.info("已学完本课程全部内容!", shift=True)
        print("==" * 10)
    else:
        logger.info(f'"{title}" 已完成!', shift=True)
    if skipped:
        logger.info(
            f"其中 {len(skipped)} 个课时没有视频(测验或课件), 已跳过, 需要你自己完成: "
            + "、".join(skipped[:5])
            + ("…" if len(skipped) > 5 else ""),
            shift=True,
        )
    logger.event(
        "课程结果", 结果="全部完成", 课时数=len(lessons), 跳过=len(skipped)
    )
    return CourseOutcome.COMPLETED
