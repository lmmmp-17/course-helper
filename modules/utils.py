import json
import os
import os.path
import secrets
import sys
import tempfile
from playwright.async_api import Page, Locator
from playwright.async_api import TimeoutError
from playwright._impl._errors import TargetClosedError
from modules.configs import Config
from modules.pointer import human_click
from modules.lesson_navigation import (
    CatalogSelectors,
    get_lesson_title,
    lesson_is_complete,
)
import time
from modules.logger import Logger

if sys.platform == "win32":
    import ctypes
    import pygetwindow as gw
    from pygetwindow import Win32Window
else:
    ctypes = None
    gw = None
    Win32Window = object

logger = Logger()

# 可选元素(弹窗等)的等待上限: 这类元素只在特定条件下出现, 不存在时必须尽快跳过。
# 打包版把页面默认超时设为 24 小时, 沿用默认值会让整轮学习一直卡在原地。
# 实测可见弹窗约 4s 出现, 放宽到 20s 以容忍慢网与首屏渲染; 隐藏节点每门课
# 最多多等这一次, 相对整门课的学习时长可以忽略。
OPTIONAL_POPUP_TIMEOUT_MS = 20_000


def get_runtime_root():
    return logger.runtime_root


def get_runtime_path(*parts):
    return os.path.join(get_runtime_root(), *parts)

def save_cookies(cookies, filename="cookies.json"):
    """保存登录Cookies到文件"""
    filename = os.fspath(filename)
    directory = os.path.dirname(os.path.abspath(filename))
    fd, temp_path = tempfile.mkstemp(prefix=".cookies-", dir=directory)
    try:
        if os.name != "nt":
            os.chmod(temp_path, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            json.dump(cookies, file)
        os.replace(temp_path, filename)
        if os.name != "nt":
            os.chmod(filename, 0o600)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        if os.path.exists(temp_path):
            os.remove(temp_path)
        raise

def load_cookies(filename="cookies.json"):
    """从文件加载 Cookies"""
    try:
        with open(filename, 'r', encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except json.JSONDecodeError:
        return None


def normalize_zhihuishu_cookies(cookies, now=None):
    now = time.time() if now is None else now
    normalized = []
    for cookie in cookies:
        domain = str(cookie.get("domain") or "").strip()
        normalized_domain = domain.lstrip(".").lower()
        name = str(cookie.get("name") or "").strip()
        valid_domain = normalized_domain == "zhihuishu.com" or normalized_domain.endswith(
            ".zhihuishu.com"
        )
        if not name or not valid_domain:
            continue
        expires = cookie.get("expires", cookie.get("expirationDate"))
        if isinstance(expires, (int, float)) and expires > 0 and expires <= now:
            continue
        item = {
            "name": name,
            "value": str(cookie.get("value") or ""),
            "domain": domain,
            "path": cookie.get("path") or "/",
            "secure": bool(cookie.get("secure", False)),
        }
        if isinstance(expires, (int, float)) and expires > now:
            item["expires"] = float(expires)
        rest = cookie.get("rest") or {}
        if rest.get("HttpOnly") is True or cookie.get("httpOnly") is True:
            item["httpOnly"] = True
        same_site = rest.get("SameSite") or cookie.get("sameSite")
        if same_site in {"Strict", "Lax", "None"}:
            item["sameSite"] = same_site
        normalized.append(item)
    return normalized


def import_zhihuishu_cookies(source, destination="cookies.json") -> int:
    with open(source, "r", encoding="utf-8") as file:
        raw = json.load(file)
    if not isinstance(raw, list):
        raise ValueError("Cookie 文件必须是列表格式")
    cookies = normalize_zhihuishu_cookies(raw)
    if not cookies:
        raise ValueError("Cookie 文件中没有可用的智慧树 Cookie")
    save_cookies(cookies, destination)
    return len(cookies)


def clear_cookies(filename="cookies.json"):
    if os.path.exists(filename):
        os.remove(filename)

# 将python终端前置
def bring_console_to_front():
    if sys.platform != "win32":
        return False
    # 获取当前控制台窗口句柄
    hwnd = ctypes.windll.kernel32.GetConsoleWindow()
    if hwnd:
        ctypes.windll.user32.ShowWindow(hwnd, 5)  # SW_SHOW
        ctypes.windll.user32.SetForegroundWindow(hwnd)
        return True
    return False


async def display_window(page: Page) -> None:
    if sys.platform != "win32":
        await page.bring_to_front()
        logger.info("播放标签页已前置.", shift=True)
        return
    window = await get_browser_window(page)
    if window:
        window.show()
        window.restore()
        window.moveTo(100, 100)
        logger.info("播放窗口已自动前置.", shift=True)
    else:
        logger.warn("未找到播放窗口!")


def platform_name() -> str:
    return {"win32": "Windows", "darwin": "macOS"}.get(sys.platform, "Linux")


async def hide_window(page: Page) -> None:
    if sys.platform != "win32":
        # 不用最小化代替隐藏: 最小化后 document.visibilityState 变成 hidden,
        # 播放器会据此暂停。焦点模拟已经让失焦不触发 blur, 把窗口放到其它
        # 窗口后面、或挪到另一个工作区就够了。
        logger.warn(
            f"{platform_name()} 不支持隐藏单个浏览器窗口. 可以把窗口放到其它窗口后面"
            "或挪到另一个工作区, 失焦不会打断播放; 不要最小化."
        )
        return
    window = await get_browser_window(page)
    if window:
        window.hide()
        logger.info("播放窗口已自动隐藏,将在需要安全验证时显示.")
    else:
        logger.warn("未找到播放窗口!")


async def get_browser_window(page: Page, windows=None) -> object | None:
    """按标题找到播放页所在的系统窗口。

    以前会把页面标题直接改成 "Autovisor - Playwright" 再去匹配——页面脚本读
    document.title 就能看到工具名, MutationObserver 也能看到 <title> 被改。
    现在先用页面自己的标题匹配, 只有匹配不唯一(比如用户另开了同一个课程页)
    时才临时换成随机串定位, 定位完立刻改回原标题。
    """
    if sys.platform != "win32" and windows is None:
        return None
    windows = windows or gw
    await page.wait_for_load_state("domcontentloaded")
    original = await page.title()
    if original:
        matches = windows.getWindowsWithTitle(original)
        if len(matches) == 1:
            return matches[0]

    token = f"av-{secrets.token_hex(6)}"
    await page.evaluate("t => { document.title = t; }", token)
    try:
        await page.wait_for_timeout(1000)
        matches = windows.getWindowsWithTitle(token)
        return matches[0] if matches else None
    finally:
        await page.evaluate("t => { document.title = t; }", original)


async def evaluate_js(page: Page, wait_selector, js: str, timeout=None, is_hike_class=False) -> None:
    """等待可选元素(如弹窗)后执行页面脚本; 元素未出现时跳过, 不无期限等待。"""
    if timeout is None:
        timeout = OPTIONAL_POPUP_TIMEOUT_MS
    try:
        if wait_selector and is_hike_class is False:
            await page.wait_for_selector(wait_selector, timeout=timeout)
        if is_hike_class is False:
            await page.evaluate(js)
    except TargetClosedError as e:
        logger.debug(f"浏览器关闭时停止执行页面脚本: {logger.summarize_exception(e)}")
        return
    except TimeoutError:
        # 弹窗等可选元素未出现属于正常情况: 记节流日志即可, 不能当成异常
        logger.debug_throttled(
            f"evaluate_js:{wait_selector}",
            f"页面脚本跳过: 等待元素超时 {wait_selector}",
        )
        return
    except Exception as e:
        logger.log_exception(f"执行页面脚本失败. Selector: {wait_selector} JS: {js}", e)
        return


async def evaluate_on_element(page: Page, selector: str, js: str, timeout: float = None,
                              is_hike_class=False) -> None:
    """在可选元素上执行脚本; 元素未出现时跳过, 不无期限等待。"""
    if timeout is None:
        timeout = OPTIONAL_POPUP_TIMEOUT_MS
    try:
        if selector and is_hike_class is False:
            element = page.locator(selector).first
            await element.evaluate(js, timeout=timeout)
    except TargetClosedError as e:
        logger.debug(f"浏览器关闭时停止执行元素脚本: {logger.summarize_exception(e)}")
        return
    except TimeoutError:
        logger.debug_throttled(
            f"evaluate_on_element:{selector}",
            f"元素脚本跳过: 等待元素超时 {selector}",
        )
        return
    except Exception as e:
        logger.log_exception(f"执行元素脚本失败. Selector: {selector} JS: {js}", e)
        return


async def click_optional(
    page: Page, wait_selector: str | None, click_selector: str, timeout: float
) -> bool:
    """可选元素(弹窗等)出现时用真实输入点一下, 没出现就在 timeout 内跳过。

    以前在页面里执行 el.click(): 那样派发的事件 isTrusted 恒为 false, 页面只要
    写一行 if (!e.isTrusted) return 就能把它挡掉, 也能据此认出脚本。
    """
    try:
        if wait_selector:
            await page.wait_for_selector(wait_selector, timeout=timeout)
        target = page.locator(f"{click_selector}:visible").first
        await human_click(target, timeout=timeout)
        return True
    except TargetClosedError as e:
        logger.debug(f"浏览器关闭时停止点击: {logger.summarize_exception(e)}")
        return False
    except TimeoutError:
        logger.debug_throttled(
            f"click_optional:{click_selector}",
            f"可选点击跳过: 等待元素超时 {wait_selector or click_selector}",
        )
        return False
    except Exception as e:
        logger.log_exception(f"可选点击失败. Selector: {click_selector}", e)
        return False


async def optimize_page(
    page: Page, config: Config, catalog: CatalogSelectors
) -> None:
    try:
        preread_close = page.locator(
            ".ss2077-custom-modal .ss2077-custom-dialog:visible "
            ".ss2077-custom-title > img.icon"
        ).first
        if await preread_close.count() and await preread_close.is_visible():
            await human_click(preread_close, timeout=2000)
            logger.info("已关闭学前必读弹窗.")

        if catalog.name == "legacy":
            # "学习时长/学前必读"弹窗(.studytime-div)只在未读过时显示: 节点常驻 DOM,
            # 平台不提示时它是 0x0 的隐藏节点, 等它可见会一直等下去。
            await click_optional(
                page,
                ".studytime-div",
                ".iconfont.iconguanbi",
                timeout=OPTIONAL_POPUP_TIMEOUT_MS,
            )
            hour = time.localtime().tm_hour
            if hour >= 18 or hour < 7:
                await click_optional(page, None, ".Patternbtn-div", timeout=1500)
            await evaluate_on_element(page, ".exploreTip", "el=>el.remove()", timeout=1500)
            await evaluate_on_element(page, ".ai-helper-Index2", "el=>el.remove()", timeout=1500)
            await evaluate_on_element(page, ".aiMsg.once", "el=>el.remove()", timeout=1500)

    except TargetClosedError as e:
        logger.debug(f"浏览器关闭时停止页面优化: {logger.summarize_exception(e)}")
        return
    except Exception as e:
        logger.log_exception("页面优化失败.", e)
        return


async def get_video_attr(page, attr: str) -> any:
    try:
        await page.wait_for_selector("video", state="attached", timeout=1000)
    except TimeoutError:
        # 视频元素尚未挂载属于轮询常态, 不能每次打印完整堆栈
        logger.debug_throttled(
            f"video_attr:{attr}",
            f"读取视频属性超时,视频元素未就绪: {attr}",
        )
        return None
    except TargetClosedError as e:
        logger.debug(f"浏览器关闭时停止读取视频属性 {attr}: {logger.summarize_exception(e)}")
        return None
    return await run_on(page, "video", f"(el) => el[{attr!r}]", f"读取视频属性 {attr}")


# 元素不存在时由页面脚本返回的哨兵值
_MISSING = "__autovisor_missing__"


async def run_on(page, selector: str, action: str, purpose: str):
    """在匹配 selector 的元素上执行 action(el)。

    元素不存在时返回 None 并记一条带选择器的节流日志; 脚本报错同样返回 None,
    但会把选择器与用途写进异常日志, 便于定位是哪个元素/类名出的问题。
    """
    script = (
        "() => {"
        f" const el = document.querySelector({selector!r});"
        f" if (!el) return {_MISSING!r};"
        f" return ({action})(el);"
        " }"
    )
    try:
        result = await page.evaluate(script)
    except TargetClosedError:
        raise
    except Exception as exc:
        logger.log_exception(f"{purpose}失败(选择器: {selector}).", exc)
        return None
    if result == _MISSING:
        logger.debug_throttled(
            f"run_on:{selector}",
            f"{purpose}跳过: 页面未找到元素 {selector}",
        )
        return None
    return result


async def get_lesson_name(
    page: Page, lesson: Locator, catalog: CatalogSelectors
) -> str:
    return await get_lesson_title(page, lesson, catalog)


async def get_filtered_class(
    page: Page, catalog: CatalogSelectors, include_all=False
) -> list[Locator]:
    try:
        await page.wait_for_selector(catalog.item, timeout=2000)
    except TimeoutError:
        pass

    all_class = await page.locator(catalog.item).all()
    if include_all:
        logger.debug(f"Get to-review class: {len(all_class)}")
        return all_class

    to_learn_class = []
    for each in all_class:
        if not await lesson_is_complete(each, catalog):
            to_learn_class.append(each)
    logger.debug(f"Get to-learn class: {len(to_learn_class)} / {len(all_class)}")
    return to_learn_class
