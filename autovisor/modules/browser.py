from dataclasses import dataclass
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlparse

from playwright.async_api import Browser, BrowserContext, Page, Playwright
from playwright._impl._errors import TargetClosedError


@dataclass
class BrowserSession:
    browser: Browser
    context: BrowserContext
    page: Page
    attached: bool

    async def close(self) -> None:
        """Close only resources owned by Autovisor."""
        try:
            if self.attached:
                if not self.page.is_closed():
                    await self.page.close()
                return
            await self.browser.close()
        except TargetClosedError:
            return
        except Exception as exc:
            if driver_gone(exc):
                return
            raise


def driver_gone(exc: BaseException) -> bool:
    """Playwright 的 node 驱动已经退出了.

    在真实控制台里按 Ctrl+C, 这个信号同时发给了驱动, 它先走了; 之后再关浏览器、存 Cookie
    都只会报 "Connection closed while reading from the driver"(pc 在 Windows 上实测).
    驱动一走它起的浏览器也跟着结束, 没有要收的东西了, 不该当成未处理异常.
    """
    return "Connection closed while reading from the driver" in str(exc)


def get_effective_driver(config_driver: str) -> str:
    return str(config_driver).strip().lower()


def resolve_browser_channel(driver: str) -> str | None:
    if driver == "edge":
        return "msedge"
    if driver == "chromium":
        return None
    return driver


def resolve_executable_path(driver: str, configured_path: str) -> str | None:
    path = configured_path.strip().strip("\"'")
    if not path or driver == "chromium":
        return None
    if path.endswith(".app"):
        app_name = Path(path).stem
        return str(Path(path) / "Contents" / "MacOS" / app_name)
    return path


def resolve_cdp_endpoint(
    configured_url: str,
    active_port_path: Path | None = None,
) -> str:
    configured_url = configured_url.strip()
    # 默认端口和学习通 (9222)、雨课堂 (9223) 的专用浏览器错开, 三个工具才能同时跑
    default_url = "http://127.0.0.1:9224"
    if configured_url and configured_url != default_url:
        return configured_url

    if active_port_path is None and sys.platform == "darwin":
        active_port_path = (
            Path.home()
            / "Library"
            / "Application Support"
            / "Google"
            / "Chrome"
            / "DevToolsActivePort"
        )
    if active_port_path and active_port_path.is_file():
        lines = active_port_path.read_text(encoding="utf-8").splitlines()
        if len(lines) >= 2 and lines[0].isdigit() and lines[1].startswith("/devtools/browser/"):
            return f"ws://127.0.0.1:{lines[0]}{lines[1]}"
    return configured_url or default_url


def is_loopback_cdp_endpoint(endpoint: str) -> bool:
    host = (urlparse(endpoint).hostname or "").lower()
    return host in {"127.0.0.1", "localhost", "::1"}


def get_screen_size() -> tuple[int, int] | None:
    """只有 Windows 能直接拿到真实屏幕尺寸; 其它平台返回 None, 交给最大化处理。

    以前非 Windows 一律返回 1920x1080, 在 1440x900 的 MacBook 或 1366x768 的
    笔记本上窗口会超出屏幕。
    """
    if os.name == "nt":
        import ctypes

        user32 = ctypes.windll.user32
        return user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
    return None


def _window_args() -> list[str]:
    # --start-maximized 在 Windows / Linux 生效, macOS 上 Chrome 会忽略它,
    # 所以启动后还会再用 CDP 最大化一次(见 maximize_window)
    args = ["--start-maximized"]
    size = get_screen_size()
    if size:
        args += [f"--window-size={size[0]},{size[1]}", "--window-position=0,0"]
    return args


# Playwright 启动 Chromium 时默认会带 --enable-automation: 它让 navigator.webdriver
# 变成 true, 并在窗口顶部挂出"正受到自动测试软件的控制"。去掉它, 再关掉
# AutomationControlled 这个 Blink 特性, navigator.webdriver 就是真实浏览器里
# 那个原生的 false。
#
# 以前靠注入 stealth.min.js 抹掉这些痕迹, 实测(有界面的新版 Chrome)反而更显眼:
#   - 它把 webdriver 从 Navigator.prototype 上删掉, 于是 navigator.webdriver 是
#     undefined、'webdriver' in navigator 是 false; 真实浏览器里分别是 false 和 true
#   - navigator.languages / hardwareConcurrency 的 getter 不再是原生函数
#   - WebGL 厂商被写死成 "Intel Inc." / "Intel Iris OpenGL Engine"(Mac 的显卡串),
#     出现在 Windows / Linux 的 UA 下面
# 所以现在只改启动参数, 不再往页面里注入任何脚本。
AUTOMATION_DEFAULT_ARGS = ["--enable-automation"]
AUTOMATION_FLAGS = ["--disable-blink-features=AutomationControlled"]

# Edge 会拿 Windows 上登录的微软账号, 把这个临时 profile 也自动登录上(实测 Edge 155 /
# Win11; 因为带了 --disable-sync, 同步没打开)。msImplicitSignin 关掉这个自动登录。
EDGE_EXTRA_DISABLED_FEATURES = ["msImplicitSignin"]
# 页面上 Playwright 操作的默认超时(和 Playwright 自己的默认值一样)
DEFAULT_TIMEOUT_MS = 30_000


def playwright_disabled_features() -> list[str] | None:
    """读出 Playwright 自己带的那条 --disable-features 里的特性名.

    Chromium 只认最后一条 --disable-features(实测: 写两条时前一条整条作废), 而
    Playwright 自己已经带了一条(里面有 msForceBrowserSignIn 等)。再加一条只写
    msImplicitSignin, 就会把它那一串全部冲掉。所以要合并成一条, 列表从本机装的
    Playwright 里读, 跟着它的版本走。读不出来就返回 None, 调用方不加, 不冒险。
    """
    try:
        import playwright

        lib = Path(playwright.__file__).resolve().parent / "driver" / "package" / "lib"
        for path in (lib / "coreBundle.js", lib / "server" / "chromium" / "chromiumSwitches.js"):
            if not path.is_file():
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            match = re.search(r"disabledFeatures\s*=\s*(?:\([^)]*\)\s*=>\s*)?\[(.*?)\]", text, re.S)
            if match:
                features = re.findall(r'"([A-Za-z0-9_]+)"', match.group(1))
                if features:
                    return features
    except Exception:
        return None
    return None


def _edge_disabled_features_arg() -> str | None:
    base = playwright_disabled_features()
    if base is None:
        return None
    merged = list(dict.fromkeys([*base, *EDGE_EXTRA_DISABLED_FEATURES]))
    return "--disable-features=" + ",".join(merged)


def _launch_args(config) -> dict:
    driver = get_effective_driver(config.driver)
    channel = resolve_browser_channel(driver)
    executable_path = resolve_executable_path(driver, config.exe_path)
    args = {
        # 无头浏览器的特征面比自动化标志本身还大: UA 里直接带 HeadlessChrome,
        # WebGL 也会换成软件渲染。
        "headless": False,
        "ignore_default_args": list(AUTOMATION_DEFAULT_ARGS),
        "args": [*_window_args(), *AUTOMATION_FLAGS],
    }
    # soundOff 时在浏览器这一层静音。播放器上的静音要等视频出现、调节循环转到
    # 才点得上, 每节课开头会先外放一小段; Playwright 只在无头模式才默认带
    # --mute-audio, 有界面时得自己加。页面读不到这个开关: video 的 muted /
    # volume 都不变, 只是声音不送到声卡。连接现有 Chrome 时管不到启动参数。
    if getattr(config, "soundOff", False):
        args["args"].append("--mute-audio")
    if driver == "edge":
        disabled = _edge_disabled_features_arg()
        if disabled:
            args["args"].append(disabled)
    if executable_path:
        args["executable_path"] = executable_path
    elif channel:
        args["channel"] = channel
    return args


async def _launch_browser(playwright: Playwright, config, logger) -> Browser:
    launch_args = _launch_args(config)
    try:
        return await playwright.chromium.launch(**launch_args)
    except TargetClosedError as exc:
        logger.log_exception("首次启动浏览器失败,准备重试.", exc)
        return await playwright.chromium.launch(**launch_args)


async def create_browser_session(
    playwright: Playwright,
    config,
    cookies,
    logger,
) -> BrowserSession:
    if config.attach_existing_chrome:
        cdp_endpoint = resolve_cdp_endpoint(config.cdp_url)
        if not is_loopback_cdp_endpoint(cdp_endpoint):
            raise RuntimeError("为避免凭据泄露，CDP 端点只允许连接本机 loopback 地址")
        logger.info("正在连接现有 Chrome 的远程调试端点...")
        page = None
        try:
            browser = await playwright.chromium.connect_over_cdp(cdp_endpoint)
            if not browser.contexts:
                raise RuntimeError("Chrome CDP 连接成功,但没有可用浏览器上下文")
            context = browser.contexts[0]
            page = await context.new_page()
            attached = True
            logger.info("已连接现有 Chrome,将复用当前登录状态.")
            await _prepare_page(page, logger, owned=False)
            return BrowserSession(browser, context, page, attached)
        except BaseException as exc:
            if page is not None and not page.is_closed():
                try:
                    await page.close()
                except TargetClosedError:
                    pass
            if not isinstance(exc, Exception) or isinstance(exc, RuntimeError):
                raise
            raise RuntimeError(
                "无法连接现有 Chrome; 请启用 chrome://inspect/#remote-debugging, "
                "或将 attachExistingChrome 设为 False"
            ) from exc
    else:
        logger.info(f"正在启动 {config.driver} 浏览器...")
        launch_args = _launch_args(config)
        logger.event(
            "启动浏览器",
            驱动=config.driver,
            通道=launch_args.get("channel") or "chromium",
            可执行文件=launch_args.get("executable_path") or "默认",
        )
        browser = await _launch_browser(playwright, config, logger)
        logger.event("浏览器已启动", 版本=getattr(browser, "version", "未知"))
        try:
            # 视口必须跟随真实窗口。Python 版 Playwright 里 viewport=None 等于
            # 没传, 仍会把视口和 screen 一起模拟成 1280x720——实测会出现
            # innerWidth(1280) 大于 outerWidth(1050) 这种真实浏览器里不可能的组合,
            # screen 也不是真实屏幕。要关掉模拟只能用 no_viewport=True。
            context = await browser.new_context(no_viewport=True)
            if cookies:
                await context.add_cookies(cookies)
                logger.info("已加载 Cookies!")
            else:
                logger.info("未找到 Cookies,将跳转至登录页.")
            page = await context.new_page()
            await _prepare_page(page, logger, owned=True)
            return BrowserSession(browser, context, page, False)
        except BaseException:
            try:
                await browser.close()
            except TargetClosedError:
                pass
            raise


# 焦点与生命周期。窗口失焦、被遮挡时, 页面会收到 blur / focusout, 很多播放器
# 据此暂停视频。这几条 CDP 命令让页面在浏览器层面一直处于"前台、活跃"状态:
#   - setFocusEmulationEnabled: document.hasFocus() 恒为 true, 失焦不派发 blur。
#     Playwright 自己初始化每个页面时就会发这一条(实测改动前同样不触发 blur),
#     这里再显式发一次, 不依赖 Playwright 的默认行为
#   - setWebLifecycleState('active'): 不让标签页进入冻结状态(Playwright 不发)
#   - setIdleOverride: Idle Detection API 恒为"用户活跃、屏幕未锁"(Playwright 不发)
# document.visibilityState 没有对应的 override, 窗口最小化仍会变成 hidden。
# Windows 上窗口被完全盖住也会变 hidden, 视频直接暂停(实测 Chrome 155 / Win11)。
# Playwright 启动浏览器时默认带的 --disable-backgrounding-occluded-windows 兜住了这一条,
# 所以别把它加进 ignore_default_args; 连接已有 Chrome 时只能靠用户自己带。
FOCUS_STEPS = (
    ("焦点模拟", "Emulation.setFocusEmulationEnabled", {"enabled": True}),
    ("阻止标签页冻结", "Page.setWebLifecycleState", {"state": "active"}),
    ("空闲检测恒为活跃", "Emulation.setIdleOverride", {"isUserActive": True, "isScreenUnlocked": True}),
)


async def harden_focus(page: Page, logger) -> list[str]:
    """尽量启用 FOCUS_STEPS, 返回实际生效的项。旧版浏览器缺某个命令不影响其余项。"""
    try:
        session = await page.context.new_cdp_session(page)
    except Exception as exc:
        logger.debug(f"无法建立 CDP 会话, 跳过焦点模拟: {logger.summarize_exception(exc)}")
        return []
    applied = []
    for name, method, params in FOCUS_STEPS:
        try:
            await session.send(method, params)
            applied.append(name)
        except Exception as exc:
            logger.debug(f"{method} 不可用: {logger.summarize_exception(exc)}")
    return applied


async def maximize_window(page: Page, logger) -> bool:
    """用 CDP 把窗口最大化, 三个平台行为一致。"""
    try:
        session = await page.context.new_cdp_session(page)
        window = await session.send("Browser.getWindowForTarget")
        await session.send(
            "Browser.setWindowBounds",
            {"windowId": window["windowId"], "bounds": {"windowState": "maximized"}},
        )
        return True
    except Exception as exc:
        logger.debug(f"窗口最大化跳过: {logger.summarize_exception(exc)}")
        return False


async def _prepare_page(page: Page, logger, *, owned: bool) -> None:
    applied = await harden_focus(page, logger)
    logger.event("焦点模拟", 已启用=", ".join(applied) if applied else "无")
    # 连接到用户自己的 Chrome 时不动窗口——那是用户的窗口
    if owned:
        await maximize_window(page, logger)
    # 以前是 24 小时。第一节课开始后 run_course 会改成 10 秒, 所以 24 小时只管
    # "打开浏览器到第一节课"这一段, 而这一段里元素一消失就整个卡住(真实页面上遇到过)。
    # 要久等的地方(等登录、等课程目录、等视频)都自己写了超时。
    page.set_default_timeout(DEFAULT_TIMEOUT_MS)
