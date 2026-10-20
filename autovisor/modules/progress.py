# encoding=utf-8
import random
import sys
from playwright.async_api import Page, TimeoutError
from modules.lesson_navigation import (
    CatalogSelectors,
    lesson_progress,
    parse_progress_value,
)
from modules.logger import Logger

logger = Logger()

# 进度条靠 \r 在同一行刷新, 这在终端里没问题; 但输出被重定向到文件或管道时
# \r 不会覆盖任何东西, 一次下载能刷出几 MB 的日志(实测 8.3MB)。
# 非终端环境下改成每满 10% 落一行。
_PROGRESS_STEP = 10
_last_step: dict[str, int] = {}


def _is_terminal() -> bool:
    try:
        return bool(sys.stdout.isatty())
    except Exception:
        return False


def _emit(desc: str, line: str, percent: int) -> None:
    if _is_terminal():
        print(f"\r{line}".ljust(50), end="", flush=True)
        return
    # 同一个十分位只落一行; 100% 单独算一档, 保证收尾那条一定打出来
    step = 10 if percent >= 100 else percent // _PROGRESS_STEP
    if _last_step.get(desc) == step:
        return
    _last_step[desc] = step
    print(line.strip(), flush=True)


# 视频区域内移动鼠标
async def move_mouse(page: Page):
    try:
        await page.wait_for_selector(".videoArea", state="attached", timeout=5000)
        elem = page.locator(".videoArea")
        await elem.hover(timeout=4000)
        pos = await elem.bounding_box()
        if not pos:
            return
        # Calculate the target position to move the mouse
        target_x = pos['x'] + random.uniform(-10, 10)
        target_y = pos['y'] + random.uniform(-10, 10)
        await page.mouse.move(target_x, target_y)
    except TimeoutError:
        return


# 获取课程进度
async def get_course_progress(page: Page, catalog: CatalogSelectors) -> str:
    await move_mouse(page)
    current_lesson = page.locator(catalog.active).first
    if await current_lesson.count() == 0:
        return "0%"
    return f"{await lesson_progress(current_lesson, catalog)}%"


# 打印课程播放进度
def show_course_progress(desc, cur_time=None, limit_time=0):
    assert limit_time >= 0, "limit_time 必须为非负数!"
    if limit_time == 0:
        cur_time = "0%" if cur_time == '' or cur_time is None else cur_time
        percent = parse_progress_value(str(cur_time).rstrip("%"))
        length = int(percent * 30 // 100)
        progress = ("█" * length).ljust(30, " ")
        _emit(desc, f"{desc} |{progress}| {percent}%\t", percent)
    else:
        cur_time = 0 if cur_time == '' or cur_time is None else cur_time
        if isinstance(cur_time, str):
            cur_time = 0
        left_time = round(limit_time - cur_time, 1)
        percent = int(cur_time / limit_time * 100)
        if left_time <= 0:
            percent = 100
        percent = max(0, min(percent, 100))
        length = int(percent * 20 // 100)
        progress = ("█" * length).ljust(20, " ")
        _emit(desc, f"{desc} |{progress}| {percent}%\t剩余 {left_time} min\t", percent)


# 打印通用版进度条
def show_progress(desc, current, total, suffix="", width=30):
    if total <= 0:
        _emit(desc, f"{desc} 已下载 {current} bytes\t{suffix}", 0)
        return
    percent = 100 if current >= total else int(current / total * 100)
    length = int(percent * width // 100)
    progress = ("█" * length).ljust(width, " ")
    _emit(desc, f"{desc} |{progress}| {percent}%\t{suffix}", percent)
