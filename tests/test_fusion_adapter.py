"""融合共享课 AI 随堂练习的处理。

真实页面(wisdom-mooc.zhihuishu.com)上看到过: 弹窗盖住播放器时, 续播模块点视频区域
点不动, 于是退回到在弹窗底下用脚本 video.play() 硬播; 提交之后适配层自己也再调一次
video.play()。现在弹窗算遮挡, 恢复播放只交给续播模块去点。
"""
import unittest
from unittest import mock

from modules import fusion_adapter, tasks
from modules.fusion_adapter import AI_CLASS_EXERCISE_DIALOG, FusionAdapter


class _Count:
    def __init__(self, n):
        self.n = n

    async def count(self):
        return self.n


class _Page:
    def __init__(self, finished=False):
        self.scripts = []
        self.finished = finished

    async def evaluate(self, script, _arg=None):
        self.scripts.append(script)
        return True

    def locator(self, selector):
        return _Count(1 if self.finished and selector == fusion_adapter._FINISHED_SELECTOR else 0)


class AiExerciseTests(unittest.IsolatedAsyncioTestCase):
    async def test_submitting_does_not_start_the_video_by_script(self):
        page = _Page()
        with mock.patch.object(FusionAdapter, "ai_exercise_visible", mock.AsyncMock(return_value=True)), \
                mock.patch.object(fusion_adapter, "_click_if_present", mock.AsyncMock(return_value=True)) as click, \
                mock.patch.object(fusion_adapter.human, "sleep_between", mock.AsyncMock()):
            self.assertTrue(await FusionAdapter.skip_ai_exercise(page))
        clicked = [c.args[1] for c in click.await_args_list]
        # 选项、提交都是点出来的; 交完还开着(显示答案)就点 × 关掉
        self.assertEqual(clicked, [fusion_adapter._OPTION_SELECTOR, fusion_adapter._SUBMIT_SELECTOR,
                                   fusion_adapter._CLOSE_SELECTOR])
        self.assertFalse([s for s in page.scripts if "play(" in s or "muted" in s], page.scripts)

    async def test_an_already_submitted_exercise_is_closed_not_answered_again(self):
        # 打开页面时平台把上次交过的练习再弹出来, 按钮是灰的"已提交": 只能点 × (真实页面)
        page = _Page(finished=True)
        with mock.patch.object(FusionAdapter, "ai_exercise_visible", mock.AsyncMock(return_value=True)), \
                mock.patch.object(fusion_adapter, "_click_if_present", mock.AsyncMock(return_value=True)) as click, \
                mock.patch.object(fusion_adapter.human, "sleep_between", mock.AsyncMock()):
            self.assertTrue(await FusionAdapter.skip_ai_exercise(page))
        self.assertEqual([c.args[1] for c in click.await_args_list], [fusion_adapter._CLOSE_SELECTOR])

    def test_the_dialog_counts_as_blocking_the_player(self):
        self.assertIn(AI_CLASS_EXERCISE_DIALOG, tasks.BLOCKING_OVERLAY_SELECTORS)


if __name__ == "__main__":
    unittest.main()
