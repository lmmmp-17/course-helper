import contextlib
import io
import unittest

from modules.banner import print_banner


class BannerTest(unittest.TestCase):
    def test_terminal_gets_the_ascii_art(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            print_banner()
        self.assertIn("█", out.getvalue())
        self.assertIn("CXRunfree", out.getvalue())

    def test_launcher_gets_one_plain_line_with_the_credit(self):
        # 启动器的记录是比例字体, 字符画会散掉 (pc 实测)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            print_banner(plain=True)
        self.assertEqual(out.getvalue(), "Autovisor by Github CXRunfree\n")


if __name__ == "__main__":
    unittest.main()
