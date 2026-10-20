# encoding=utf-8
import argparse
import asyncio
import os
import platform
import sys
import time
from urllib.parse import urlparse

from playwright.async_api import BrowserContext, Page, TimeoutError, async_playwright
from playwright._impl._errors import TargetClosedError

from modules import human, installer, updater
from modules.banner import print_banner
from modules.configs import Config, ConfigError
from modules.course_runner import (
    CourseOutcome,
    detect_catalog_after_verification,
    run_course,
)
from modules.browser import create_browser_session
from modules.diagnostics import check_browser, check_course, check_player, check_quiz
from modules.login import (
    LOGIN_PASSWORD_SELECTOR,
    LOGIN_SUBMIT_SELECTOR,
    LOGIN_USERNAME_SELECTOR,
    accept_login_terms,
    is_login_page,
    type_like_human,
    wait_for_login_complete,
)
from modules.logger import Logger
from modules.pointer import human_click
from modules.slider import slider_verify
from modules.stop_signal import watch_stdin_for_stop
from modules.tasks import (
    play_video,
    skip_questions,
    task_monitor,
    video_optimize,
    wait_for_verify,
)
from modules.utils import (
    clear_cookies,
    get_runtime_path,
    hide_window,
    load_cookies,
    optimize_page,
    save_cookies,
)
from modules.version import __version__

# 获取全局事件循环
event_loop_verify = asyncio.Event()
event_loop_answer = asyncio.Event()
COOKIE_PATH = get_runtime_path("data", "cookies.json")
ZHS_COOKIE_URLS = [
    "https://www.zhihuishu.com",
    "https://passport.zhihuishu.com",
    "https://onlineweb.zhihuishu.com",
    "https://studyvideoh5.zhihuishu.com",
    "https://studywisdomh5.zhihuishu.com",
    "https://fusioncourseh5.zhihuishu.com",
    "https://hike.zhihuishu.com",
]


# 课程播放页所在的几个站点: 新版(智慧)共享课、旧版、融合课、翻转课
COURSE_HOSTS = {
    "studyvideoh5.zhihuishu.com",
    "studywisdomh5.zhihuishu.com",
    "fusioncourseh5.zhihuishu.com",
    "hike.zhihuishu.com",
}


def is_course_page(url: str) -> bool:
    return (urlparse(url).hostname or "") in COURSE_HOSTS


async def wait_for_course_page(context: BrowserContext, page: Page, poll_seconds: float = 1.5) -> str:
    """没给课程地址时, 等用户在浏览器里自己点开一门课, 和学习通、雨课堂两个工具一样。

    智慧树的课程列表点课程会开一个新标签页。后台任务(续播、弹题、倍速)都绑在主标签页上,
    所以记下地址、关掉新标签页, 回到主标签页里打开同一个地址。
    """
    logger.info("请在浏览器里点开要学的课程, 进到能看到视频的播放页, 打开后会自动开始.")
    while True:
        for candidate in list(context.pages):
            if candidate.is_closed() or not is_course_page(candidate.url):
                continue
            course_url = candidate.url
            logger.event("选择课程", 地址=course_url, 新标签页=candidate is not page)
            if candidate is not page:
                await candidate.close()
                await page.bring_to_front()
            return course_url
        await asyncio.sleep(poll_seconds)


_saved_cookies = None
# 连接用户自己的 Chrome 时关掉: 不能把用户真实浏览器里的登录凭证落盘
_persist_cookies = True


def _cookies_signature(cookies):
    if not cookies:
        return None
    return frozenset(
        (
            cookie.get("name"),
            cookie.get("domain"),
            cookie.get("path"),
            cookie.get("value"),
        )
        for cookie in cookies
    )


def set_cookie_persistence(enabled: bool) -> None:
    global _persist_cookies
    _persist_cookies = enabled


def remember_login_cookies(cookies) -> None:
    """记录已经落盘的凭证, 用于跳过重复写入。"""
    global _saved_cookies
    _saved_cookies = _cookies_signature(cookies)


async def persist_login_cookies(context: BrowserContext) -> None:
    """凭证有变化时才写盘: 登录完成、Cookie 续期后立即保存, 中断也不丢。"""
    global _saved_cookies
    if not _persist_cookies:
        return
    cookies = await context.cookies(ZHS_COOKIE_URLS)
    signature = _cookies_signature(cookies)
    if signature is None or signature == _saved_cookies:
        return
    try:
        save_cookies(cookies, COOKIE_PATH)
    except Exception as exc:
        logger.log_exception("保存登录 Cookies 失败.", exc)
        return
    _saved_cookies = signature
    logger.event("保存登录凭证", 条数=len(cookies), 文件=COOKIE_PATH)


async def auto_login(context: BrowserContext, page: Page, config, modules=None) -> None:
    wait_start = time.time()
    await page.goto(config.login_url, wait_until="commit")
    if not is_login_page(page.url):
        logger.info("检测到已登录,跳过登录步骤.")
        return

    if config.username and config.password:
        try:
            await page.wait_for_selector(
                LOGIN_USERNAME_SELECTOR, state="visible", timeout=30000
            )
            await page.wait_for_selector(
                LOGIN_PASSWORD_SELECTOR, state="visible", timeout=30000
            )
            logger.event("自动登录", 方式="账号密码", 账号="已填写")
            await type_like_human(page.locator(LOGIN_USERNAME_SELECTOR).filter(visible=True).first, config.username)
            await human.sleep_between(0.4, 1.2)
            await type_like_human(page.locator(LOGIN_PASSWORD_SELECTOR).filter(visible=True).first, config.password)
            await accept_login_terms(page)
            await page.wait_for_selector(
                LOGIN_SUBMIT_SELECTOR, state="visible", timeout=30000
            )
            await human.sleep_between(0.35, 0.9)
            await human_click(page.locator(LOGIN_SUBMIT_SELECTOR).filter(visible=True).first, timeout=30000)
        except TimeoutError:
            if is_login_page(page.url):
                logger.warn("未找到自动登录控件,请在浏览器中手动完成登录.", shift=True)
                logger.event("自动登录", 方式="手动", 原因="未找到登录控件")

    captcha_task = None
    if config.enableAutoCaptcha and modules:
        logger.event("滑块任务", 状态="启动")
        captcha_task = asyncio.create_task(slider_verify(page, modules))

    try:
        await wait_for_login_complete(page)
    finally:
        if captcha_task:
            if not captcha_task.done():
                captcha_task.cancel()
            await asyncio.gather(captcha_task, return_exceptions=True)

    logger.event("登录完成", 耗时=f"{time.time() - wait_start:.1f}s", 地址=page.url)
    await persist_login_cookies(context)
    logger.info(f"已保存登录凭证到: {COOKIE_PATH},下次可免密登录.")


async def ensure_login(
    context: BrowserContext, page: Page, cookies, config, modules=None
) -> bool:
    if cookies:
        logger.info("正在校验 Cookies 登录状态...")
        await page.goto(config.login_url, wait_until="domcontentloaded")
        try:
            await wait_for_login_complete(page, timeout=10000)
        except TimeoutError:
            pass
        if not is_login_page(page.url):
            logger.info("使用Cookies登录成功!")
            logger.event("登录状态", 结果="Cookies 有效", 地址=page.url)
            await persist_login_cookies(context)
            return True
        logger.warn("检测到 Cookies 已失效, 将重新登录.", shift=True)
        logger.event("登录状态", 结果="Cookies 失效", 地址=page.url)
        clear_cookies(COOKIE_PATH)
        remember_login_cookies(None)
        cookies = None

    if not config.username or not config.password:
        logger.info("请手动填写账号密码...")
    logger.info("正在等待登录完成...")
    await auto_login(context, page, config, modules)
    logger.info("登录成功!")
    return False


async def main(config, wait_course: bool = False) -> bool:
    modules, tasks = [], []
    playback_enabled = asyncio.Event()
    all_courses_complete = True
    run_ok = True
    if config.enableAutoCaptcha:
        logger.section("依赖安装")
        logger.info("正在检查依赖库...")
        modules = installer.start(config)
        logger.info("所有依赖库安装完成!")

    logger.section("登录")
    async with async_playwright() as p:
        # 连接已有 Chrome 时沿用它自己的登录态, 不往里灌本地 Cookie
        cookies = None if config.attach_existing_chrome else load_cookies(COOKIE_PATH)
        remember_login_cookies(cookies)
        logger.event("本地凭证", 数量=len(cookies) if cookies else 0, 文件=COOKIE_PATH)
        # PR #149 合并时冲突解决丢掉了这里的 create_browser_session, 之后
        # attachExistingChrome 在正式运行中一直被静默忽略, 只有 --diagnose 认它。
        session = await asyncio.wait_for(
            create_browser_session(p, config, cookies, logger), timeout=45
        )
        page, context = session.page, session.context
        # 登录完成、每门课结束、退出时都会保存 Cookie, 统一在这里按模式开关
        set_cookie_persistence(not session.attached)
        monitor_task = None
        # 登录完成之前不落盘: 没登录就停了的话, 浏览器里只有 passport 的匿名 Cookie,
        # 存下来下次就会白白校验 13 秒, 再报一条"Cookies 已失效"(pc 实测)
        logged_in = False
        try:
            login_by_cookie = await ensure_login(context, page, cookies, config, modules)
            logged_in = True

            logger.context(登录方式="Cookie" if login_by_cookie else "账号")
            tasks.extend(
                [
                    asyncio.create_task(
                        wait_for_verify(page, config, event_loop_verify)
                    ),
                    asyncio.create_task(video_optimize(page, config)),
                    asyncio.create_task(skip_questions(page, event_loop_answer)),
                    asyncio.create_task(play_video(page, playback_enabled)),
                ]
            )
            logger.event(
                "后台任务启动",
                任务=", ".join(task.get_coro().__name__ for task in tasks),
            )
            if config.enableHideWindow and not session.attached:
                await hide_window(page)
            elif config.enableHideWindow:
                logger.info("已连接现有 Chrome, 不隐藏用户自己的浏览器窗口.")
            monitor_task = asyncio.create_task(task_monitor(tasks))

            # 没配课程地址(或者从启动器来, 指定了 --wait-course): 等用户自己点开一门课
            course_urls = [] if wait_course else list(config.course_urls)
            if not course_urls:
                logger.section("选择课程")
                course_urls = [await wait_for_course_page(context, page)]
            course_total = len(course_urls)
            for index, course_url in enumerate(course_urls, 1):
                logger.section(f"课程 {index}/{course_total}")
                logger.context(课程序号=f"{index}/{course_total}", 课程地址=course_url)
                logger.info("正在加载播放页...")
                await page.goto(course_url, wait_until="commit")
                await page.wait_for_timeout(1500)
                if "login" in page.url:
                    logger.warn(
                        "播放页跳转到登录页, 当前登录状态已失效, 正在重新登录.",
                        shift=True,
                    )
                    logger.event("登录失效", 地址=page.url)
                    clear_cookies(COOKIE_PATH)
                    remember_login_cookies(None)
                    await ensure_login(context, page, None, config, modules)
                    logger.info("重新进入播放页...")
                    await page.goto(course_url, wait_until="commit")
                    await page.wait_for_timeout(1500)

                catalog = await detect_catalog_after_verification(page, page.url)
                logger.info(f"检测到 {catalog.name} 课程目录.")
                logger.context(目录类型=catalog.name)
                logger.event("课程目录", 类型=catalog.name, 地址=page.url)
                await persist_login_cookies(context)
                await optimize_page(page, config, catalog)
                logger.info("页面优化完成!")
                if catalog.course_title:
                    title_element = page.locator(catalog.course_title).first
                    if await title_element.count():
                        title = " ".join(
                            (await title_element.text_content() or "").split()
                        )
                        if title:
                            logger.info(f"当前课程:<<{title}>>")
                            logger.context(课程名称=title)
                            logger.event("当前课程", 名称=title)

                playback_enabled.clear()
                outcome = await run_course(
                    page, catalog, config, logger, playback_enabled
                )
                playback_enabled.clear()
                logger.event("课程结果", 结果=outcome.value, 目录类型=catalog.name)
                if outcome is CourseOutcome.FAILED:
                    logger.warn("课程未确认完成,已停止本轮运行.", shift=True)
                    run_ok = False
                    break
                if outcome is CourseOutcome.TIME_LIMIT:
                    all_courses_complete = False
        finally:
            for task in tasks:
                task.cancel()
            if monitor_task:
                monitor_task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if monitor_task:
                await asyncio.gather(monitor_task, return_exceptions=True)
            try:
                if logged_in and not session.attached:
                    await persist_login_cookies(context)
            except Exception as exc:
                # 浏览器已经被关掉时存不了 Cookie 是必然的, 不是错误;
                # 再报一行 [ERROR] 会和后面那句"正常结束"自相矛盾。
                if "has been closed" in str(exc):
                    logger.debug(f"浏览器已关闭, 跳过刷新登录 Cookies: {exc}")
                else:
                    logger.log_exception("刷新登录 Cookies 失败.", exc)
            finally:
                await session.close()

    logger.section("任务结束")
    logger.event(
        "运行结果",
        正常退出=run_ok,
        全部完成=all_courses_complete,
    )
    logger.clear_context()
    if not run_ok:
        logger.warn("本轮因课时进度未确认而停止.", shift=True)
        return False
    if all_courses_complete:
        logger.info("所有课程已学习完毕!")
    else:
        logger.info("本轮已按每门课程时限结束,仍有课程未完成.", shift=True)
    return True


def parse_args():
    parser = argparse.ArgumentParser(description="Autovisor")
    parser.add_argument("--config", default=None, help="配置文件路径(默认使用程序目录下的 config.ini)")
    parser.add_argument(
        "--check-browser",
        action="store_true",
        help="只检查 Chrome 启动和智慧树登录状态",
    )
    parser.add_argument(
        "--check-course",
        metavar="URL",
        help="阻止进度上报和自动播放,只检查课程目录选择器",
    )
    parser.add_argument(
        "--check-player",
        metavar="URL",
        help="只读检查播放器控件结构(不播放、不上报进度), 用于适配倍速/静音控件",
    )
    parser.add_argument(
        "--check-quiz",
        metavar="URL",
        help="只读检查课中弹题结构(静音播放等弹题, 不作答、不上报进度)",
    )
    parser.add_argument(
        "--seek",
        metavar="SECONDS",
        type=float,
        help="配合 --check-quiz: 先跳到指定秒数, 省去等弹题的时间",
    )
    parser.add_argument(
        "--wait-course",
        action="store_true",
        help="不用配置里的课程地址, 打开浏览器后等你自己点开一门课(统一启动器用的就是这种方式)",
    )
    parser.add_argument(
        "--import-cookies",
        metavar="PATH",
        help="从 Requests CookieJar JSON 安全导入未过期的智慧树 Cookie",
    )
    return parser.parse_args()


def cli() -> int:
    global logger
    args = parse_args()
    print_banner()
    logger = Logger()
    exit_code = 0
    # 从统一启动器启动时, 它关掉 stdin 就是让我们停(见 modules/stop_signal.py)
    if os.environ.get("COURSE_UI") == "1":
        watch_stdin_for_stop()
    try:
        logger.section("初始化")
        logger.info("程序启动中...")
        logger.event(
            "运行环境",
            版本=__version__,
            Python=platform.python_version(),
            运行方式="打包" if getattr(sys, "frozen", False) else "源码",
            系统=platform.system(),
            系统版本=platform.release(),
            系统架构=platform.machine(),
            启动参数=(f"[{' '.join(sys.argv[1:])}]" if sys.argv[1:] else "无"),
            日志文件=logger.filename,
        )
        updater.check_for_update(logger)
        installer.validate_python_version()
        base_dir = os.path.dirname(sys.executable) if getattr(sys, "frozen", False) else os.path.dirname(os.path.abspath(__file__))
        config_path = args.config or os.path.join(base_dir, "config.ini")
        mirrors_path = os.path.join(base_dir, "data", "mirrors.json")
        config = Config(config_path, mirrors_path)
        logger.context(配置文件=config_path)
        logger.event(
            "运行配置",
            驱动=config.driver,
            浏览器路径=config.exe_path or "默认",
            连接现有浏览器=config.attach_existing_chrome,
            账号="已填写" if config.username else "未填写",
            密码="已填写" if config.password else "未填写",
            自动答题=config.enableAutoCaptcha,
            隐藏窗口=config.enableHideWindow,
            静音=config.soundOff,
            倍速=config.limitSpeedLabel,
            时限分钟=config.limitMaxTime,
            课程数=len(config.course_urls),
            镜像源=len(config.mirrors),
        )
        for index, course_url in enumerate(config.course_urls, 1):
            logger.event("课程地址", 序号=f"{index}/{len(config.course_urls)}", 地址=course_url)
        if args.import_cookies:
            from modules.utils import import_zhihuishu_cookies

            count = import_zhihuishu_cookies(args.import_cookies, COOKIE_PATH)
            logger.info(f"已安全导入 {count} 条智慧树 Cookie.", shift=True)
            return 0
        if args.check_browser:
            return asyncio.run(check_browser(config, logger, COOKIE_PATH))
        if args.check_player:
            return asyncio.run(
                check_player(args.check_player, config, logger, COOKIE_PATH)
            )
        if args.check_quiz:
            return asyncio.run(
                check_quiz(args.check_quiz, config, logger, COOKIE_PATH, args.seek)
            )
        if args.check_course:
            return asyncio.run(
                check_course(args.check_course, config, logger, COOKIE_PATH)
            )
        if not asyncio.run(main(config, wait_course=args.wait_course)):
            exit_code = 1
    except TargetClosedError as exc:
        if "BrowserType.launch" in repr(exc):
            logger.log_exception("浏览器相关流程异常结束.", exc)
            logger.error("浏览器启动失败,请检查 Chrome 或 CDP 配置!")
        else:
            logger.debug(f"浏览器关闭结束运行: {logger.summarize_exception(exc)}")
        exit_code = 1
    except KeyboardInterrupt:
        # Ctrl+C, 或者在启动器里点了停止: 正常结束, 不该甩一串 asyncio 堆栈
        logger.info("已停止.", shift=True)
        exit_code = 130
    except ConfigError as exc:
        logger.error(f"配置文件无效: {exc}", shift=True)
        if getattr(sys, "frozen", False):
            logger.info("请完整解压发行包，并确保 config.ini 与 Autovisor.exe 位于同一目录。")
        else:
            logger.info("源码运行请先从模板复制配置: macOS 用 config.macos.ini.example, "
                        "Linux 用 config.linux.ini.example, Windows 用 config.ini.example。")
        exit_code = 1
    except Exception as exc:
        # 用户自己把浏览器关掉是最常见的结束方式, 不该甩一串 playwright 堆栈
        if "has been closed" in str(exc):
            logger.info("浏览器已关闭, 程序结束.", shift=True)
            logger.info("如果不是你手动关的, 重新运行一次即可.", shift=True)
            logger.debug(f"底层异常: {logger.summarize_exception(exc)}")
            # 不在这里 save: finally 里统一存一次, 否则日志路径会打印两遍
            return 1
        logger.log_exception("程序运行时出现未处理异常.", exc, shift=True)
        if isinstance(exc, KeyError):
            logger.error(f"配置文件错误!")
        elif isinstance(exc, FileNotFoundError):
            logger.error(f"依赖文件缺失: {exc.filename},请重新安装程序!")
        elif isinstance(exc, UnicodeDecodeError):
            logger.error("配置文件编码错误,保存时请选择UTF-8或GBK编码!")
        else:
            logger.error("系统出错,请检查后重新启动!")
        exit_code = 1
    finally:
        logger.save()
        if getattr(sys, "frozen", False) and sys.stdin.isatty():
            try:
                input("程序已结束,按Enter退出...")
            except EOFError:
                # 非交互式运行(重定向/自动化)时 stdin 可能已关闭, 不应视作异常
                pass
    return exit_code


if __name__ == "__main__":
    sys.exit(cli())