/* ------------------------------------------------------------------
 * 随机化原语
 * 和浏览器内版本同一套思路：不写死毫秒数，所有等待、坐标、步数都从这里取。
 * 换到 Playwright 之后输入事件本身是可信的，但“节拍”依然是会被看出来的那一面——
 * 每 1000ms 整采一次进度、每节结束后恰好 1 秒点下一节，和合成事件一样显眼。
 * ------------------------------------------------------------------ */
import { randomInt, randomBytes } from 'node:crypto';

const unit = () => randomBytes(4).readUInt32BE(0) / 4294967296;

export const human = {
    float(min, max) {
        return min + unit() * (max - min);
    },
    int(min, max) {
        if (max <= min) return Math.round(min);
        return randomInt(Math.round(min), Math.round(max) + 1);
    },
    chance(probability) {
        return unit() < probability;
    },
    pick(list) {
        return list[this.int(0, list.length - 1)];
    },
    /* 停顿时长用对数正态取样。
     *
     * 以前是「区间内均匀取值」加 8% 概率的长尾。问题是离散度太小：本地靶场里
     * 实测真人连续操作的间隔变异系数(标准差/均值)是 0.45~0.49，而均匀取值只有
     * 0.17~0.28——同样是随机，分布形状和真人不是一回事。真人的停顿是「多数偏短、
     * 偶尔拖很久」，正是对数正态的形状。
     *
     * sigma 直接决定变异系数：CV = sqrt(e^(σ²) − 1)，σ=0.45 时约 0.47。 */
    DISPERSION: 0.45,
    lognormal(median, sigma) {
        return median * Math.exp(this.gauss() * sigma);
    },
    /* 以 base 为中位数取样；ratio 就是 sigma，不传用默认离散度 */
    spread(base, ratio) {
        const sigma = Number.isFinite(ratio) ? ratio : this.DISPERSION;
        /* 封顶只是防极端值（σ=0.45 时越界概率约 0.8%），不是为了收窄分布 */
        return Math.min(base * 3, Math.max(base * 0.4, this.lognormal(base, sigma)));
    },
    /* spec 既可以是毫秒数，也可以是 [min, max] 区间。
     * 区间形式取中点作中位数，下限仍是 min（不会比配置的还快），上限留长尾。 */
    ms(spec, ratio) {
        if (Array.isArray(spec)) {
            const [low, high] = spec;
            const sigma = Number.isFinite(ratio) ? ratio : this.DISPERSION;
            return Math.round(Math.min(high * 3, Math.max(low, this.lognormal((low + high) / 2, sigma))));
        }
        return Math.round(this.spread(Number(spec) || 0, ratio));
    },
    /* 标准正态，用来让落点集中在中心而不是均匀铺满整个元素 */
    gauss() {
        let u = 0;
        let v = 0;
        while (u === 0) u = unit();
        while (v === 0) v = unit();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    /* 在 [min, max] 内取一个靠中间的值 */
    centered(min, max) {
        const mid = (min + max) / 2;
        const value = mid + this.gauss() * ((max - min) / 6);
        return Math.min(max, Math.max(min, value));
    },
};

export const sleep = (ms) => new Promise((done) => setTimeout(done, Math.max(0, Math.round(ms))));

export const sleepFor = (spec, ratio) => sleep(human.ms(spec, ratio));
