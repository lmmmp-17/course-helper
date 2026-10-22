"""续播模块(tasks.play_video)的起播顺序。"""
import unittest
from unittest import mock

from modules import tasks


class _Stop(BaseException):
    """测试用: 点了播放就结束 play_video 的循环(它会吞掉普通 Exception)"""


class MuteBeforePlayTests(unittest.IsolatedAsyncioTestCase):
    async def test_resume_mutes_before_clicking_play(self):
        # 换课时后播放器把音量重置成 0.5; 以前续播抢先点了播放, 一秒后调节模块才静音
        order = []

        async def run_on(_page, _selector, script, _label):
            if "currentTime" in script:
                return {"paused": True, "ended": False, "readyState": 4, "currentTime": 0, "duration": 300}
            return None

        async def mute(_page, *_args):
            order.append("mute")
            return "音量 0.5->静音(点控件)"

        async def play(_page):
            order.append("play")
            raise _Stop

        page = mock.MagicMock()
        page.wait_for_load_state = mock.AsyncMock()
        page.wait_for_selector = mock.AsyncMock()
        with mock.patch.object(tasks.human, "sleep", mock.AsyncMock()), \
                mock.patch.object(tasks, "run_on", run_on), \
                mock.patch.object(tasks, "has_blocking_overlay", mock.AsyncMock(return_value=False)), \
                mock.patch.object(tasks, "mute_if_audible", mute), \
                mock.patch.object(tasks.player, "play_by_click", play):
            with self.assertRaises(_Stop):
                await tasks.play_video(page, None, sound_off=True)
        self.assertEqual(order, ["mute", "play"])


class ClickRetryTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_missed_click_is_retried_before_playing_by_script(self):
        # 平台弹题前先暂停视频, 弹窗还没完全出来: 第一下没点上就 el.play(), 视频会在
        # 弹窗底下接着放(实测)。要再点几轮, 等弹窗出来被当成遮挡。
        clicks = []

        async def run_on(_page, _selector, script, _label):
            if "currentTime" in script:
                return {"paused": True, "ended": False, "readyState": 4, "currentTime": 30, "duration": 300}
            if "play()" in script:
                raise _Stop
            return None

        async def click(_page):
            clicks.append(1)
            return False

        page = mock.MagicMock()
        page.wait_for_load_state = mock.AsyncMock()
        page.wait_for_selector = mock.AsyncMock()
        with mock.patch.object(tasks.human, "sleep", mock.AsyncMock()), \
                mock.patch.object(tasks, "run_on", run_on), \
                mock.patch.object(tasks, "has_blocking_overlay", mock.AsyncMock(return_value=False)), \
                mock.patch.object(tasks.player, "play_by_click", click):
            with self.assertRaises(_Stop):
                await tasks.play_video(page, None)
        self.assertEqual(len(clicks), tasks.MAX_CLICK_RETRIES + 1)


if __name__ == "__main__":
    unittest.main()
