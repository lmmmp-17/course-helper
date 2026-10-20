"""标准输出编码兜底。

Windows 上标准输出被重定向(写文件、管道、CI)时, Python 用的是系统区域编码。
非中文区域是 cp1252, 一打印中文就抛 UnicodeEncodeError, 整个程序随之退出。
中文系统(GBK)和交互式控制台(Python 3.6+ 在 Windows 控制台上走 UTF-8)不受影响,
所以只在当前编码确实写不出中文时才改用 UTF-8, 不去动本来正常的环境。
"""
import sys

_PROBE = "智慧树"


def ensure_cjk_safe_stdio(streams=None) -> None:
    for stream in streams if streams is not None else (sys.stdout, sys.stderr):
        # pythonw / 无控制台的打包程序里 stdout 可能是 None
        encoding = getattr(stream, "encoding", None)
        if not encoding or not hasattr(stream, "reconfigure"):
            continue
        try:
            _PROBE.encode(encoding)
        except (UnicodeEncodeError, LookupError):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                pass
