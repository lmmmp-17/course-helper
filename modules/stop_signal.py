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


def _interrupt_main_thread() -> None:
    """当成主线程收到了 Ctrl+C.

    asyncio.run 会先取消主任务、让 finally 跑完(Playwright 关浏览器、删临时目录),
    再抛 KeyboardInterrupt。关键是要把正在 select 里等着的事件循环叫醒:
    - _thread.interrupt_main() 只是记一笔, 不叫醒, 实测要等循环自己醒来(那次等了 30 秒);
    - POSIX: asyncio.run 不挂唤醒 fd, 从这个线程 raise 的信号也只落在这个线程。
      pthread_kill 直接发给主线程, 打断它的 epoll 等待, 和真按了 Ctrl+C 一样;
    - Windows: 没有 pthread_kill, 也不能 os.kill(SIGINT)(那等于强杀)。Proactor 事件循环
      在主线程里挂了唤醒 fd, raise_signal 走 C 层信号处理时会写它, 循环当场醒。
    """
    if hasattr(signal, "pthread_kill"):
        signal.pthread_kill(threading.main_thread().ident, signal.SIGINT)
    else:
        signal.raise_signal(signal.SIGINT)


def watch_stdin_for_stop(stream=None, interrupt=None) -> threading.Thread:
    """在后台线程里读 stdin, 读到结尾就中断主线程."""
    if stream is None:
        stream = sys.stdin.buffer
    if interrupt is None:
        interrupt = _interrupt_main_thread

    def watch():
        try:
            while stream.read(4096):
                pass
        except (OSError, ValueError):
            pass
        interrupt()

    thread = threading.Thread(target=watch, name="launcher-stop", daemon=True)
    thread.start()
    return thread
