import io
import unittest

from modules.console import ensure_cjk_safe_stdio


def _stream(encoding):
    return io.TextIOWrapper(io.BytesIO(), encoding=encoding)


class StdioEncodingTests(unittest.TestCase):
    def test_switches_streams_that_cannot_write_chinese(self):
        # 英文区域 Windows 重定向输出时就是 cp1252: 打印中文会直接抛异常
        stream = _stream("cp1252")
        with self.assertRaises(UnicodeEncodeError):
            stream.write("智慧树")
        ensure_cjk_safe_stdio([stream])
        self.assertEqual(stream.encoding, "utf-8")
        stream.write("智慧树")

    def test_leaves_chinese_capable_streams_alone(self):
        for encoding in ("gbk", "utf-8"):
            stream = _stream(encoding)
            ensure_cjk_safe_stdio([stream])
            self.assertEqual(stream.encoding, encoding)

    def test_tolerates_missing_streams(self):
        ensure_cjk_safe_stdio([None])


if __name__ == "__main__":
    unittest.main()
