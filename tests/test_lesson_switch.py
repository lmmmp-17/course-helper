"""换课时之后要等新视频加载出来, 再读时长。"""
import unittest
from unittest import mock

from modules import course_runner


class NewVideoTests(unittest.IsolatedAsyncioTestCase):
    async def test_waits_until_the_player_has_the_new_video(self):
        # 用户朋友的日志: 课时一变成"当前"就读时长, 读到的是上一个视频的 831.5 秒
        srcs = iter([None, "old.mp4", "old.mp4", "new.mp4"])
        with mock.patch.object(course_runner, "get_video_attr", mock.AsyncMock(side_effect=lambda *_: next(srcs))), \
                mock.patch.object(course_runner.asyncio, "sleep", mock.AsyncMock()) as sleep:
            self.assertTrue(await course_runner.wait_for_new_video(object(), "old.mp4"))
        self.assertEqual(sleep.await_count, 3)

    async def test_gives_up_when_the_video_never_changes(self):
        now = [0.0]

        async def tick(_seconds):
            now[0] += 0.5

        with mock.patch.object(course_runner, "get_video_attr", mock.AsyncMock(return_value="old.mp4")), \
                mock.patch.object(course_runner.asyncio, "sleep", tick), \
                mock.patch.object(course_runner.time, "monotonic", lambda: now[0]):
            self.assertFalse(await course_runner.wait_for_new_video(object(), "old.mp4"))
        self.assertGreaterEqual(now[0], course_runner.NEW_VIDEO_TIMEOUT_S)


if __name__ == "__main__":
    unittest.main()
