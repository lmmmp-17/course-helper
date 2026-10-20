"""随机化原语的分布形状。

本地靶场实测: 真人连续操作的间隔变异系数(标准差/均值)是 0.45~0.49,
而「区间内均匀取值」只有 0.17~0.28。同样是随机, 分布形状不是一回事——
真人的停顿是「多数偏短、偶尔拖很久」。
"""
import statistics
import unittest

from modules import human

HUMAN_CV = (0.40, 0.55)


def _cv(values):
    mean = statistics.fmean(values)
    return statistics.stdev(values) / mean


class DispersionTests(unittest.TestCase):
    def test_jitter_dispersion_matches_measured_humans(self):
        cv = _cv([human.jitter(2.0) for _ in range(20000)])
        self.assertTrue(HUMAN_CV[0] < cv < HUMAN_CV[1], f"变异系数实际 {cv:.3f}")

    def test_lognormal_keeps_the_configured_value_as_median(self):
        values = sorted(human.lognormal(5.0) for _ in range(20001))
        self.assertAlmostEqual(values[10000], 5.0, delta=0.15)

    def test_explicit_spread_narrows_the_distribution(self):
        # 保活、冷却这类内部节拍不需要真人那么散
        self.assertLess(_cv([human.jitter(8.0, 0.2) for _ in range(20000)]), 0.3)

    def test_tail_is_long_but_bounded(self):
        values = [human.jitter(2.0) for _ in range(20000)]
        self.assertGreater(max(values), 2.0 * 1.8, "应当有偶尔拖很久的长尾")
        self.assertLessEqual(max(values), 2.0 * 3, "但不能无限长")
        self.assertGreaterEqual(min(values), 2.0 * 0.4)


if __name__ == "__main__":
    unittest.main()
