import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import Autovisor

ROOT = Path(__file__).resolve().parent.parent


class _Page:
    def __init__(self, url):
        self.url = url
        self.closed = False
        self.fronted = 0

    def is_closed(self):
        return self.closed

    async def close(self):
        self.closed = True

    async def bring_to_front(self):
        self.fronted += 1


class _Context:
    def __init__(self, pages):
        self.pages = pages


class CoursePageTests(unittest.TestCase):
    def test_course_hosts(self):
        self.assertTrue(Autovisor.is_course_page("https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=x"))
        self.assertTrue(Autovisor.is_course_page("https://fusioncourseh5.zhihuishu.com/x"))
        self.assertTrue(Autovisor.is_course_page("https://hike.zhihuishu.com/x"))
        self.assertFalse(Autovisor.is_course_page("https://onlineweb.zhihuishu.com/onlinestuh5"))
        self.assertFalse(Autovisor.is_course_page("https://passport.zhihuishu.com/login"))
        self.assertFalse(Autovisor.is_course_page("https://studyvideoh5.zhihuishu.com.evil.example/x"))

    def test_fusion_shared_course_only_counts_its_study_pages(self):
        # 融合共享课: 播放页在 /study 下面, 同一站点的考试、知识图谱不算
        self.assertTrue(Autovisor.is_course_page(
            "https://wisdom-mooc.zhihuishu.com/study/index?recruitAndCourseId=4e5f5a5a475c4859454a585958435b425e"
        ))
        self.assertFalse(Autovisor.is_course_page("https://wisdom-mooc.zhihuishu.com/"))
        self.assertFalse(Autovisor.is_course_page("https://wisdom-mooc.zhihuishu.com/exam"))


class WaitForCourseTests(unittest.IsolatedAsyncioTestCase):
    async def test_course_opened_in_a_new_tab_is_taken_over_by_the_main_tab(self):
        # 课程列表点课程会开新标签页; 后台任务都绑在主标签页上, 所以关掉新的、回到主标签页
        main = _Page("https://onlineweb.zhihuishu.com/onlinestuh5")
        context = _Context([main])
        course = _Page("https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=abc")

        async def user_clicks():
            await asyncio.sleep(0.05)
            context.pages.append(course)

        with mock.patch.object(Autovisor, "logger", mock.MagicMock()):
            clicked = asyncio.create_task(user_clicks())
            url = await Autovisor.wait_for_course_page(context, main, poll_seconds=0.01)
            await clicked
        self.assertEqual(url, course.url)
        self.assertTrue(course.closed)
        self.assertFalse(main.closed)
        self.assertEqual(main.fronted, 1)

    async def test_course_opened_in_the_main_tab_is_used_as_is(self):
        main = _Page("https://studywisdomh5.zhihuishu.com/x")
        with mock.patch.object(Autovisor, "logger", mock.MagicMock()):
            url = await Autovisor.wait_for_course_page(_Context([main]), main, poll_seconds=0.01)
        self.assertEqual(url, main.url)
        self.assertFalse(main.closed)


class NoCourseUrlTests(unittest.TestCase):
    def _run_cli(self, argv_extra, url_line):
        with tempfile.TemporaryDirectory() as root:
            config = Path(root) / "config.ini"
            template = (ROOT / "config.linux.ini.example").read_text(encoding="utf-8")
            config.write_text(template.replace("URL1 =", url_line, 1), encoding="utf-8")
            seen = {}

            async def fake_main(cfg, wait_course=False):
                seen["wait_course"] = wait_course
                seen["urls"] = list(cfg.course_urls)
                return True

            with mock.patch("sys.argv", ["Autovisor.py", "--config", str(config), *argv_extra]), \
                    mock.patch.object(Autovisor, "print_banner"), \
                    mock.patch.object(Autovisor.updater, "check_for_update"), \
                    mock.patch.object(Autovisor, "Logger"), \
                    mock.patch.object(Autovisor, "main", fake_main):
                code = Autovisor.cli()
            return code, seen

    def test_empty_course_urls_no_longer_stop_the_run(self):
        # 以前没填课程地址直接报错退出; 现在和另外两个工具一样, 等你在浏览器里点开课程
        code, seen = self._run_cli([], "URL1 =")
        self.assertEqual(code, 0)
        self.assertEqual(seen, {"wait_course": False, "urls": []})

    def test_launcher_can_ask_to_ignore_configured_urls(self):
        code, seen = self._run_cli(["--wait-course"], "URL1 = https://studyvideoh5.zhihuishu.com/stuStudy?x=1")
        self.assertEqual(code, 0)
        self.assertTrue(seen["wait_course"])


class _Chosen(Exception):
    """测试用: 课程选好的那一刻结束 main()"""


class BackgroundTasksTests(unittest.IsolatedAsyncioTestCase):
    async def test_nothing_touches_the_page_while_waiting_for_a_course(self):
        # 以前登录完就启动续播模块, 等你点课程时它看到视频在放就暂停:
        # 认不出来的课程页开在主标签页里, 就一直被暂停, 点了播放又自己停
        started = []

        def background(name):
            async def task(*_args, **_kwargs):
                return None

            def factory(*args, **kwargs):
                started.append(name)
                return task(*args, **kwargs)
            return factory

        seen_at_choice = {}

        async def choose(_context, _page):
            seen_at_choice["started"] = list(started)
            raise _Chosen

        session = mock.MagicMock(attached=False, close=mock.AsyncMock())
        playwright = mock.MagicMock()
        playwright.__aenter__ = mock.AsyncMock(return_value=object())
        playwright.__aexit__ = mock.AsyncMock(return_value=False)
        config = mock.MagicMock(enableAutoCaptcha=False, attach_existing_chrome=False)
        with mock.patch.object(Autovisor, "logger", mock.MagicMock(), create=True), \
                mock.patch.object(Autovisor, "async_playwright", return_value=playwright), \
                mock.patch.object(Autovisor, "create_browser_session", mock.AsyncMock(return_value=session)), \
                mock.patch.object(Autovisor, "load_cookies", return_value=None), \
                mock.patch.object(Autovisor, "ensure_login", mock.AsyncMock(return_value=True)), \
                mock.patch.object(Autovisor, "persist_login_cookies", mock.AsyncMock()), \
                mock.patch.object(Autovisor, "wait_for_course_page", choose), \
                mock.patch.object(Autovisor, "play_video", background("play_video")), \
                mock.patch.object(Autovisor, "video_optimize", background("video_optimize")), \
                mock.patch.object(Autovisor, "skip_questions", background("skip_questions")), \
                mock.patch.object(Autovisor, "wait_for_verify", background("wait_for_verify")):
            with self.assertRaises(_Chosen):
                await Autovisor.main(config, wait_course=True)
        self.assertEqual(seen_at_choice["started"], [])
        session.close.assert_awaited()
