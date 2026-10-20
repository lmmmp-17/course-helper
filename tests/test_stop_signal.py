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
