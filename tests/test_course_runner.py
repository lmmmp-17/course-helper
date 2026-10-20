"""一门课的主循环: 没有视频的课时要跳过, 而不是让整门课失败。

计分的测验、PPT/PDF 这类课时不在本工具的职责范围内(需要用户自己完成),
但它们和视频课时混在同一个目录里。以前 wait_for_selector("video") 会在
这种课时上超时抛错, 整门课就此中断。
"""
import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from playwright.async_api import TimeoutError

from modules import course_runner
from modules.course_runner import CourseOutcome
from modules.lesson_navigation import WISDOM_CATALOG


class _Config:
    limitMaxTime = 0


class _Logger:
    def __init__(self):
        self.events = []
        self.messages = []

    def info(self, message, *_a, **_k):
        self.messages.append(message)

    def warn(self, *_a, **_k):
        pass

    def error(self, message, *_a, **_k):
        self.messages.append(message)

    def debug(self, *_a, **_k):
        pass

    def debug_throttled(self, *_a, **_k):
        pass

    def context(self, *_a, **_k):
        pass

    def event(self, name, **fields):
        self.events.append((name, fields))


class _Page:
    """只实现主循环用到的那几个方法; 第 2 个课时没有 video。"""

    def __init__(self, videoless):
        self.videoless = videoless
        self.lesson = 0

    async def wait_for_selector(self, selector, **_kwargs):
        if selector == "video":
            if self.lesson in self.videoless:
                raise TimeoutError("video 没出现")
            return object()
        return object()

    def set_default_timeout(self, _ms):
        pass

    def locator(self, _selector):
        raise AssertionError("主循环不应直接用 locator")

    async def wait_for_timeout(self, _ms):
        pass


class SkipLessonsWithoutVideoTests(unittest.IsolatedAsyncioTestCase):
    async def _run(self, videoless):
        page = _Page(videoless)
        logger = _Logger()
        lessons = ["第一讲", "测验(计分)", "第三讲"]

        async def fake_name(_page, lesson, _catalog):
            page.lesson = lessons.index(lesson)
            return lesson

        async def learn(*_a, **_k):
            return 0.0, True, False

        with patch.object(course_runner, "get_filtered_class", AsyncMock(return_value=lessons)), \
             patch.object(course_runner, "get_lesson_name", fake_name), \
             patch.object(course_runner, "human_click", AsyncMock()), \
             patch.object(course_runner, "wait_for_lesson_active", AsyncMock(return_value=True)), \
             patch.object(course_runner, "lesson_progress", AsyncMock(return_value=0)), \
             patch.object(course_runner, "learn_lesson", learn), \
             patch.object(course_runner.human, "sleep", AsyncMock()):
            outcome = await course_runner.run_course(
                page, WISDOM_CATALOG, _Config(), logger, asyncio.Event()
            )
        return outcome, logger

    async def test_videoless_lesson_is_skipped_and_the_course_continues(self):
        outcome, logger = await self._run(videoless={1})
        self.assertEqual(outcome, CourseOutcome.COMPLETED, "不应因为一个测验就判整门课失败")
        skips = [fields for name, fields in logger.events if name == "课时跳过"]
        self.assertEqual([f["标题"] for f in skips], ["测验(计分)"])
        result = [fields for name, fields in logger.events if name == "课程结果"][-1]
        self.assertEqual(result["跳过"], 1)
        self.assertTrue(
            any("需要你自己完成" in m for m in logger.messages),
            f"应当提示哪些课时要自己完成, 实际: {logger.messages}",
        )

    async def test_all_videos_present_means_nothing_is_skipped(self):
        outcome, logger = await self._run(videoless=set())
        self.assertEqual(outcome, CourseOutcome.COMPLETED)
        self.assertEqual([n for n, _ in logger.events if n == "课时跳过"], [])


if __name__ == "__main__":
    unittest.main()
