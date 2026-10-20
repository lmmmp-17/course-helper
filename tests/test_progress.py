"""进度条在非终端环境下的输出量。

\r 刷新只在终端里有效; 输出被重定向到文件或管道时 \r 不覆盖任何东西,
一次下载实测刷出 8.3MB 日志。非终端环境改成每满 10% 落一行。
"""
import contextlib
import io
import unittest
from unittest import mock

from modules import progress


class FileFriendlyProgressTests(unittest.TestCase):
    def setUp(self):
        progress._last_step.clear()

    def _render(self, terminal):
        buffer = io.StringIO()
        with mock.patch.object(progress, "_is_terminal", lambda: terminal), \
             contextlib.redirect_stdout(buffer):
            total = 8_300_000
            for current in range(0, total + 1, 8192):
                progress.show_progress("下载进度:", current=current, total=total)
            progress.show_progress("下载进度:", current=total, total=total)
        return buffer.getvalue()

    def test_non_terminal_output_is_one_line_per_ten_percent(self):
        lines = [line for line in self._render(terminal=False).splitlines() if line]
        self.assertEqual(len(lines), 11, f"应当是 0%~100% 共 11 行, 实际 {len(lines)}")
        self.assertIn("100%", lines[-1], "收尾那条必须打出来")
        self.assertLess(len(self._render(terminal=False)), 2000)

    def test_terminal_still_repaints_in_place(self):
        output = self._render(terminal=True)
        self.assertIn("\r", output)
        self.assertNotIn("\n", output, "终端里应当就地刷新, 不往下滚")
