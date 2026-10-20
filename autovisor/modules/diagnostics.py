import asyncio
import os
from pathlib import Path

from playwright.async_api import TimeoutError as PlaywrightTimeoutError
from playwright.async_api import async_playwright

from modules.browser import create_browser_session, get_effective_driver
from modules.pointer import human_click, pointer_for
from modules.lesson_navigation import (
    CATALOGS,
    detect_catalog,
    get_lesson_title,
    lesson_is_complete,
    lesson_progress,
)
from modules.login import is_login_page
from modules.tasks import has_visible_verification
from modules.utils import load_cookies


async def check_browser(config, logger, cookie_path: str) -> int:
    async with async_playwright() as playwright:
        cookies = None if config.attach_existing_chrome else load_cookies(cookie_path)
        session = await asyncio.wait_for(
            create_browser_session(playwright, config, cookies, logger), timeout=45
        )
        try:
            await session.page.goto(
                "https://onlineweb.zhihuishu.com/onlinestuh5",
                wait_until="commit",
                timeout=15000,
            )
            # 登录态无效时平台会跳到登录中心, 跳转要几秒, 而且不止一跳: 实测是
            #   onlinestuh5 → passport.zhihuishu.com → login.zhihuishu.com
            # 所以要用 login.py 里那组登录域名判断, 只认 passport 会在页面已经
            # 落到 login.zhihuishu.com 之后判成"通过"。
            browser_name = get_effective_driver(config.driver)
            try:
                await session.page.wait_for_load_state("load", timeout=15000)
            except PlaywrightTimeoutError:
                pass
            try:
                await session.page.wait_for_url(is_login_page, timeout=8000)
            except PlaywrightTimeoutError:
                pass  # 没跳走, 多半是登录态有效
            # 跳转链还没走完时再给一会儿, 停住了就提前退出
            for _ in range(10):
                if is_login_page(session.page.url):
                    break
                await session.page.wait_for_timeout(500)
            if is_login_page(session.page.url):
                logger.warn(f"{browser_name} 已连接, 但智慧树登录状态无效.", shift=True)
                logger.info("在打开的浏览器里登录一次, 之后会记住.", shift=True)
                return 1
            title = (await session.page.title()).strip()
            if not title:
                logger.warn(
                    f"{browser_name} 已连接, 但页面没有加载出来, 无法判断登录状态.",
                    shift=True,
                )
                logger.info(f"当前地址: {session.page.url}", shift=True)
                return 1
            logger.info(f"浏览器检查通过: {title}", shift=True)
            return 0
        finally:
            await session.close()


# 进度上报接口。诊断命令会把这些请求拦掉, 保证只读检查不会动真实学习进度。
PROGRESS_MARKERS = (
    "saveDatabaseIntervalTime",
    "saveCacheIntervalTime",
    "saveStuStudyRecord",
    "saveLearningTime",
    "saveStudyTime",
)

# 让 play() 变成空操作, 页面自动播放也立刻被暂停
NO_PLAYBACK_SCRIPT = (
    "HTMLMediaElement.prototype.play = function() { "
    "this.pause(); return Promise.resolve(); }; "
    "addEventListener('play', event => event.target.pause(), true);"
)


class ReadOnlyGuard:
    """诊断用的只读护栏: 不上报进度、不播放, 可选是否下载媒体。

    检查播放器控件时必须放开媒体: 媒体被拦时播放器会进入"视频无法播放"的错误态,
    控制栏根本不会初始化, 什么都看不到。进度上报始终拦住, 所以不会产生学习记录。
    """

    def __init__(self, block_media: bool = True):
        self.block_media = block_media
        self.blocked_requests = 0
        self.blocked_media = 0

    async def route(self, route):
        if self.block_media and route.request.resource_type == "media":
            self.blocked_media += 1
            await route.abort()
        elif any(marker in route.request.url for marker in PROGRESS_MARKERS):
            self.blocked_requests += 1
            await route.abort()
        else:
            await route.continue_()

    async def install(self, page):
        await page.route("**/*", self.route)
        await page.add_init_script(NO_PLAYBACK_SCRIPT)


async def check_course(course_url: str, config, logger, cookie_path: str) -> int:
    guard = ReadOnlyGuard()

    async def block_progress(route):
        await guard.route(route)

    async with async_playwright() as playwright:
        cookies = None if config.attach_existing_chrome else load_cookies(cookie_path)
        session = await asyncio.wait_for(
            create_browser_session(playwright, config, cookies, logger), timeout=45
        )
        try:
            page = session.page
            await page.route("**/*", block_progress)
            await page.add_init_script(NO_PLAYBACK_SCRIPT)
            await page.goto(course_url, wait_until="commit", timeout=15000)
            await page.wait_for_timeout(10000)
            screenshot_path = Path.home() / "scratch-data" / "autovisor-course-check.png"
            html_path = Path.home() / "scratch-data" / "autovisor-course-check.html"
            screenshot_path.parent.mkdir(parents=True, exist_ok=True)
            if os.name != "nt":
                screenshot_path.parent.chmod(0o700)
            try:
                catalog = await detect_catalog(page, page.url, timeout_ms=15000)
            except RuntimeError:
                await page.screenshot(path=str(screenshot_path), full_page=False)
                html_path.write_text(await page.content(), encoding="utf-8")
                if os.name != "nt":
                    screenshot_path.chmod(0o600)
                    html_path.chmod(0o600)
                body_text = await page.locator("body").inner_text(timeout=3000)
                logger.error(
                    f"目录检查失败: title={await page.title()!r}, url={page.url}, "
                    f"body_length={len(body_text)}, screenshot={screenshot_path}, "
                    f"html={html_path}"
                )
                raise
            selectors = {entry.name: entry.item for entry in CATALOGS}
            selectors["video"] = "video"
            counts = {
                name: await page.locator(selector).count()
                for name, selector in selectors.items()
            }
            lessons = await page.locator(catalog.item).all()
            completed_count = sum(
                [await lesson_is_complete(lesson, catalog) for lesson in lessons]
            )
            active = page.locator(catalog.active).first
            if await active.count():
                active_title = await get_lesson_title(page, active, catalog)
                active_progress = await lesson_progress(active, catalog)
            else:
                active_title = None
                active_progress = None
            body_text = await page.locator("body").inner_text(timeout=3000)
            verification_visible = await has_visible_verification(page)
            video_paused = await page.locator("video").evaluate_all(
                "videos => videos.map(video => video.paused)"
            )
            frame_urls = [frame.url for frame in page.frames]
            await page.screenshot(path=str(screenshot_path), full_page=False)
            html_path.write_text(await page.content(), encoding="utf-8")
            if os.name != "nt":
                screenshot_path.chmod(0o600)
                html_path.chmod(0o600)
            logger.info(
                f"课程页检查: title={await page.title()!r}, "
                f"url={page.url}, catalog={catalog.name}, selectors={counts}, "
                f"completed={completed_count}/{len(lessons)}, "
                f"active={active_title!r}, active_progress={active_progress}, "
                f"video_paused={video_paused}, blocked_media={guard.blocked_media}, "
                f"blocked_progress={guard.blocked_requests}, "
                f"verification_visible={verification_visible}, "
                f"body_length={len(body_text)}, frames={frame_urls}, "
                f"screenshot={screenshot_path}, html={html_path}",
                shift=True,
            )
            return 0
        finally:
            await session.close()

# 播放器控件容器。倍速菜单通常要悬停才展开, 所以 check_player 会先 hover 再记录。
PLAYER_CONTROLS = (".videoArea", ".volumeBox", ".speedBox")

DUMP_SUBTREE_JS = """(selectors) => {
  const describe = (el, depth) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const ownText = Array.from(el.childNodes)
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent.trim())
      .filter(Boolean)
      .join(' ');
    return {
      depth,
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      cls: typeof el.className === 'string' ? el.className : '',
      text: ownText.slice(0, 40),
      rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
      visible: rect.width > 0 && rect.height > 0 && style.display !== 'none'
               && style.visibility !== 'hidden' && style.opacity !== '0',
      clickable: style.cursor === 'pointer',
    };
  };
  const walk = (root, depth, out) => {
    out.push(describe(root, depth));
    if (depth < 4) {
      for (const child of root.children) walk(child, depth + 1, out);
    }
    return out;
  };
  const result = {};
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    result[selector] = el ? walk(el, 0, []) : null;
  }
  return result;
}"""

ANCESTORS_JS = """(selector) => {
  const el = document.querySelector(selector);
  if (!el) return null;
  const out = [];
  for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
    const s = getComputedStyle(node);
    const r = node.getBoundingClientRect();
    out.push({
      tag: node.tagName.toLowerCase(),
      cls: (typeof node.className === 'string' ? node.className : '').slice(0, 60),
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      display: s.display, visibility: s.visibility, opacity: s.opacity,
      pointerEvents: s.pointerEvents, overflow: s.overflow, position: s.position,
    });
  }
  return out;
}"""

VIDEO_STATE_JS = """() => {
  const video = document.querySelector('video');
  if (!video) return null;
  return {
    playbackRate: video.playbackRate,
    muted: video.muted,
    volume: video.volume,
    paused: video.paused,
    duration: video.duration,
    readyState: video.readyState,
  };
}"""


def _render_subtree(nodes) -> str:
    lines = []
    for node in nodes:
        marks = "".join(
            [
                "" if node["visible"] else " [隐藏]",
                " [cursor:pointer]" if node["clickable"] else "",
            ]
        )
        name = node["tag"]
        if node["id"]:
            name += f"#{node['id']}"
        if node["cls"]:
            name += f".{'.'.join(node['cls'].split()[:3])}"
        text = f" {node['text']!r}" if node["text"] else ""
        x, y, w, h = node["rect"]
        lines.append(f"{'  ' * node['depth']}{name}{text} {w}x{h} @{x},{y}{marks}")
    return "\n".join(lines)


async def check_player(course_url: str, config, logger, cookie_path: str) -> int:
    """只读检查播放器控件结构, 用于把倍速/静音/起播改成点真实控件。

    全程不播放、不下载媒体、不上报进度, 不会改变课程学习进度。
    """
    guard = ReadOnlyGuard(block_media=False)
    async with async_playwright() as playwright:
        cookies = None if config.attach_existing_chrome else load_cookies(cookie_path)
        session = await asyncio.wait_for(
            create_browser_session(playwright, config, cookies, logger), timeout=45
        )
        try:
            page = session.page
            await guard.install(page)
            await page.goto(course_url, wait_until="commit", timeout=15000)
            try:
                await page.wait_for_selector("video", state="attached", timeout=30000)
            except PlaywrightTimeoutError:
                # 留下现场: 多半是页面停在了别的东西上(弹窗、登录、换课提示)
                shot = Path.home() / "scratch-data" / "autovisor-player-check.png"
                shot.parent.mkdir(parents=True, exist_ok=True)
                if os.name != "nt":
                    shot.parent.chmod(0o700)
                await page.screenshot(path=str(shot), full_page=False)
                if os.name != "nt":
                    shot.chmod(0o600)
                body = (await page.locator("body").inner_text(timeout=3000))[:400]
                logger.error(
                    "播放器检查失败: 页面上没有出现 video 元素. "
                    f"url={page.url} title={await page.title()!r} "
                    f"frames={[f.url for f in page.frames]} 截图={shot}",
                    shift=True,
                )
                logger.info(f"页面文字(前 400 字): {body!r}")
                return 1
            await page.wait_for_timeout(3000)

            state = await page.evaluate(VIDEO_STATE_JS)
            logger.info(f"播放器初始状态: {state}", shift=True)

            # 先记录未悬停时的结构, 再逐个悬停控件, 看菜单展开后多出什么
            report = ["", "===== 播放器控件(未悬停) ====="]
            dump = await page.evaluate(DUMP_SUBTREE_JS, list(PLAYER_CONTROLS))
            for selector in PLAYER_CONTROLS:
                report.append(f"--- {selector} ---")
                report.append(
                    _render_subtree(dump[selector]) if dump[selector] else "  (页面上没有这个元素)"
                )

            # 控制栏平时是收起的, 必须先把指针移到视频区域才会出现——真人也是这样。
            # 这里用原始鼠标移动而不是 locator.hover(): 后者带可交互性检查, 而我们
            # 要的只是"把指针放过去", 不需要元素先满足可点击条件。
            pointer = pointer_for(page)

            async def move_over(selector: str) -> bool:
                box = await page.locator(selector).first.bounding_box()
                if not box:
                    return False
                await pointer.move_to(
                    box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
                )
                # 和 player._move_onto 一样要补一次微动迫使重新命中测试。
                # 少了这一步, 悬停才展开的菜单会被误判成"没有展开"。
                await page.mouse.move(round(pointer.x) + 1, round(pointer.y))
                pointer.x += 1
                await page.wait_for_timeout(700)
                return True

            report.append(f"指针移到 .videoArea: {await move_over('.videoArea')}")

            for selector in (".speedBox", ".volumeBox"):
                if not await page.locator(selector).first.count():
                    continue
                if not await move_over(selector):
                    report.append(f"--- {selector} (拿不到位置, 控制栏可能仍收起) ---")
                    continue
                hovered = await page.evaluate(DUMP_SUBTREE_JS, [selector])
                report += [f"--- {selector} (指针移上去之后) ---", _render_subtree(hovered[selector])]

            # 菜单可能是点开的而不是悬停展开的。点 .speedBox 本身只打开菜单,
            # 不会改倍速(改倍速要点里面的 .speedTab), 所以这一步仍是只读的。
            for selector in (".speedBox", ".volumeBox"):
                target = page.locator(selector).first
                if not await target.count():
                    continue
                try:
                    await human_click(target, timeout=4000)
                    await page.wait_for_timeout(800)
                    clicked = await page.evaluate(DUMP_SUBTREE_JS, [selector])
                    report += [
                        f"--- {selector} (点一下之后) ---",
                        _render_subtree(clicked[selector]),
                    ]
                except Exception as exc:
                    report.append(f"--- {selector} (点击失败: {logger.summarize_exception(exc)}) ---")

            report.append("")
            report.append("===== 控件的祖先链(找出是哪一层把它藏起来的) =====")
            for selector in (".speedBox", ".volumeBox"):
                chain = await page.evaluate(ANCESTORS_JS, selector)
                if not chain:
                    continue
                report.append(f"--- {selector} 往上 ---")
                for level, node in enumerate(chain):
                    name = f"{node['tag']}" + (f".{'.'.join(node['cls'].split()[:2])}" if node['cls'] else "")
                    x, y, w, h = node["rect"]
                    report.append(
                        f"{'  ' * level}{name} {w}x{h} @{x},{y} "
                        f"display={node['display']} vis={node['visibility']} "
                        f"opacity={node['opacity']} pointer={node['pointerEvents']} "
                        f"pos={node['position']} overflow={node['overflow']}"
                    )

            report += [
                "",
                f"拦截统计: 媒体={guard.blocked_media} 进度上报={guard.blocked_requests}",
                "",
            ]
            print("\n".join(report))
            logger.info("播放器检查完成, 未播放也未上报进度.", shift=True)
            return 0
        finally:
            await session.close()


# 弹题弹窗与题目容器。只读检查用, 真正的操作选择器在 modules/quiz.py。
QUIZ_PARTS = ("#playTopic-dialog", "#playTopic-dialog .el-scrollbar__view")

QUIZ_FACTS_JS = """() => {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const path = (el) => {
    const out = [];
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const cls = typeof n.className === 'string' && n.className
        ? '.' + n.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
      out.unshift(n.tagName.toLowerCase() + cls);
    }
    return out.join(' > ');
  };
  const dialogs = q('.el-dialog');
  return {
    dialog_total: dialogs.length,
    dialog_visible: dialogs.filter(vis).length,
    quiz_dialog_found: q('#playTopic-dialog').length,
    questions: q('#playTopic-dialog .el-scrollbar__view .topic').length,
    numbers: q('#playTopic-dialog .el-scrollbar__view .el-pager li.number').map((e) => e.textContent.trim()),
    kind: (q('#playTopic-dialog .topic-title .title-tit')[0] || {}).textContent || null,
    title: (q('#playTopic-dialog .topic-title')[0] || {}).textContent || null,
    options: q('#playTopic-dialog .topic-list .topic-item').map((e) => e.textContent.trim().slice(0, 24)),
    answers_in_question: q('#playTopic-dialog .el-scrollbar__view .topic .answer').map((e) => e.textContent.trim().slice(0, 30)),
    answers_whole_page: q('.answer').map((e) => path(e)),
    close_button: (q('#playTopic-dialog .dialog-footer .btn')[0] || {}).textContent || null,
  };
}"""


async def check_quiz(course_url: str, config, logger, cookie_path: str, seek: float | None = None) -> int:
    """只读检查课中弹题的结构, 用于适配弹题选择器。

    会静音播放等弹题出现(可以用 --seek 跳到已知的弹题时间点), 但拦掉进度上报,
    也不作答、不关闭弹窗, 所以不会产生学习记录。
    """
    guard = ReadOnlyGuard(block_media=False)
    async with async_playwright() as playwright:
        cookies = None if config.attach_existing_chrome else load_cookies(cookie_path)
        session = await asyncio.wait_for(
            create_browser_session(playwright, config, cookies, logger), timeout=45
        )
        try:
            page = session.page
            # 这里只拦进度上报, 不装 NO_PLAYBACK_SCRIPT: 弹题要靠播放才会出现
            await page.route("**/*", guard.route)
            await page.goto(course_url, wait_until="commit", timeout=15000)
            await page.wait_for_selector("video", state="attached", timeout=30000)
            await page.wait_for_timeout(4000)

            await page.evaluate(
                """(target) => {
                    const video = document.querySelector('video');
                    if (!video) return;
                    video.muted = true;
                    if (target !== null) video.currentTime = target;
                    video.play().catch(() => {});
                }""",
                seek,
            )
            logger.info(
                "已静音播放, 正在等课中弹题出现(最多 5 分钟)..."
                + (f" 已跳到 {seek:.0f}s" if seek is not None else ""),
                shift=True,
            )
            try:
                await page.wait_for_selector(".topic-title", state="visible", timeout=300000)
            except PlaywrightTimeoutError:
                logger.warn("等待期间没有出现课中弹题.", shift=True)
                return 1
            await page.wait_for_timeout(1500)
            await page.evaluate("() => document.querySelector('video').pause()")

            facts = await page.evaluate(QUIZ_FACTS_JS)
            report = ["", "===== 课中弹题 ====="]
            report.append(f"全页 .el-dialog: {facts['dialog_total']} 个, 其中可见 {facts['dialog_visible']} 个")
            report.append(f"  (所以不能按 .el-dialog 定位弹题, 要用 #playTopic-dialog)")
            report.append(f"#playTopic-dialog: {facts['quiz_dialog_found']} 个")
            report.append(f"题目(.topic): {facts['questions']} 个   题号(.el-pager li.number): {facts['numbers']}")
            report.append(f"题型: {facts['kind']!r}")
            report.append(f"标题: {(facts['title'] or '')[:60]!r}")
            report.append(f"选项: {facts['options']}")
            report.append(f"当前题内的 .answer: {facts['answers_in_question']}")
            report.append(f"全页 .answer 共 {len(facts['answers_whole_page'])} 处:")
            for item in facts["answers_whole_page"]:
                report.append(f"    {item}")
            report.append(f"关闭按钮文字: {facts['close_button']!r}")
            report.append("")
            for selector in QUIZ_PARTS:
                dump = await page.evaluate(DUMP_SUBTREE_JS, [selector])
                report += [f"--- {selector} ---",
                           _render_subtree(dump[selector]) if dump[selector] else "  (没有这个元素)"]
            report += ["", f"拦截统计: 进度上报={guard.blocked_requests}", ""]
            print("\n".join(report))
            logger.info("弹题检查完成, 未作答也未上报进度.", shift=True)
            return 0
        finally:
            await session.close()
