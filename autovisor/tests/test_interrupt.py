import tempfile
import unittest
from pathlib import Path
from unittest import mock

import Autovisor

ROOT = Path(__file__).resolve().parent.parent


class InterruptTests(unittest.TestCase):
    def test_ctrl_c_ends_quietly_with_130(self):
        # 在启动器里点「停止」或者按 Ctrl+C: 以前会甩出一整串 asyncio 的
        # KeyboardInterrupt 堆栈, 界面上看着像出错了
        with tempfile.TemporaryDirectory() as root:
            config = Path(root) / "config.ini"
            template = (ROOT / "config.linux.ini.example").read_text(encoding="utf-8")
            config.write_text(
                template.replace("URL1 =", "URL1 = https://studyvideoh5.zhihuishu.com/stuStudy?x=1", 1),
                encoding="utf-8",
            )

            def interrupted(coro):
                coro.close()
                raise KeyboardInterrupt

            with mock.patch("sys.argv", ["Autovisor.py", "--config", str(config)]), \
                    mock.patch.object(Autovisor, "print_banner"), \
                    mock.patch.object(Autovisor.updater, "check_for_update"), \
                    mock.patch.object(Autovisor, "Logger") as make_logger, \
                    mock.patch.object(Autovisor.asyncio, "run", side_effect=interrupted):
                self.assertEqual(Autovisor.cli(), 130)
            logger = make_logger.return_value
            logger.info.assert_any_call("已停止.", shift=True)
            logger.log_exception.assert_not_called()
            logger.save.assert_called_once()
