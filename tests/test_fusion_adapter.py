"""融合共享课 AI 随堂练习的处理。

真实页面(wisdom-mooc.zhihuishu.com)上看到过: 弹窗盖住播放器时, 续播模块点视频区域
点不动, 于是退回到在弹窗底下用脚本 video.play() 硬播; 提交之后适配层自己也再调一次
video.play()。现在弹窗算遮挡, 恢复播放只交给续播模块去点。
"""
import unittest
from unittest import mock

from modules import fusion_adapter, tasks
from modules.fusion_adapter import AI_CLASS_EXERCISE_DIALOG, FusionAdapter


class _Page:
    def __init__(self):
        self.scripts = []

    async def evaluate(self, script, _arg=None):
        self.scripts.append(script)
        return True


class AiExerciseTests(unittest.IsolatedAsyncioTestCase):
    async def test_submitting_does_not_start_the_video_by_script(self):
        page = _Page()
        with mock.patch.object(FusionAdapter, "ai_exercise_visible", mock.AsyncMock(return_value=True)), \
                mock.patch.object(fusion_adapter, "_click_if_present", mock.AsyncMock(return_value=True)) as click, \
                mock.patch.object(fusion_adapter.human, "sleep_between", mock.AsyncMock()):
            self.assertTrue(await FusionAdapter.skip_ai_exercise(page))
        self.assertEqual(click.await_count, 2, "选项和提交都应当是点出来的")
        self.assertFalse([s for s in page.scripts if "play(" in s or "muted" in s], page.scripts)

    def test_the_dialog_counts_as_blocking_the_player(self):
        self.assertIn(AI_CLASS_EXERCISE_DIALOG, tasks.BLOCKING_OVERLAY_SELECTORS)


if __name__ == "__main__":
    unittest.main()
