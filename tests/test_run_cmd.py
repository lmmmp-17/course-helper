"""Windows 入口 run.cmd 只能写 ASCII, 用户看到的中文放在 resources/run-messages.txt.

控制台是 UTF-8 时, cmd 会读错含多字节字符的批处理: 按行的位置把中文行截断,
后半截当成命令执行 (pc 在 Windows 11 上实测, 统一启动器的记录里也看得到).
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class RunCmdTest(unittest.TestCase):
    def test_run_cmd_is_ascii(self):
        text = (ROOT / "run.cmd").read_bytes()
        self.assertTrue(text.isascii(), "run.cmd 里不能有非 ASCII 字符")

    def test_install_uv_script_is_ascii(self):
        # Windows PowerShell 5.1 按 ANSI 代码页读不带 BOM 的脚本
        text = (ROOT / "resources" / "install-uv.ps1").read_bytes()
        self.assertTrue(text.isascii(), "install-uv.ps1 里不能有非 ASCII 字符")

    def test_mirror_downloads_send_a_user_agent(self):
        # 清华下载 wheel、阿里打开索引页, 不带 User-Agent 都是 403 (pc 在 Windows 上实测)
        self.assertIn("User-Agent", (ROOT / "resources" / "install-uv.ps1").read_text(encoding="ascii"))
        self.assertIn("User-Agent", (ROOT / "run.sh").read_text(encoding="utf-8"))

    def test_every_message_key_exists(self):
        cmd = (ROOT / "run.cmd").read_text(encoding="ascii")
        raw = (ROOT / "resources" / "run-messages.txt").read_bytes()
        self.assertFalse(raw.startswith(b"\xef\xbb\xbf"), "不能带 BOM, 不然第一行的键认不出来")
        keys = {line.split("=", 1)[0] for line in raw.decode("utf-8").splitlines() if re.match(r"^[\w-]+=", line)}
        used = re.findall(r"call :say ([\w-]+)", cmd)
        self.assertGreaterEqual(len(used), 5)
        for key in used:
            self.assertIn(key, keys, f"run-messages.txt 里缺 {key}")


if __name__ == "__main__":
    unittest.main()
