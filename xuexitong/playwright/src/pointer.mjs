/* ------------------------------------------------------------------
 * 真实指针操作
 * page.mouse.* 走的是 CDP 的 Input.dispatchMouseEvent，由浏览器自己构造事件，
 * 所以 isTrusted 为 true、movementX/Y 由 Blink 按真实语义填，不存在油猴版那种
 * “想伪造也伪造不了”的问题。
 *
 * 但“输入可信”并不等于“像人操作”：
 *   - 一步跳到元素中心再点，轨迹是一条没有任何抖动的直线（或干脆没有轨迹）
 *   - 每次都精准命中几何中心
 *   - 按下到抬起 0 毫秒
 * 所以这里补的是轨迹：贝塞尔曲线、沿途微抖、偶尔过冲回修、落点靠中心但不在
 * 正中心、按下与抬起之间有人手量级的间隔。
 * ------------------------------------------------------------------ */
import { human, sleep } from './human.mjs';

/* 指针位置要自己记：CDP 的鼠标是有状态的，Playwright 不会告诉我们它在哪。
 *
 * 起点必须是 (0,0)，不能随手给一个“看起来自然”的位置。Blink 内部维护着上一次
 * 的指针坐标并用它算 movementX/Y，而那个坐标在页面刚打开时就是 (0,0)。如果我们
 * 假设指针在别处，第一次移动就会带上一个巨大的位移（实测 movementX:-118、
 * movementY:-147），等于一上来就瞬移——真人的第一次移动不会是这样。 */
export function createPointer(page, options = {}) {
    const state = {
        x: options.x ?? 0,
        y: options.y ?? 0,
        moves: 0,
    };

    const viewport = async () => {
        const size = page.viewportSize && page.viewportSize();
        if (size && size.width && size.height) return size;
        return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    };

    /* 三次贝塞尔：控制点在起点终点连线两侧随机偏，距离越远偏得越多。
     * 人的手不会走直线，也不会每次都走同一条弧。 */
    function curve(from, to) {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const distance = Math.hypot(dx, dy);
        const bow = Math.min(120, 8 + distance * human.float(0.06, 0.22));
        const side = human.chance(0.5) ? 1 : -1;
        /* 垂直于移动方向的单位向量 */
        const nx = distance === 0 ? 0 : -dy / distance;
        const ny = distance === 0 ? 0 : dx / distance;
        const control = (ratio, scale) => ({
            x: from.x + dx * ratio + nx * bow * scale * side,
            y: from.y + dy * ratio + ny * bow * scale * side,
        });
        return [
            from,
            control(human.float(0.2, 0.4), human.float(0.6, 1)),
            control(human.float(0.6, 0.8), human.float(0.3, 0.8)),
            to,
        ];
    }

    function bezierAt([p0, p1, p2, p3], t) {
        const u = 1 - t;
        return {
            x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
            y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
        };
    }

    /* 缓入缓出：起步和收尾慢、中间快，和真实手部运动一致 */
    function ease(t) {
        return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
    }

    async function moveTo(target) {
        const from = { x: state.x, y: state.y };
        const distance = Math.hypot(target.x - from.x, target.y - from.y);
        if (distance < 1) return;
        const points = curve(from, target);
        /* 步数随距离走，但每次都重新抽；固定 steps 同样是一种节拍 */
        const steps = Math.max(6, Math.min(48, Math.round(distance / human.float(9, 26))));
        for (let i = 1; i <= steps; i += 1) {
            const point = bezierAt(points, ease(i / steps));
            await page.mouse.move(Math.round(point.x), Math.round(point.y));
            state.x = point.x;
            state.y = point.y;
            /* 大多数相邻采样点之间只隔几毫秒，偶尔卡一下（人会迟疑） */
            if (human.chance(0.06)) {
                await sleep(human.int(18, 70));
            } else {
                await sleep(human.float(1, 9));
            }
        }
        state.moves += 1;
    }

    /* 落点：靠中心，但不是几何正中心，且避开边缘 */
    function aimAt(box) {
        return {
            x: box.x + human.centered(box.width * 0.22, box.width * 0.78),
            y: box.y + human.centered(box.height * 0.26, box.height * 0.74),
        };
    }

    async function moveToBox(box) {
        const target = aimAt(box);
        await moveTo(target);
        /* 过冲再回修：快速移动后人常常会稍微修正一下落点 */
        if (human.chance(0.28)) {
            await moveTo({
                x: target.x + human.int(-7, 7),
                y: target.y + human.int(-5, 5),
            });
        }
        return target;
    }

    /* 目标在滚动容器外时用真实滚轮滚过去，而不是 scrollIntoView() */
    async function revealBox(locator, hint) {
        const { height } = await viewport();
        for (let attempt = 0; attempt < 14; attempt += 1) {
            const box = await locator.boundingBox();
            if (box && box.y > 56 && box.y + box.height < height - 56) return box;

            /* 滚轮事件落在指针所在的元素上，所以先把指针挪到目标所在的列上 */
            if (hint) {
                const anchor = await hint.boundingBox();
                if (anchor) {
                    await moveTo({
                        x: anchor.x + anchor.width * human.float(0.3, 0.7),
                        y: Math.min(height - 40, Math.max(40, anchor.y + anchor.height * human.float(0.3, 0.7))),
                    });
                }
            }

            const wanted = box ? box.y + box.height / 2 - height / 2 : height * human.float(0.3, 0.6);
            const delta = Math.max(-420, Math.min(420, wanted)) * human.float(0.55, 0.95);
            if (Math.abs(delta) < 8) return box;
            await page.mouse.wheel(0, Math.round(delta));
            await sleep(human.int(90, 280));
        }
        return locator.boundingBox();
    }

    /* 只读命中测试: 落点下面是不是这个元素(或它的子孙)。
     * 元素可能在 iframe 里, boundingBox 给的是主 frame 坐标, elementFromPoint 要的是
     * 元素所在 frame 的坐标, 两者之差就是 frame 的偏移。 */
    async function hits(locator, box, point) {
        const local = await locator.evaluate((el) => {
            const rect = el.getBoundingClientRect();
            return { x: rect.left, y: rect.top };
        });
        const x = point.x - (box.x - local.x);
        const y = point.y - (box.y - local.y);
        return locator.evaluate((el, p) => {
            const hit = el.ownerDocument.elementFromPoint(p.x, p.y);
            return !!hit && (hit === el || el.contains(hit));
        }, { x, y });
    }

    /* 走不通人类化路径时交给 Playwright 自己的 click: 它会等元素可交互,
     * 等不到就抛错——宁可报错, 也不能在空白处按下去当作点过了。 */
    async function fallback(locator, reason, timeoutMs) {
        await locator.click({ timeout: timeoutMs ?? options.fallbackTimeoutMs ?? 15000 });
        return { fallback: reason };
    }

    async function click(locator, clickOptions = {}) {
        const box = await revealBox(locator, clickOptions.scrollAnchor);
        if (!box) throw new Error('目标元素不可见，无法点击');

        /* revealBox 只会纵向滚动。横向在视口外(比如收起后滑到屏幕右边的侧栏)时,
         * 以前会直接把指针移到视口外按下去: 什么都没点到, 也不报错, 调用方以为
         * 点过了——学习通目录收起时工具就是这样在同一节上原地打转的。 */
        const { width, height } = await viewport();
        const inView = box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height;
        if (!inView) return fallback(locator, '目标在视口外', clickOptions.timeoutMs);

        const target = await moveToBox(box);
        if (!await hits(locator, box, target)) return fallback(locator, '落点被其它元素挡住', clickOptions.timeoutMs);

        /* 移到位之后先停一下再按下：人不会在指针停住的同一毫秒按键 */
        await sleep(human.int(45, 190));
        await page.mouse.down();
        await sleep(human.int(48, 132));
        await page.mouse.up();
        return box;
    }

    /* 看视频时的低频指针微动：一整节课零输入事件本身就是信号 */
    async function drift() {
        const { width, height } = await viewport();
        await moveTo({
            x: human.float(0.12, 0.88) * width,
            y: human.float(0.15, 0.85) * height,
        });
    }

    return { state, moveTo, moveToBox, revealBox, click, drift, aimAt, curve, bezierAt, ease };
}
