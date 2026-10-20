# encoding=utf-8
"""统一启动器的停止信号.

从启动器启动时(环境变量 COURSE_UI=1), stdin 是启动器给的管道。启动器把管道
关掉, 就是让程序停下来: 和按 Ctrl+C 走同一条收尾路径(KeyboardInterrupt ->
"已停止."), Playwright 会正常关掉浏览器并删掉它的临时目录。

Windows 上启动器没法给子进程发 Ctrl+C(中间还隔着 cmd.exe 和 uv), 以前只能
强杀整棵进程树: 浏览器来不及关, %TEMP% 里每停一次就留下一个
playwright_chromiumdev_profile-* 目录(实测)。
"""
import signal
import sys
import threading
import time

ERROR_BROKEN_PIPE = 109
ERROR_NO_DATA = 232  # 管道正在关闭


def _interrupt_main_thread() -> None:
    """当成主线程收到了 Ctrl+C.

    asyncio.run 会先取消主任务、让 finally 跑完(Playwright 关浏览器、删临时目录),
    再抛 KeyboardInterrupt。关键是要把正在 select 里等着的事件循环叫醒:
    - _thread.interrupt_main() 只是记一笔, 不叫醒, 实测要等循环自己醒来(那次等了 30 秒);
    - POSIX: asyncio.run 不挂唤醒 fd, 从这个线程 raise 的信号也只落在这个线程。
      pthread_kill 直接发给主线程, 打断它的 epoll 等待, 和真按了 Ctrl+C 一样;
    - Windows: 没有 pthread_kill, 也不能 os.kill(SIGINT)(那等于强杀)。Proactor 事件循环
      在主线程里挂了唤醒 fd, raise_signal 走 C 层信号处理时会写它, 循环当场醒(pc 实测)。
    """
    if hasattr(signal, "pthread_kill"):
        signal.pthread_kill(threading.main_thread().ident, signal.SIGINT)
    else:
        signal.raise_signal(signal.SIGINT)


def _watch_by_reading(stream, interrupt) -> None:
    """POSIX: 阻塞读到结尾."""
    try:
        while stream.read(4096):
            pass
    except (OSError, ValueError):
        pass
    interrupt()


def _watch_by_polling(pipe_state, interrupt, interval: float) -> None:
    """Windows: 只查不读, 管道断了才中断.

    不能像 POSIX 那样阻塞读: Windows 的同步管道句柄上, 一个挂着的 ReadFile 会把同一个
    文件对象上的其它 I/O 都排在它后面。cv2 / numpy 的 DLL 初始化会去查标准句柄, 于是
    import cv2 一直卡到 stdin 关掉为止, Edge 永远起不来(pc 实测: 200ms 变成卡死)。
    pipe_state() 返回 'open' / 'closed' / 'unknown'(查不了, 就不再管了)。
    """
    while True:
        state = pipe_state()
        if state == "closed":
            interrupt()
            return
        if state != "open":
            return
        time.sleep(interval)


def _windows_stdin_pipe_state():
    """返回一个 pipe_state 函数; stdin 不是管道(控制台、文件)就返回 None, 不挂."""
    import ctypes
    import msvcrt
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    get_file_type = kernel32.GetFileType
    get_file_type.argtypes = [wintypes.HANDLE]
    get_file_type.restype = wintypes.DWORD
    peek = kernel32.PeekNamedPipe
    peek.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
                     wintypes.LPDWORD, wintypes.LPDWORD, wintypes.LPDWORD]
    peek.restype = wintypes.BOOL

    try:
        handle = msvcrt.get_osfhandle(sys.stdin.fileno())
    except (OSError, ValueError, AttributeError):
        return None
    FILE_TYPE_PIPE = 3
    if get_file_type(handle) != FILE_TYPE_PIPE:
        return None

    def state():
        available = wintypes.DWORD(0)
        if peek(handle, None, 0, None, ctypes.byref(available), None):
            return "open"
        error = ctypes.get_last_error()
        return "closed" if error in (ERROR_BROKEN_PIPE, ERROR_NO_DATA) else "unknown"

    return state


def watch_stdin_for_stop(stream=None, interrupt=None, *, pipe_state=None, interval: float = 0.2):
    """在后台线程里盯着 stdin, 管道关掉就中断主线程. 没法盯(不是管道)时返回 None."""
    if interrupt is None:
        interrupt = _interrupt_main_thread
    if pipe_state is None and stream is None and sys.platform == "win32":
        pipe_state = _windows_stdin_pipe_state()
        if pipe_state is None:
            return None
    if pipe_state is not None:
        target, args = _watch_by_polling, (pipe_state, interrupt, interval)
    else:
        target, args = _watch_by_reading, (stream if stream is not None else sys.stdin.buffer, interrupt)
    thread = threading.Thread(target=target, args=args, name="launcher-stop", daemon=True)
    thread.start()
    return thread
