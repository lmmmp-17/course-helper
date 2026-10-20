"""随机化原语。

脚本感很大一部分来自节拍: 每 2 秒整查一次播放器、每次点击后恰好等 1 秒。
这里的等待都以基准值为中心抖动, 并留一条长尾——真人的间隔不会整齐落在
同一个区间里。
"""
import asyncio
import math
import random

_rng = random.SystemRandom()


def uniform(low: float, high: float) -> float:
    return _rng.uniform(low, high)


def chance(probability: float) -> bool:
    return _rng.random() < probability


def pick(items):
    """从序列里随机取一个。"""
    return _rng.choice(list(items))


def sample(items, count: int):
    """从序列里不重复地取 count 个。"""
    return _rng.sample(list(items), count)


def gauss_within(low: float, high: float) -> float:
    """在 [low, high] 内取一个靠中间的值(截断正态)。"""
    mid = (low + high) / 2
    value = _rng.gauss(mid, (high - low) / 6)
    return min(high, max(low, value))


# 停顿时长的离散度。本地靶场实测: 真人连续操作的间隔变异系数(标准差/均值)
# 是 0.45~0.49, 而「区间内均匀取值」只有 0.17~0.28——同样是随机, 但分布形状
# 和真人不是一回事。真人的停顿是「多数偏短、偶尔拖很久」, 正是对数正态的形状。
# 对数正态的变异系数 = sqrt(e^(σ²) − 1), σ=0.45 时约 0.47。
DISPERSION = 0.45


def lognormal(median: float, sigma: float = DISPERSION) -> float:
    """以 median 为中位数的对数正态取样。"""
    return median * math.exp(_rng.gauss(0, sigma))


def jitter(base: float, spread: float = DISPERSION) -> float:
    """以 base 为中位数抖动; 封顶只为挡极端值, 不是为了收窄分布。"""
    return min(base * 3, max(base * 0.4, lognormal(base, spread)))


async def sleep(base: float, spread: float = DISPERSION) -> None:
    """以 base 秒为中位数抖动的等待。"""
    await asyncio.sleep(jitter(base, spread))


async def sleep_between(low: float, high: float) -> None:
    """[low, high] 是常见区间: 取中点作中位数, 下限仍是 low, 上限留长尾。"""
    await asyncio.sleep(min(high * 3, max(low, lognormal((low + high) / 2))))
