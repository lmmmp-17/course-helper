/* 不需要浏览器的部分：随机化、轨迹几何、参数解析、流程决策 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { human } from '../src/human.mjs';
import { createPointer } from '../src/pointer.mjs';
import { parseArgs, defaults } from '../src/config.mjs';
import { isAllowedUrl } from '../src/selectors.mjs';
import { CourseRunner, pickNextSection } from '../src/course.mjs';
import { createLogger } from '../src/logger.mjs';
import { launchHint, describePlatform, findBrowser, browserCandidates, dedicatedArgs, sideProfileDir, kindOfPath } from '../src/platform.mjs';
import { launchOptions, launchDedicatedBrowser, pickCoursePage, kindOfVersion, openBrowser } from '../src/browser.mjs';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { ensureInstalled } from '../src/setup.mjs';
import { createServer } from 'node:http';

const silent = createLogger('silent');

/* 本地靶场实测：真人连续操作的间隔变异系数(标准差/均值)是 0.45~0.49。
 * 以前的「区间内均匀取值」只有 0.17~0.28——同样随机，但分布形状不是一回事。 */
function dispersion(sample) {
    const values = Array.from({ length: 20000 }, sample);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1));
    const sorted = [...values].sort((a, b) => a - b);
    return { mean, cv: sd / mean, min: sorted[0], median: sorted[Math.floor(values.length / 2)] };
}

test('等待时长的离散度贴近真人实测值，而不是均匀分布', () => {
    for (const spec of [[200, 400], [2600, 9000], 1000]) {
        const { cv, median, min } = dispersion(() => human.ms(spec));
        assert.ok(cv > 0.40 && cv < 0.55, `${JSON.stringify(spec)} 的 CV 应接近真人的 0.45~0.49，实际 ${cv.toFixed(3)}`);
        const center = Array.isArray(spec) ? (spec[0] + spec[1]) / 2 : spec;
        assert.ok(Math.abs(median - center) / center < 0.1, `中位数应当还在配置的中心附近，实际 ${median}`);
        if (Array.isArray(spec)) assert.ok(min >= spec[0], `不应比配置的下限还快，实际 ${min}`);
    }
    /* ratio 传了就按它收窄：保活、冷却这类内部节拍不需要真人那么散 */
    assert.ok(dispersion(() => human.ms(8000, 0.25)).cv < 0.3);
});

test('落点集中在元素中部且不是几何正中心', () => {
    const page = { viewportSize: () => ({ width: 1280, height: 800 }), mouse: {} };
    const pointer = createPointer(page);
    const box = { x: 100, y: 200, width: 200, height: 40 };
    const points = Array.from({ length: 60 }, () => pointer.aimAt(box));
    assert.ok(points.every((p) => p.x > 100 && p.x < 300 && p.y > 200 && p.y < 240), '落点必须在元素内');
    assert.ok(points.some((p) => Math.round(p.x) !== 200 || Math.round(p.y) !== 220), '不应总是正中心');
    const avgX = points.reduce((sum, p) => sum + p.x, 0) / points.length;
    assert.ok(Math.abs(avgX - 200) < 22, `均值应当靠近中心，实际 ${avgX.toFixed(1)}`);
});

test('指针轨迹是曲线、起步慢、终点精确', async () => {
    const moves = [];
    const page = {
        viewportSize: () => ({ width: 1440, height: 900 }),
        mouse: { move: (x, y) => moves.push({ x, y }) },
    };
    const pointer = createPointer(page, { x: 100, y: 100 });
    await pointer.moveTo({ x: 900, y: 600 });

    assert.ok(moves.length >= 6, '应当有多个采样点');
    assert.deepEqual(moves.at(-1), { x: 900, y: 600 }, '终点必须精确命中');

    /* 直线会让每一点都落在同一条斜率上 */
    const slope = (600 - 100) / (900 - 100);
    const offLine = moves.filter((p) => Math.abs((p.y - 100) - slope * (p.x - 100)) > 2);
    assert.ok(offLine.length > 0, '轨迹不应是直线');

    /* 缓入：第一步的位移应当小于中段某一步 */
    const first = Math.hypot(moves[0].x - 100, moves[0].y - 100);
    const mid = Math.hypot(
        moves[Math.floor(moves.length / 2)].x - moves[Math.floor(moves.length / 2) - 1].x,
        moves[Math.floor(moves.length / 2)].y - moves[Math.floor(moves.length / 2) - 1].y,
    );
    assert.ok(first < mid, `起步应当比中段慢（${first.toFixed(1)} vs ${mid.toFixed(1)}）`);
});

test('参数解析：支持区间外的覆盖、拒绝错误输入', () => {
    assert.equal(parseArgs([]).config.mode, 'connect', '默认走 connect');
    assert.equal(defaults.playbackRate, 'max', '默认切到菜单里最高的一档');

    const parsed = parseArgs(['--launch', '--cdp-port=9444', '--max-sections', '2', '--no-idle-activity']);
    assert.equal(parsed.config.mode, 'launch');
    assert.equal(parsed.config.cdpPort, 9444);
    assert.equal(parsed.config.maxSections, 2);
    assert.equal(parsed.config.idleActivity, false);

    assert.throws(() => parseArgs(['--nope']), /无法识别的参数: --nope/);
    assert.throws(() => parseArgs(['--cdp-port', 'abc']), /需要是数字/);
    assert.throws(() => parseArgs(['--mode', 'weird']), /只能是 connect 或 launch/);
});

test('只接受 chaoxing.com 的地址', () => {
    assert.equal(isAllowedUrl('https://mooc1.chaoxing.com/mycourse/studentstudy?x=1'), true);
    assert.equal(isAllowedUrl('https://chaoxing.com/a'), true);
    assert.equal(isAllowedUrl('https://evil-chaoxing.com.attacker.net/a'), false);
    assert.equal(isAllowedUrl('https://notchaoxing.com/a'), false);
    assert.equal(isAllowedUrl('file:///etc/passwd'), false);
    assert.equal(isAllowedUrl('不是地址'), false);
});

test('平台提示用的是独立 profile 目录', () => {
    const hint = launchHint(9222);
    assert.match(hint, /--remote-debugging-port=9222/);
    assert.match(hint, /--user-data-dir/);
    assert.match(hint, /--mute-audio/);
    assert.match(hint, /--disable-backgrounding-occluded-windows/, 'Windows 上窗口被盖住会变 hidden，手动命令也得带');
    assert.ok(describePlatform().length > 0);
    const edge = launchHint(9222, 'edge');
    assert.match(edge, /edge/i);
    assert.match(edge, /xuexitong-edge/, 'Edge 用自己的 profile 目录');
    assert.match(edge, /--disable-features=msImplicitSignin\S* --disable-sync/, '手动命令也要关掉自动登录和同步');
    assert.doesNotMatch(hint, /msImplicitSignin/);
    assert.match(launchHint(9222, 'edge', '/opt/edge/msedge'), /^"\/opt\/edge\/msedge" /, '找到了就用实际位置');
});

/* 用假 page 验证切节决策，不需要浏览器 */
function fakePage(tree) {
    const clicked = [];
    return {
        clicked,
        locator(selector) {
            const chain = [selector];
            const self = {
                nth(index) { chain.push(`nth(${index})`); return self; },
                locator(next) { chain.push(next); return self; },
                first() { chain.push('first'); return self; },
                async count() { return 1; },
                async boundingBox() { return { x: 10, y: 60, width: 180, height: 30 }; },
                async isVisible() { return true; },
                async textContent() { return ''; },
                chain,
            };
            return self;
        },
        async evaluate(fn, arg) {
            void arg;
            if (String(fn).includes('innerWidth')) return 1280;
            return tree;
        },
    };
}

/* 点了目录项之后, 真实页面会把激活项移到被点的那一节。假页面也照做,
 * 否则 gotoNextSection 的"确认切过去"永远等不到。 */
function clickingMovesActive(tree, picked) {
    return {
        async click(locator) {
            picked.push(locator.chain.join(' > '));
            const indexes = locator.chain
                .filter((part) => part.startsWith('nth('))
                .map((part) => Number(part.slice(4, -1)));
            if (indexes.length >= 2) {
                const [c, sec] = indexes;
                tree.chapters.forEach((ch) => ch.sections.forEach((item) => { item.active = false; }));
                const hit = tree.chapters[c].sections[sec];
                hit.active = true;
                tree.current = hit;
            }
        },
    };
}

test('切节：同章有下一节就点它', async () => {
    const tree = {
        chapters: [{ chapterIndex: 0, sections: [
            { chapterIndex: 0, sectionIndex: 0, title: '1.1', active: true },
            { chapterIndex: 0, sectionIndex: 1, title: '1.2', active: false },
        ] }],
        current: { chapterIndex: 0, sectionIndex: 0, title: '1.1', active: true },
        total: 2,
    };
    const page = fakePage(tree);
    const picked = [];
    const runner = new CourseRunner({
        page,
        pointer: clickingMovesActive(tree, picked),
        config: { ...defaults, sectionLoadMs: [1, 2], sectionSwitchWaitMs: 500 },
        log: silent,
    });
    assert.equal(await runner.gotoNextSection(), true);
    assert.match(picked[0], /nth\(0\).*nth\(1\)/, `应当点同章的第二节，实际: ${picked[0]}`);
});

test('切节：本章放完跳到下一章第一节，没有下一章就收尾', async () => {
    const base = (currentChapter) => ({
        chapters: [
            { chapterIndex: 0, sections: [{ chapterIndex: 0, sectionIndex: 0, title: '1.1', active: currentChapter === 0 }] },
            { chapterIndex: 1, sections: [{ chapterIndex: 1, sectionIndex: 0, title: '2.1', active: currentChapter === 1 }] },
        ],
        current: { chapterIndex: currentChapter, sectionIndex: 0, title: '', active: true },
        total: 2,
    });

    const picked = [];
    const firstTree = base(0);
    const runner = new CourseRunner({
        page: fakePage(firstTree),
        pointer: clickingMovesActive(firstTree, picked),
        config: { ...defaults, sectionLoadMs: [1, 2], sectionSwitchWaitMs: 500 },
        log: silent,
    });
    assert.equal(await runner.gotoNextSection(), true);
    assert.match(picked[0], /nth\(1\)/, '应当跨到第二章');

    const last = new CourseRunner({
        page: fakePage(base(1)),
        pointer: { async click() { throw new Error('最后一节不应该再点'); } },
        config: { ...defaults, sectionLoadMs: [1, 2] },
        log: silent,
    });
    assert.equal(await last.gotoNextSection(), false, '最后一节应当返回 false');
});

test('切节：目录有任务点标记时跳到下一个有待完成任务点的小节', () => {
    const section = (chapterIndex, sectionIndex, pending, active = false) => ({ chapterIndex, sectionIndex, title: `${chapterIndex + 1}.${sectionIndex + 1}`, active, pending });
    const tree = (sections) => {
        const chapters = [0, 1].map((chapterIndex) => ({ chapterIndex, sections: sections.filter((s) => s.chapterIndex === chapterIndex) }));
        return { chapters, current: sections.find((s) => s.active), total: sections.length };
    };

    /* 实测结构: 1.2 有 1 个待完成, 中间是 0 个任务点和已完成(0) */
    let picked = pickNextSection(tree([section(0, 0, 0, true), section(0, 1, 0), section(1, 0, 0), section(1, 1, 1), section(1, 2, 0)]));
    assert.equal(picked.target.title, '2.2');
    assert.equal(picked.skipped, 2);

    /* 后面都没有待完成的: 收尾, 不往下点 */
    picked = pickNextSection(tree([section(0, 0, 1, true), section(0, 1, 0), section(1, 0, 0)]));
    assert.equal(picked.target, null);
    assert.equal(picked.marked, true);

    /* 读不出标记的小节要进去看看 */
    picked = pickNextSection(tree([section(0, 0, 0, true), section(0, 1, 0), section(1, 0, null), section(1, 1, 1)]));
    assert.equal(picked.target.title, '2.1');

    /* 整个目录都没有标记(旧布局): 按顺序 */
    picked = pickNextSection(tree([section(0, 0, null, true), section(0, 1, null), section(1, 0, null)]));
    assert.equal(picked.target.title, '1.2');
    assert.equal(picked.marked, false);
});

test('默认静音, --no-mute 可以关掉', () => {
    assert.equal(parseArgs([]).config.mute, true);
    assert.equal(parseArgs(['--no-mute']).config.mute, false);
});

test('播放中课程页被关掉: 如实停下, 不算这一节完成', async () => {
    /* 实测: 播放 8 秒后标签页被关掉, 以前会计一节完成、歇 43 秒再去点下一节, 最后报错退出 */
    const page = { isClosed: () => true, frames: () => [] };
    const runner = new CourseRunner({ page, pointer: {}, config: { ...defaults, pollIntervalMs: 5 }, log: silent });
    const video = { frame: null, locator: { evaluate: async () => { throw new Error('Target page, context or browser has been closed'); } } };
    assert.equal(await runner.watchUntilEnd(video), 'stopped');
    assert.equal(runner.stopped, true);
    assert.equal(runner.sectionsDone, 0);
});

test('指针微动的间隔铺满配置区间, 不被轮询压成固定节拍', async () => {
    /* 实测: 每轮轮询重抽阈值时, 18–55 秒的配置跑出来全是 22–26 秒 */
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
        const fired = [];
        const runner = new CourseRunner({
            page: {},
            pointer: { async drift() { fired.push(now); } },
            config: { ...defaults, idleActivityMs: [18000, 55000] },
            log: silent,
        });
        for (let t = 0; t < 4 * 3600 * 1000; t += 1200) {
            now += 1200;
            await runner.maybeDrift();
        }
        const gaps = fired.slice(1).map((at, i) => (at - fired[i]) / 1000);
        const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        /* 对数正态在 [18,55] 秒上的均值约 40 秒(实测 25 轮落在 39.7~44.5)。
         * 每轮重抽阈值的老写法会把它压到约 25 秒——这条就是用来挡那个的。 */
        assert.ok(mean > 34 && mean < 50, `平均间隔应接近分布本身的均值, 实际 ${mean.toFixed(1)} 秒`);
        assert.ok(gaps.filter((g) => g > 45).length > gaps.length * 0.15, '应当有相当比例的长间隔');
        assert.ok(gaps.every((g) => g >= 18), `不应比配置的下限还快: ${Math.min(...gaps).toFixed(1)}`);
    } finally {
        Date.now = realNow;
    }
});

/* 造一个倍速菜单: 档位照真实页面实测的 [0.75, 1, 1.25, 1.5, 2]。
 * 真实页面上当前选中的那条文字是 "1x, 选择", 所以解析要容得下后缀。 */
function fakeRateMenu({ rates = [2, 1.5, 1.25, 1, 0.75], current = 1, clicks = [], opensOnHover = true } = {}) {
    const state = { rate: current, clicks, opened: opensOnHover };
    const locator = (selector) => ({
        first: () => locator(selector),
        nth: (index) => ({ ...locator(selector), index }),
        async count() { return selector.includes('menu-item') ? rates.length : 1; },
        async boundingBox() { return { x: 0, y: 0, width: 800, height: 450 }; },
        /* 菜单没展开时档位是不可见的, 和真实页面一样(实测 rect 全是 0) */
        async isVisible() { return selector.includes('menu-item') ? state.opened : true; },
        async evaluateAll(fn) {
            return fn(rates.map((rate, i) => ({
                textContent: i === rates.indexOf(current) ? `${rate}x, 选择` : `${rate}x`,
            })));
        },
        selector,
    });
    return {
        state,
        video: {
            frame: { locator },
            locator: {
                async evaluate(fn) {
                    void fn;
                    return { currentTime: 0, duration: 100, paused: false, ended: false,
                        muted: true, readyState: 4, rate: state.rate };
                },
            },
        },
        pointer: {
            async moveTo() {},
            async click(target) {
                clicks.push(target.selector);
                /* 点按钮展开菜单; 点中档位才真正改倍速, 和播放器的行为一致 */
                if (target.selector.includes('menu-item')) {
                    if (!state.opened) throw new Error('菜单没展开, 点不到');
                    state.rate = rates[target.index];
                } else {
                    state.opened = true;
                }
            },
        },
    };
}

test('倍速：默认切到菜单里最高的一档，用的是播放器自己的菜单', async () => {
    /* 悬停就展开的播放器: 不用多点一下按钮 */
    const hover = fakeRateMenu({ opensOnHover: true });
    const runner = new CourseRunner({
        page: fakePage({}), pointer: hover.pointer, config: { ...defaults }, log: silent,
    });
    assert.equal(await runner.applyPlaybackRate(hover.video), 2);
    assert.equal(hover.state.rate, 2);
    assert.deepEqual(hover.state.clicks.filter((s) => !s.includes('menu-item')), [], '悬停就展开时不必点按钮');
    assert.ok(hover.state.clicks.some((s) => s.includes('menu-item')), '应当点具体档位');

    /* 必须点一下才展开的播放器 */
    const needsClick = fakeRateMenu({ opensOnHover: false });
    const second = new CourseRunner({
        page: fakePage({}), pointer: needsClick.pointer, config: { ...defaults }, log: silent,
    });
    assert.equal(await second.applyPlaybackRate(needsClick.video), 2);
    assert.ok(needsClick.state.clicks[0].includes('vjs-playback-rate button'), '应当先点开菜单');
    assert.ok(needsClick.state.clicks[1].includes('menu-item'));
});

test('倍速：给了数字就取不超过它的最高档；给 1 则完全不碰', async () => {
    const capped = fakeRateMenu();
    const runner = new CourseRunner({
        page: fakePage({}), pointer: capped.pointer,
        config: { ...defaults, playbackRate: 1.3 }, log: silent,
    });
    assert.equal(await runner.applyPlaybackRate(capped.video), 1.25);

    const untouched = fakeRateMenu();
    const plain = new CourseRunner({
        page: fakePage({}), pointer: untouched.pointer,
        config: { ...defaults, playbackRate: 1 }, log: silent,
    });
    assert.equal(await plain.applyPlaybackRate(untouched.video), null);
    assert.deepEqual(untouched.state.clicks, [], 'playbackRate=1 时一次都不该点');
});

test('倍速：没有倍速菜单就保持原速，而且不存在写 playbackRate 的退路', async () => {
    /* 平台不让改倍速时这个控件根本不存在 */
    const clicks = [];
    const video = {
        frame: { locator: () => ({ first: () => ({ async count() { return 0; } }), async count() { return 0; } }) },
        locator: { async evaluate() { return null; } },
    };
    const runner = new CourseRunner({
        page: fakePage({}), pointer: { async click(t) { clicks.push(t); } },
        config: { ...defaults }, log: silent,
    });
    assert.equal(await runner.applyPlaybackRate(video), null);
    assert.deepEqual(clicks, []);
    /* 倍速只能来自播放器菜单: 写属性等于绕过平台自己的控件, 源码里不该再有这条路 */
    const source = await readFile(new URL('../src/course.mjs', import.meta.url), 'utf8');
    assert.equal(/playbackRate\s*=[^=]/.test(source), false, '不应退回写 playbackRate');
});

test('倍速：已经是最高档就不再点菜单', async () => {
    const menu = fakeRateMenu({ current: 2 });
    const runner = new CourseRunner({
        page: fakePage({}), pointer: menu.pointer, config: { ...defaults }, log: silent,
    });
    assert.equal(await runner.applyPlaybackRate(menu.video), 2);
    assert.deepEqual(menu.state.clicks, []);
});

test('launch 模式的启动参数不引入新特征', () => {
    const options = launchOptions();
    assert.equal(options.headless, false, '无头浏览器的特征面比自动化标志本身还大');
    assert.equal(options.channel, 'chrome', '要用本机真实 Chrome，不是 bundled Chromium');
    assert.equal(options.viewport, null, '视口应跟随真实窗口');
    assert.ok(options.ignoreDefaultArgs.includes('--enable-automation'), '必须去掉自动化标志');
    assert.ok(
        options.args.includes('--disable-blink-features=AutomationControlled'),
        'navigator.webdriver 要靠这一项变成 false'
    );
    assert.equal(options.locale, 'zh-CN');
    assert.ok(options.args.includes('--mute-audio'), '默认在浏览器这一层也静音');
    assert.equal(launchOptions({ mute: false }).args.includes('--mute-audio'), false);
    assert.equal(launchOptions({ kind: 'edge' }).channel, 'msedge', '选了 Edge 就用本机 Edge');
});

test('指针起点必须是 (0,0)，否则第一次移动会带一个瞬移位移', () => {
    const pointer = createPointer({ viewportSize: () => ({ width: 1280, height: 800 }), mouse: {} });
    assert.deepEqual({ x: pointer.state.x, y: pointer.state.y }, { x: 0, y: 0 },
        'Blink 用上一次坐标算 movementX/Y，页面刚打开时那个坐标就是 (0,0)');
});

test('页签点了却始终没出现视频时要停手，不能原地打转', async () => {
    const tree = {
        chapters: [{ chapterIndex: 0, sections: [
            { chapterIndex: 0, sectionIndex: 0, title: '1.1', active: true },
            { chapterIndex: 0, sectionIndex: 1, title: '1.2', active: false },
        ] }],
        current: { chapterIndex: 0, sectionIndex: 0, title: '1.1', active: true },
        total: 2,
    };
    let clicks = 0;
    const page = {
        async waitForSelector() { return true; },
        frames() { return []; },           /* 永远找不到视频 */
        async evaluate(fn, arg) {
            if (typeof arg === 'string') return '学习目标';   /* currentStepTitle */
            if (arg && arg.chapter) return tree;              /* readTree */
            return false;                                      /* document.hidden */
        },
        locator() {
            const self = {
                nth: () => self, locator: () => self, first: () => self,
                async count() { return 1; },
                async isVisible() { return true; },
                async textContent() { return '2视频'; },
                async boundingBox() { return { x: 0, y: 40, width: 80, height: 24 }; },
            };
            return self;
        },
    };
    const runner = new CourseRunner({
        page,
        pointer: { async click() { clicks += 1; } },
        config: {
            ...defaults,
            startupDelayMs: [1, 2], stepProbeMs: [1, 2], stepSwitchWaitMs: [1, 2],
            videoProbeMs: [1, 2], maxStepSwitchTries: 3, jobsWaitMs: 1,
        },
        log: silent,
    });

    /* 没有上限保护的话这里会永远转下去 */
    await Promise.race([
        runner.run(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('run() 没有在上限处停下')), 5000)),
    ]);
    assert.equal(clicks, 3, `应当恰好点 3 次页签就停，实际 ${clicks} 次`);
});

test('切节：点了目录却没切过去时重试一次就停下，不原地打转', async () => {
    const tree = {
        chapters: [{ chapterIndex: 0, sections: [
            { chapterIndex: 0, sectionIndex: 0, title: '1.1', active: true },
            { chapterIndex: 0, sectionIndex: 1, title: '1.2', active: false },
        ] }],
        current: { chapterIndex: 0, sectionIndex: 0, title: '1.1', active: true },
        total: 2,
    };
    let clicks = 0;
    const runner = new CourseRunner({
        page: fakePage(tree),
        /* 实测: 目录收起时点击落在视口外, 页面不动 */
        pointer: { async click() { clicks += 1; } },
        config: { ...defaults, sectionLoadMs: [1, 2], sectionSwitchWaitMs: 200 },
        log: silent,
    });
    assert.equal(await runner.gotoNextSection(), false);
    assert.equal(clicks, 2, '应当只点两次: 一次加一次重试');
    assert.equal(runner.stopped, true, '切不过去就该停下');
});

test('找浏览器：Windows / macOS 看固定位置，Linux 在 PATH 里找，--browser-path 优先', () => {
    const win = browserCandidates('chrome', 'win32', { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' });
    assert.equal(win[0], 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    assert.ok(win.some((p) => p.startsWith('C:\\Users\\u\\AppData\\Local')), '要包括只给当前用户装的位置');
    const winHit = findBrowser({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' }, exists: (p) => p.startsWith('C:\\L') });
    assert.deepEqual(winHit, { kind: 'chrome', exe: 'C:\\L\\Google\\Chrome\\Application\\chrome.exe' });

    const linux = findBrowser({ platform: 'linux', env: { PATH: '/nope:/opt/bin' }, exists: (p) => p === '/opt/bin/chromium' });
    assert.deepEqual(linux, { kind: 'chrome', exe: '/opt/bin/chromium' });
    assert.equal(findBrowser({ platform: 'linux', env: { PATH: '/nope' }, exists: () => false }), null);

    assert.deepEqual(findBrowser({ configured: '/my/chrome', exists: (p) => p === '/my/chrome' }), { kind: 'chrome', exe: '/my/chrome' });
    assert.equal(findBrowser({ configured: '/missing', exists: () => false }), null, '指定的路径不存在就别悄悄换成别的');
    assert.match(browserCandidates('chrome', 'darwin', {}, '/Users/u')[0], /^\/Applications\/Google Chrome\.app/);
    assert.match(browserCandidates('edge', 'darwin', {}, '/Users/u')[0], /^\/Applications\/Microsoft Edge\.app/);
});

test('Edge：没装 Chrome 时 auto 用 Edge；明确选了哪个就只找哪个', () => {
    const env = { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)' };
    const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    assert.equal(browserCandidates('edge', 'win32', env)[0], edgeExe, 'Edge 默认装在 Program Files (x86)');
    const onlyEdge = (p) => p === edgeExe;
    assert.deepEqual(findBrowser({ platform: 'win32', env, exists: onlyEdge }), { kind: 'edge', exe: edgeExe });
    assert.equal(findBrowser({ browser: 'chrome', platform: 'win32', env, exists: onlyEdge }), null, '选了 Chrome 就不悄悄换成 Edge');
    const both = () => true;
    assert.equal(findBrowser({ platform: 'win32', env, exists: both }).kind, 'chrome', 'auto 两个都有时用 Chrome');
    assert.equal(findBrowser({ browser: 'edge', platform: 'win32', env, exists: both }).kind, 'edge');
    assert.deepEqual(
        findBrowser({ platform: 'linux', env: { PATH: '/usr/bin' }, exists: (p) => p === '/usr/bin/microsoft-edge-stable' }),
        { kind: 'edge', exe: '/usr/bin/microsoft-edge-stable' },
    );
    /* --browser-path 指向 Edge、又没说 --browser 时按文件名认 */
    assert.equal(kindOfPath('C:\\x\\msedge.exe'), 'edge');
    assert.equal(kindOfPath('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'), 'edge');
    assert.equal(kindOfPath('/usr/bin/google-chrome'), 'chrome');
    assert.equal(findBrowser({ configured: '/opt/microsoft-edge', exists: () => true }).kind, 'edge');
    assert.equal(findBrowser({ browser: 'chrome', configured: '/opt/whatever', exists: () => true }).kind, 'chrome');
    /* profile 分开放；Chrome 沿用原来的目录，已经登录过的不用重登 */
    assert.match(sideProfileDir('chrome'), /xuexitong-chrome$/);
    assert.match(sideProfileDir('edge'), /xuexitong-edge$/);
});

test('调试端口上是哪种浏览器：按 /json/version 认', () => {
    assert.equal(kindOfVersion({
        Browser: 'Edg/141.0.3537.71',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
    }), 'edge');
    assert.equal(kindOfVersion({
        Browser: 'Chrome/141.0.7390.65',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    }), 'chrome');
    assert.equal(kindOfVersion({}), 'chrome');
});

test('端口上开着另一种浏览器时不悄悄接管，说清楚怎么办', async () => {
    const server = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ Browser: 'Chrome/141.0.7390.65', 'User-Agent': 'Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36' }));
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address();
    try {
        await assert.rejects(
            openBrowser({ ...defaults, cdpPort: port, browser: 'edge' }, silent),
            /开着的是 Chrome，不是你选的 Edge.*--cdp-port/s,
        );
    } finally {
        server.close();
    }
});

test('自动启动专用浏览器的参数：和手动命令同一组，不带任何自动化开关', () => {
    const args = dedicatedArgs({ port: 9222, profileDir: '/home/u/xuexitong-chrome', url: 'https://i.chaoxing.com/' });
    assert.ok(args.includes('--remote-debugging-port=9222'));
    assert.ok(args.includes('--user-data-dir=/home/u/xuexitong-chrome'));
    assert.ok(args.includes('--mute-audio'), '默认静音');
    assert.ok(args.includes('--disable-backgrounding-occluded-windows'), 'Windows 上窗口被盖住会变 hidden，视频直接停');
    assert.equal(args.at(-1), 'https://i.chaoxing.com/');
    assert.equal(args.some((a) => /automation|headless|webdriver/i.test(a)), false);
    assert.equal(dedicatedArgs({ port: 1, profileDir: '/p', mute: false }).includes('--mute-audio'), false);
    assert.equal(args.some((a) => /disable-sync|disable-features/.test(a)), false, 'Edge 独有的开关不加给 Chrome');
});

test('连不上时自动启动专用浏览器：独立进程、不跟着脚本退出、等到调试端口就绪', async () => {
    /* 用一个假的 /json/version 充当“Chrome 起来了” */
    const server = createServer((req, res) => { res.writeHead(200); res.end('{}'); });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address();
    let call = null;
    let unref = 0;
    try {
        await launchDedicatedBrowser(
            { ...defaults, cdpPort: port, browserPath: process.execPath, browserProfile: '/tmp/p' },
            silent,
            {
                url: 'http://example.test/',
                spawnProcess(exe, args, options) {
                    call = { exe, args, options };
                    return { pid: 1, on() {}, unref() { unref += 1; } };
                },
            },
        );
    } finally {
        server.close();
    }
    assert.equal(call.exe, process.execPath);
    assert.equal(call.options.detached, true, '脚本退出（Ctrl+C）时不能把 Chrome 一起带走');
    assert.equal(call.options.stdio, 'ignore');
    assert.equal(unref, 1);
    assert.ok(call.args.includes(`--remote-debugging-port=${port}`));
    /* profile 走 path.resolve, Windows 上 '/tmp/p' 会变成 C:\tmp\p, 所以同样算一次 */
    assert.ok(call.args.includes(`--user-data-dir=${resolve('/tmp/p')}`), call.args.join(' '));
    assert.equal(call.args.at(-1), 'http://example.test/');
});

test('找不到浏览器时说清楚怎么办', async () => {
    const noSpawn = { spawnProcess() { throw new Error('不应启动'); } };
    await assert.rejects(
        launchDedicatedBrowser({ ...defaults, browserPath: '/definitely/not/chrome' }, silent, noSpawn),
        /--browser-path 指定的 \/definitely\/not\/chrome 不存在/,
    );
    const nothing = { ...noSpawn, find: () => null };
    await assert.rejects(launchDedicatedBrowser({ ...defaults }, silent, nothing), /没找到本机的 Chrome，也没找到 Edge.*--browser-path/s);
    await assert.rejects(launchDedicatedBrowser({ ...defaults, browser: 'chrome' }, silent, nothing), /Google Chrome.*--browser edge/s);
    await assert.rejects(launchDedicatedBrowser({ ...defaults, browser: 'edge' }, silent, nothing), /Microsoft Edge.*--browser chrome/s);
});

test('选 Edge 时启动的是 Edge，用 Edge 自己的 profile', async () => {
    const server = createServer((req, res) => { res.writeHead(200); res.end('{}'); });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address();
    const said = [];
    let call = null;
    try {
        const result = await launchDedicatedBrowser(
            { ...defaults, cdpPort: port, browser: 'edge' },
            { ...silent, say: (text) => said.push(text) },
            {
                find: ({ browser }) => (browser === 'edge' ? { kind: 'edge', exe: '/opt/edge/msedge' } : null),
                spawnProcess(exe, args) {
                    call = { exe, args };
                    return { pid: 2, on() {}, unref() {} };
                },
            },
        );
        assert.equal(result.kind, 'edge');
    } finally {
        server.close();
    }
    assert.equal(call.exe, '/opt/edge/msedge');
    assert.ok(call.args.includes(`--user-data-dir=${sideProfileDir('edge')}`), call.args.join(' '));
    assert.ok(call.args.includes('--disable-backgrounding-occluded-windows'));
    assert.ok(call.args.includes('--mute-audio'));
    assert.match(said.join('\n'), /启动专用 Edge/);
    /* Windows 登录着微软账号时，Edge 会把新 profile 自动登录并打开同步（实测），这两项关掉它 */
    assert.ok(call.args.includes('--disable-sync'));
    assert.ok(call.args.some((a) => /^--disable-features=.*msImplicitSignin/.test(a)), call.args.join(' '));
    assert.equal(call.args.filter((a) => a.startsWith('--disable-features=')).length, 1, '写两条的话后一条会盖掉前一条');
});

test('没有课程页时一直等，用户点开课程后自动接管；Ctrl+C 能退出', async () => {
    const pages = [{ url: () => 'https://i.chaoxing.com/base' }];
    const context = { pages: () => pages };
    const course = {
        url: () => 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1',
        async waitForLoadState() {},
        async bringToFront() {},
    };
    setTimeout(() => pages.push(course), 400);
    const picked = await pickCoursePage(context, { ...defaults }, silent, { stopped: false });
    assert.equal(picked, course);

    const abort = { stopped: false };
    setTimeout(() => { abort.stopped = true; }, 300);
    await assert.rejects(pickCoursePage({ pages: () => [] }, { ...defaults }, silent, abort), /已退出/);
});

test('第一次运行自动安装依赖；装过就不再装；--setup 强制重装；失败时给出镜像提示', () => {
    const calls = [];
    const ok = (cmd, options) => { calls.push({ cmd, options }); return { status: 0 }; };
    assert.equal(ensureInstalled(silent, { dir: '/nonexistent-dir', run: ok }), true);
    assert.match(calls[0].cmd, /^npm install/);
    assert.equal(calls[0].options.shell, true, 'Windows 上 npm 是 .cmd，要经过 shell 才能启动');
    assert.equal(ensureInstalled(silent, { run: ok }), false, '本仓库已经装过，不应再装');
    assert.equal(ensureInstalled(silent, { force: true, run: ok }), true);
    assert.throws(() => ensureInstalled(silent, { dir: '/nonexistent-dir', run: () => ({ status: 1 }) }), /npmmirror/);
});

test('统一启动器关掉 stdin 就是让停：只触发一次，解除后不再触发', async () => {
    const { PassThrough } = await import('node:stream');
    const { watchStdinForStop } = await import('../src/stop-signal.mjs');
    const stream = new PassThrough();
    let stops = 0;
    watchStdinForStop(stream, () => { stops += 1; });
    stream.end();
    await new Promise((done) => setImmediate(done));
    assert.equal(stops, 1);
    stream.emit('error', new Error('管道断了'));
    assert.equal(stops, 1, '只算一次');

    const other = new PassThrough();
    let late = 0;
    const unwatch = watchStdinForStop(other, () => { late += 1; });
    unwatch();
    other.end();
    await new Promise((done) => setImmediate(done));
    assert.equal(late, 0);
});

test('统一启动器关掉 stdin：真实子进程里也能收到', async () => {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const helper = fileURLToPath(new URL('../src/stop-signal.mjs', import.meta.url));
    const child = spawn(process.execPath, ['--input-type=module', '-e',
        `import { watchStdinForStop } from ${JSON.stringify(helper)};
         watchStdinForStop(process.stdin, () => { console.log('收到停止'); process.exit(0); });
         console.log('就绪');`], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; if (out.includes('就绪')) child.stdin.end(); });
    const code = await new Promise((done) => child.on('close', done));
    assert.equal(code, 0);
    assert.match(out, /收到停止/);
});

test('从启动器跑（COURSE_UI=1）时，日志里不教人按 Ctrl+C：停止靠界面上的按钮', async () => {
    const { keyHint } = await import('../src/stop-signal.mjs');
    assert.equal(keyHint('，按 Ctrl+C 退出', { COURSE_UI: '1' }), '');
    assert.equal(keyHint('，按 Ctrl+C 退出', {}), '，按 Ctrl+C 退出');
});

test('从启动器跑时，状态行每次变化都单独发一行 [[status]]，不按分钟节流', () => {
    const out = [];
    const stream = { write: (text) => out.push(text), isTTY: false };
    const log = createLogger('quiet', { stream, ui: true, now: () => 0 });
    log.status('⏳ 等你打开课程（已等 2 秒）');
    log.status('⏳ 等你打开课程（已等 2 秒）');
    log.status('⏳ 等你打开课程（已等 3 秒）');
    log.clearStatus();
    log.clearStatus();
    assert.deepEqual(out, [
        '[[status]] ⏳ 等你打开课程（已等 2 秒）\n',
        '[[status]] ⏳ 等你打开课程（已等 3 秒）\n',
        '[[status]] \n',
    ], '一样的不重复发；收掉状态发一条空的');
});

test('等课程页的时候浏览器被关掉：不再等下去，正常退出', async () => {
    const { EventEmitter } = await import('node:events');
    const context = new EventEmitter();
    context.pages = () => [];
    setTimeout(() => context.emit('close'), 200);
    const startedAt = Date.now();
    assert.equal(await pickCoursePage(context, { ...defaults }, silent, { stopped: false }), null);
    assert.ok(Date.now() - startedAt < 2500, '一轮之内发现');
    assert.equal(context.listenerCount('close'), 0, '监听要摘掉');

    /* 连接断了但没收到 close 事件，也认 */
    const cut = { pages: () => [], browser: () => ({ isConnected: () => false }) };
    assert.equal(await pickCoursePage(cut, { ...defaults }, silent, { stopped: false }), null);
});
