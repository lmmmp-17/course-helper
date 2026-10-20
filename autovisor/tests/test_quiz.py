"""课中弹题作答的测试。

桩页面(fixtures/quiz_popup.html)只接受 isTrusted 事件, 并记录每道题最终选中的
位置和点击次数, 所以"答案是不是固定落在同一个位置"可以直接断言。
"""
import math
import os
import threading
import unittest
from collections import Counter
from functools import partial
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from unittest import mock

from modules import quiz

ENABLED = os.environ.get("AUTOVISOR_E2E") == "1"
FIXTURES = Path(__file__).resolve().parent / "fixtures"


class ReadingTimeTests(unittest.TestCase):
    """读题时间要由题干长度决定, 而不是一个与内容无关的随机区间。

    本地靶场实测: 真人的「作答用时 ~ 题干长度」相关系数稳定在 +0.81~+0.99,
    而固定区间的随机等待相关系数期望为 0、单次方差极大。
    """

    LENGTHS = (12, 25, 40, 60, 85, 120)

    @staticmethod
    def _pearson(xs, ys):
        mx = sum(xs) / len(xs)
        my = sum(ys) / len(ys)
        num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
        den = math.sqrt(sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in ys))
        return num / den if den else 0.0

    def test_longer_questions_take_longer_to_read(self):
        means = [
            sum(quiz.reading_seconds(n) for _ in range(400)) / 400
            for n in self.LENGTHS
        ]
        self.assertEqual(means, sorted(means), f"字数越多用时应越长, 实际 {means}")

    def test_correlation_with_length_stays_high(self):
        # 真人基线是 +0.81~+0.99; 每一轮(六道题)都应当落在这个量级
        worst = min(
            self._pearson(self.LENGTHS, [quiz.reading_seconds(n) for n in self.LENGTHS])
            for _ in range(200)
        )
        self.assertGreater(worst, 0.7, f"最差一轮的相关系数只有 {worst:.3f}")

    def test_stays_within_sane_bounds(self):
        values = [quiz.reading_seconds(n) for n in (0, 1, 500) for _ in range(200)]
        self.assertGreaterEqual(min(values), quiz.READ_MIN_S)
        self.assertLessEqual(max(values), quiz.READ_MAX_S)


class PickOptionsTests(unittest.TestCase):
    def test_single_choice_picks_exactly_one(self):
        for _ in range(60):
            self.assertEqual(len(quiz.pick_options(4, multiple=False)), 1)

    def test_multiple_choice_picks_more_than_one_but_never_all(self):
        # 多选题只勾一个很反常; 但"每次全选"又会变成新的固定模式
        sizes = {len(quiz.pick_options(5, multiple=True)) for _ in range(200)}
        self.assertTrue(sizes <= {2, 3, 4}, sizes)
        self.assertGreater(len(sizes), 1, f"选的个数也应当有变化, 实际 {sizes}")

    def test_multiple_choice_with_two_options_picks_one(self):
        self.assertEqual(len(quiz.pick_options(2, multiple=True)), 1)

    def test_choices_are_unique_and_in_range(self):
        for _ in range(60):
            picks = quiz.pick_options(5, multiple=True)
            self.assertEqual(len(picks), len(set(picks)))
            self.assertTrue(all(0 <= i < 5 for i in picks))

    def test_no_options_returns_empty(self):
        self.assertEqual(quiz.pick_options(0, multiple=True), [])


class PickOptionTests(unittest.TestCase):
    def test_covers_every_option_not_just_the_second(self):
        # 改动前是固定点 choices[:2], 单选题答案永远落在第二个
        seen = Counter(quiz.pick_option(4) for _ in range(400))
        self.assertEqual(set(seen), {0, 1, 2, 3}, f"应当覆盖全部选项, 实际 {seen}")
        # 分布大致均匀: 没有哪个位置占到一半
        self.assertLess(max(seen.values()), 240, seen)

    def test_excludes_the_previous_choice_when_reconsidering(self):
        picks = {quiz.pick_option(3, exclude=1) for _ in range(120)}
        self.assertEqual(picks, {0, 2})

    def test_single_option_cannot_be_reconsidered(self):
        self.assertEqual(quiz.pick_option(1), 0)
        self.assertIsNone(quiz.pick_option(1, exclude=0))

    def test_no_options_returns_none(self):
        self.assertIsNone(quiz.pick_option(0))


class _QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


class _Config:
    attach_existing_chrome = False
    cdp_url = "http://127.0.0.1:9222"
    driver = os.environ.get("AUTOVISOR_E2E_DRIVER", "chrome")
    exe_path = ""


class _Logger:
    runtime_root = str(FIXTURES)

    def info(self, *_a, **_k): pass
    def debug(self, *_a, **_k): pass
    def event(self, *_a, **_k): pass
    def log_exception(self, *_a, **_k): pass
    def debug_throttled(self, *_a, **_k): pass

    def summarize_exception(self, exc):
        return str(exc)


@unittest.skipUnless(ENABLED, "设置 AUTOVISOR_E2E=1 才运行真实浏览器测试")
class QuizAnsweringE2E(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from playwright.async_api import async_playwright
        from modules.browser import create_browser_session

        self.server = HTTPServer(
            ("127.0.0.1", 0), partial(_QuietHandler, directory=str(FIXTURES))
        )
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{self.server.server_address[1]}/quiz_popup.html"

        self.playwright = await async_playwright().start()
        self.session = await create_browser_session(self.playwright, _Config(), None, _Logger())
        self.page = self.session.page
        await self.page.goto(url)

    async def asyncTearDown(self):
        await self.session.close()
        await self.playwright.stop()
        self.server.shutdown()
        self.server.server_close()

    async def probe(self):
        return await self.page.evaluate("() => window.__probe")

    def _fast(self):
        """把读题停顿压短, 否则一次要跑十几秒"""
        return mock.patch.object(quiz.human, "sleep_between", mock.AsyncMock())

    async def test_answers_every_question_with_trusted_clicks(self):
        with self._fast():
            total, answered, already = await quiz.answer_visible_questions(self.page)
        self.assertEqual((total, answered, already), (3, 3, 0))
        probe = await self.probe()
        self.assertEqual(probe["rejected"], [], f"出现不可信事件: {probe['rejected']}")
        self.assertEqual(set(probe["picks"]), {"0", "1", "2"}, "每道题都应当作答了")
        for index, counts in enumerate(probe["optionCounts"]):
            picks = probe["picks"][str(index)]
            self.assertTrue(all(0 <= i < counts for i in picks), (index, picks, counts))
            # 多选题勾多个, 单选题只勾一个。
            # 这里不断言"不全选": pick_options 本身永不全选(见 PickOptionsTests),
            # 但之后的"改主意"可能再补一个刚好补满——3 选的多选题全选是很正常的
            # 作答, 偶尔出现不构成固定模式。
            if "多选" in probe["kinds"][index] and counts >= 3:
                self.assertGreater(len(picks), 1, (index, picks))
            else:
                self.assertEqual(len(picks), 1, (index, picks))

    async def test_single_choice_is_clicked_once(self):
        with self._fast():
            await quiz.answer_visible_questions(self.page)
        probe = await self.probe()
        per_question = Counter(entry.split(":")[0] for entry in probe["clicks"])
        single = [i for i, k in enumerate(probe["kinds"]) if "多选" not in k]
        # 改动前每题固定点两次(choices[:2]), 单选题答案永远落在第二个选项
        for index in single:
            self.assertLessEqual(
                per_question[str(index)], 2,
                f"单选题最多一次改主意, 实际 {per_question}",
            )

    async def test_dialog_is_closed_by_its_own_button(self):
        with self._fast():
            await quiz.answer_visible_questions(self.page)
            closed = await quiz.dismiss_dialog(self.page)
        probe = await self.probe()
        self.assertTrue(closed)
        self.assertTrue(probe["closed"], "应当点了弹题弹窗自己的关闭按钮")
        self.assertEqual(probe["escapes"], 0, "不应再靠 Escape 关弹窗")
        self.assertEqual(probe["rejected"], [])

    async def test_already_answered_questions_are_skipped(self):
        with self._fast():
            await quiz.answer_visible_questions(self.page)
            first = len((await self.probe())["clicks"])
            total, answered, already = await quiz.answer_visible_questions(self.page)
        self.assertEqual(
            len((await self.probe())["clicks"]), first,
            "已经有 .answer 的题不应再作答",
        )
        # 第二遍必须报成"已有答案", 而不是"作答失败"
        self.assertEqual((total, answered, already), (3, 0, 3))

    async def test_reading_pause_happens_before_answering(self):
        calls = []

        async def record(low, high):
            calls.append((low, high))

        with mock.patch.object(quiz.human, "sleep_between", record):
            await quiz.answer_visible_questions(self.page)
        self.assertEqual(calls[0], (0.6, 1.8), "弹窗刚出来应当先反应一下")
        self.assertIn(quiz.BETWEEN_QUESTIONS_S, calls, "题目之间应当有停顿")
        self.assertEqual(calls[-1], quiz.BEFORE_DISMISS_S, "关掉弹窗之前应当有停顿")


if __name__ == "__main__":
    unittest.main()
