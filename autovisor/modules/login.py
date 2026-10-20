from urllib.parse import urlparse

from playwright.async_api import Locator, Page

from modules import human
from modules.pointer import human_click


LOGIN_HOSTS = {"login.zhihuishu.com", "passport.zhihuishu.com"}
LOGIN_USERNAME_SELECTOR = "#lUsername, input[name='mobile']"
LOGIN_PASSWORD_SELECTOR = "#lPassword, input[type='password']"
LOGIN_SUBMIT_SELECTOR = ".wall-sub-btn, .btn-block__grandient_login, button[type='submit']"


def is_login_page(url: str) -> bool:
    """判断 URL 是否仍处于智慧树登录流程。"""
    hostname = (urlparse(url).hostname or "").lower()
    return hostname in LOGIN_HOSTS


async def wait_for_login_complete(
    page: Page, timeout: float = 24 * 3600 * 1000
) -> None:
    """等待页面离开智慧树登录域名。"""
    if not is_login_page(page.url):
        return
    await page.wait_for_url(
        lambda url: not is_login_page(str(url)),
        wait_until="commit",
        timeout=timeout,
    )


async def accept_login_terms(page: Page) -> None:
    """新版登录页存在协议复选框时自动勾选。"""
    checkbox = page.locator("input.el-checkbox__original").first
    if not await checkbox.count():
        return

    if await checkbox.is_checked():
        return
    # Element UI 的原始 <input> 被隐藏了(opacity 0、宽高 0), 不能直接点。
    # 以前在页面里执行 element.click(), 派发的是 isTrusted 为 false 的事件;
    # 现在点它旁边那个可见的方框 .el-checkbox__inner, 由 <label> 把点击转给 input。
    # 不点 label 本身: label 里还有《用户协议》链接, 落点不巧会点开链接。
    box = checkbox.locator("xpath=preceding-sibling::*[contains(@class,'el-checkbox__inner')]").first
    try:
        if await box.count():
            await human_click(box, timeout=5000)
    except Exception:
        pass
    if not await checkbox.is_checked():
        # 页面结构对不上时退回旧做法, 保证登录流程不被卡住
        await checkbox.evaluate("element => element.click()")


async def type_like_human(field: Locator, text: str) -> None:
    """逐字输入, 每个字符都有真实的 keydown / keyup。

    fill() 是一次性把值写进去: 整段输入只有 input 事件、没有任何按键事件,
    这在登录框上非常显眼。
    """
    await human_click(field, timeout=30000)
    # macOS 上全选是 Command+A, ControlOrMeta 会按平台自动选对
    await field.press("ControlOrMeta+a")
    await field.press("Backspace")
    for char in text:
        await field.press_sequentially(char)
        await human.sleep_between(0.045, 0.21)
