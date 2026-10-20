import os
import subprocess
import sys
import threading
import unittest
from pathlib import Path

from modules.stop_signal import watch_stdin_for_stop

ROOT = Path(__file__).resolve().parent.parent


class StopSignalTests(unittest.TestCase):
    def test_eof_interrupts_once(self):
        read_end, write_end = os.pipe()
        stream = os.fdopen(read_end, "rb")
        fired = threading.Event()
        calls = []

        def interrupt():
            calls.append(1)
            fired.set()

        thread = watch_stdin_for_stop(stream, interrupt)
        self.assertFalse(fired.wait(0.2), "管道还开着, 不该触发")
        os.write(write_end, "随便写点东西也不算停止".encode("utf-8"))
        self.assertFalse(fired.wait(0.2))
        os.close(write_end)
        self.assertTrue(fired.wait(2), "管道关掉后要触发")
        thread.join(2)
        self.assertEqual(calls, [1])
        stream.close()

    def test_real_process_ends_quietly_when_stdin_closes(self):
        # 真实子进程: 主线程在 asyncio 里等着, 关掉 stdin 后应当走 KeyboardInterrupt 收尾
        code = (
            "import asyncio, sys\n"
            "from modules.stop_signal import watch_stdin_for_stop\n"
            "watch_stdin_for_stop()\n"
            "async def main():\n"
            "    try:\n"
            "        print('就绪', flush=True)\n"
            "        await asyncio.sleep(30)\n"
            "    finally:\n"
            "        print('收尾', flush=True)\n"
            "try:\n"
            "    asyncio.run(main())\n"
            "except KeyboardInterrupt:\n"
            "    print('已停止', flush=True)\n"
            "    sys.exit(130)\n"
        )
        child = subprocess.Popen(
            [sys.executable, "-c", code], cwd=ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            env={**os.environ, "PYTHONUTF8": "1"},
        )
        self.assertEqual(child.stdout.readline().decode().strip(), "就绪")
        child.stdin.close()
        out, _ = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 130)
        self.assertEqual(out.decode().split(), ["收尾", "已停止"], "finally 要先跑完")


class WindowsPollingTests(unittest.TestCase):
    # Windows 上不能阻塞读 stdin: 挂着的 ReadFile 会挡住 import cv2(pc 实测卡死)。
    # 改成每隔一会儿查一次管道断了没有; 这里用假的查询函数测这条路径
    def test_polls_until_the_pipe_closes(self):
        states = iter(["open", "open", "closed"])
        fired = threading.Event()
        thread = watch_stdin_for_stop(pipe_state=lambda: next(states), interrupt=fired.set, interval=0.01)
        self.assertTrue(fired.wait(2))
        thread.join(2)

    def test_gives_up_quietly_when_the_pipe_cannot_be_queried(self):
        fired = threading.Event()
        thread = watch_stdin_for_stop(pipe_state=lambda: "unknown", interrupt=fired.set, interval=0.01)
        thread.join(2)
        self.assertFalse(fired.is_set(), "查不了不等于让停")

    @unittest.skipUnless(sys.platform == "win32", "Windows only")
    def test_console_stdin_is_not_watched(self):
        # 不是管道(控制台、文件)就不挂, 也不该误停
        from modules.stop_signal import _windows_stdin_pipe_state
        if not sys.stdin.isatty():
            self.skipTest("stdin 不是控制台")
        self.assertIsNone(_windows_stdin_pipe_state())
