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
