/* ------------------------------------------------------------------
 * 端到端：用本机真实 Chrome 跑完整流程
 *
 * 桩页面只接受 isTrusted 的事件（见 fixtures/course.html），所以这个测试通过
 * 就等于证明了：目录点击、页签点击、播放按钮点击、滚轮，全都是浏览器自己
 * 构造的可信事件，而不是脚本合成的。
 *
 * 需要本机装了 Chrome。没有就跳过，不让 CI 挂掉。
 * ------------------------------------------------------------------ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startFixtureServer } from './server.mjs';
import { createPointer } from '../src/pointer.mjs';
import { CourseRunner } from '../src/course.mjs';
import { createLogger } from '../src/logger.mjs';
import { defaults } from '../src/config.mjs';
import { hardenFocus } from '../src/environment.mjs';
import { collectFingerprint, probeTrustedInput } from '../src/diagnose.mjs';
import { launchDedicatedBrowser } from '../src/browser.mjs';
import { findBrowser } from '../src/platform.mjs';
import { createServer } from 'node:net';

const fast = {
    ...defaults,
    startupDelayMs: [40, 120],
    pollIntervalMs: 160,
    sectionPauseMs: [60, 160],
    sectionLoadMs: [200, 450],
    guardNoProgressMs: 2500,
    resumeCooldownMs: 900,
    longBreakChance: 0,
    idleActivityMs: [250, 500],
    videoWaitMs: 6000,
    treeTimeoutMs: 15000,
    jobsWaitMs: 300,
};

async function launch() {
    let chromium;
    try {
        ({ chromium } = await import('playwright-core'));
    } catch (e) {
        return { skip: '未安装 playwright-core（在 playwright/ 下执行 npm install）' };
    }
    const profileDir = await mkdtemp(join(tmpdir(), 'xxt-e2e-'));
    try {
        const context = await chromium.launchPersistentContext(profileDir, {
            channel: 'chrome',
            headless: true,
            viewport: { width: 1280, height: 760 },
            ignoreDefaultArgs: ['--enable-automation'],
            args: ['--disable-blink-features=AutomationControlled'],
        });
        return { context, profileDir };
    } catch (e) {
        await rm(profileDir, { recursive: true, force: true });
        return { skip: `起不来本机 Chrome：${e.message.split('\n')[0]}` };
    }
}

test('真实输入驱动完整课程流程', async (t) => {
    const launched = await launch();
    if (launched.skip) return t.skip(launched.skip);
    const { context, profileDir } = launched;
    const server = await startFixtureServer();
    const log = createLogger('silent');

    try {
        const page = await context.newPage();
        await page.goto(server.url, { waitUntil: 'domcontentloaded' });
        const pointer = createPointer(page, { x: 640, y: 420 });

        /* 启用焦点模拟，并确认它真的生效 */
        const focus = await hardenFocus(page, log);
        assert.ok(focus.applied.includes('焦点模拟（blur 不再触发）'), `焦点模拟应当可用，skipped: ${focus.skipped}`);

        const runner = new CourseRunner({ page, pointer, config: fast, log });
        await runner.run();

        const probe = await page.evaluate(() => window.__probe);

        /* 核心断言：桩页面一次都没有拒绝过事件 */
        assert.deepEqual(probe.rejected, [], `不应有任何不可信事件被拒绝: ${probe.rejected.join(',')}`);

        /* 三节都走完了，而且路径符合预期 */
        assert.deepEqual(
            probe.log.filter((entry) => entry.startsWith('select:')),
            ['select:1-2', 'select:2-1'],
            `切节顺序不对: ${probe.log.join(' | ')}`
        );
        assert.ok(probe.log.includes('tab:2视频'), '应当点过“2视频”页签');
        assert.ok(probe.log.includes('test-next'), '应当跳过了章节测验');
        assert.equal(runner.sectionsDone, 3, '三节都应当播完');

        /* 起播靠真实点击，没有退回 video.play() */
        assert.equal(probe.realPlayClicks, 3, `三次起播都应当是真实点击，实际 ${probe.realPlayClicks}`);
        assert.equal(probe.scriptedPlays, 0, '不应退回 video.play()');

        /* 目录被真的滚动过（最后一节在视口外） */
        assert.ok(probe.wheels > 0, '应当产生过真实滚轮事件');
    } finally {
        /* 顺序要紧：先关浏览器，再关 server，否则连接一直挂着 */
        await context.close();
        await server.close();
        await rm(profileDir, { recursive: true, force: true });
    }
});

test('特征自检：webdriver 为 false，探针点击可信', async (t) => {
    const launched = await launch();
    if (launched.skip) return t.skip(launched.skip);
    const { context, profileDir } = launched;
    const server = await startFixtureServer();
    const log = createLogger('silent');

    try {
        const page = await context.newPage();
        await page.goto(server.url, { waitUntil: 'domcontentloaded' });
        const pointer = createPointer(page);
        await hardenFocus(page, log);

        const fingerprint = await collectFingerprint(page);
        assert.equal(fingerprint['navigator.webdriver'], false, '加了 AutomationControlled 之后应为 false');
        /* 这里是 headless 测试环境，UA 里确实带 HeadlessChrome。
         * 这正是 launchOptions() 坚持 headless: false 的原因——真实运行时不会有这一项。 */
        assert.equal(fingerprint['userAgent 含 Headless'], true, '无头环境下应当如实暴露');
        assert.equal(fingerprint['isTrusted 仍不可伪造'], true, 'isTrusted 应当仍是不可配置的');

        const probe = await probeTrustedInput(page, pointer);
        assert.equal(probe.isTrusted, true, '真实点击应当是可信事件');
        assert.equal(probe.isTrustedTampered, false, 'isTrusted 不应被动过手脚（真实事件实例上本就有这个属性）');
        assert.equal(probe.detail, 1, 'click 的 detail 应为 1');
        assert.ok(probe.movementSeen > 0, '点击之前应当有真实的 mousemove');
        assert.match(String(probe.sourceCapabilities), /InputDeviceCapabilities/, '应当带 sourceCapabilities');

        /* 探针层必须被清理干净 */
        const leftover = await page.evaluate(() => Boolean(document.getElementById('__pw_probe_layer')));
        assert.equal(leftover, false, '探针层应当已移除');
    } finally {
        /* 顺序要紧：先关浏览器，再关 server，否则连接一直挂着 */
        await context.close();
        await server.close();
        await rm(profileDir, { recursive: true, force: true });
    }
});

test('失焦之后 hasFocus 仍为 true，播放不受影响', async (t) => {
    const launched = await launch();
    if (launched.skip) return t.skip(launched.skip);
    const { context, profileDir } = launched;
    const server = await startFixtureServer();
    const log = createLogger('silent');

    try {
        const page = await context.newPage();
        await page.goto(server.url, { waitUntil: 'domcontentloaded' });
        await hardenFocus(page, log);

        await page.evaluate(() => {
            window.__blurs = 0;
            window.addEventListener('blur', () => { window.__blurs += 1; });
        });

        /* 开另一个标签页并切到前台，模拟用户去干别的事 */
        const other = await context.newPage();
        await other.goto('about:blank');
        await other.bringToFront();
        await new Promise((done) => setTimeout(done, 400));

        const state = await page.evaluate(() => ({
            hasFocus: document.hasFocus(),
            blurs: window.__blurs,
        }));
        assert.equal(state.hasFocus, true, '焦点模拟下 hasFocus() 应当仍为 true');
        assert.equal(state.blurs, 0, '不应触发 blur');

        await other.close();
    } finally {
        /* 顺序要紧：先关浏览器，再关 server，否则连接一直挂着 */
        await context.close();
        await server.close();
        await rm(profileDir, { recursive: true, force: true });
    }
});


/* ------------------------------------------------------------------
 * 新布局(mooc2): 照真实页面实测的结构。
 * 1.1 视频已完成、只剩章节测验; 1.2、2.1 视频不是任务点(目录上 0 个);
 * 2.2 视频没看完; 2.3 全部完成。
 * 播放器桩上, 已结束视频的控制栏按钮是"重播", 点它会从头再放(记进 replays)。
 * ------------------------------------------------------------------ */
async function runMooc2(t, overrides, query = '') {
    const launched = await launch();
    if (launched.skip) return t.skip(launched.skip);
    const { context, profileDir } = launched;
    const server = await startFixtureServer({ layout: 'mooc2' });
    const log = createLogger('silent');
    try {
        const page = await context.newPage();
        await page.goto(server.url + query, { waitUntil: 'domcontentloaded' });
        const pointer = createPointer(page, { x: 0, y: 0 });
        const runner = new CourseRunner({ page, pointer, config: { ...fast, jobsWaitMs: 4000, ...overrides }, log });
        await runner.run();
        return { probe: await page.evaluate(() => window.__probe), runner };
    } finally {
        await context.close();
        await server.close();
        await rm(profileDir, { recursive: true, force: true });
    }
}

test('mooc2: 只剩计分测验的小节按默认配置跳过, 加 --no-auto-advance-no-video 才停下', async (t) => {
    /* 计分的测验我们不代做, 也不该卡在那里: 默认跳过去找下一个有视频的小节 */
    const out = await runMooc2(t, { autoAdvanceNoVideo: false });
    if (!out) return;
    const { probe } = out;
    assert.equal(probe.replays, 0, `不应重放已完成的视频: ${probe.log.join(' | ')}`);
    assert.equal(probe.realPlayClicks, 0, '这一节没有要播的视频');
    assert.deepEqual(probe.log.filter((e) => e.startsWith('open:')), ['open:A'], '关掉之后应当停在 1.1');
    assert.deepEqual(probe.rejected, []);
});

test('mooc2: 默认跳过已完成和只剩测验的小节、真实点击播完没看的那一节', async (t) => {
    const out = await runMooc2(t, {});
    if (!out) return;
    const { probe, runner } = out;
    assert.deepEqual(probe.rejected, [], `出现不可信事件: ${probe.rejected}`);
    assert.equal(probe.replays, 0, `不应重放已完成的视频: ${probe.log.join(' | ')}`);
    /* 1.2、2.1 没有任务点, 2.3 已完成: 都不进去, 直接从 1.1 跳到 2.2 */
    assert.deepEqual(probe.log.filter((e) => e.startsWith('open:')), ['open:A', 'open:B']);
    assert.ok(probe.log.includes('play:big:B'), `2.2 应当真实点大播放按钮起播: ${probe.log.join(' | ')}`);
    assert.ok(probe.log.includes('ended:B'), '2.2 应当播完');
    /* 实测外放过一次: 静音必须在第一次起播点击之前 */
    const mutedAt = probe.log.indexOf('muted:B');
    assert.ok(mutedAt >= 0 && mutedAt < probe.log.indexOf('play:big:B'), `应当先静音再起播: ${probe.log.join(' | ')}`);
    assert.equal(probe.scriptedPlays, 0, '不应退回 video.play()');
    /* 倍速走播放器自己的菜单: 先点开菜单, 再点最高的那一档 */
    assert.ok(probe.log.includes("rate-menu-open"), `应当点开倍速菜单: ${probe.log.join(" | ")}`);
    assert.ok(probe.log.includes("rate:2:B"), `应当切到菜单里最高的 2x: ${probe.log.join(" | ")}`);
    /* 控制栏起播前是 display:none(真实页面实测), 所以倍速只能起播之后调 */
    assert.ok(probe.log.indexOf('play:big:B') < probe.log.indexOf('rate:2:B'), '倍速应当在起播之后调');
    assert.equal(runner.sectionsDone, 1, '只有 2.2 是真正放了视频的');
});

test('mooc2: 目录侧栏收起时先真实点开, 再点目标小节', async (t) => {
    /* 实测: 侧栏收起后滑到视口外, 以前的点击落在视口外、页面不动, 工具在同一节上打转 */
    const out = await runMooc2(t, { autoAdvanceNoVideo: true }, '&collapsed=1');
    if (!out) return;
    const { probe } = out;
    assert.deepEqual(probe.rejected, [], `出现不可信事件: ${probe.rejected}`);
    assert.ok(probe.log.includes('catalog-open'), `应当先点开目录: ${probe.log.join(' | ')}`);
    assert.deepEqual(probe.log.filter((e) => e.startsWith('open:')), ['open:A', 'open:B']);
    assert.ok(probe.log.includes('play:big:B'));
    assert.equal(probe.replays, 0);
});

test('mooc2: 卡片还是上一节的内容时不读, 等它换成当前小节再判断', async (t) => {
    /* 激活项先变、卡片 2.5 秒后才换。没有归属检查时, 2.2 会读到 1.1 的
     * "视频已完成"被直接跳过, 2.2 的视频永远不会被播 */
    const out = await runMooc2(t, { autoAdvanceNoVideo: true, jobsWaitMs: 6000 }, '&slowcards=1');
    if (!out) return;
    const { probe } = out;
    assert.deepEqual(probe.rejected, []);
    assert.ok(probe.log.includes('play:big:B'), `2.2 的视频应当被播放, 而不是被当成已完成: ${probe.log.join(' | ')}`);
    assert.ok(probe.log.includes('ended:B'));
    assert.equal(probe.replays, 0);
});

test('mooc2: 视频不是任务点时不播, 跳到下一个有待完成任务点的小节', async (t) => {
    /* 实测《微积分B》: 大部分小节的视频没有 .ans-job-icon, 目录上是 0 个任务点 */
    const out = await runMooc2(t, {}, '&start=D');
    if (!out) return;
    const { probe, runner } = out;
    assert.deepEqual(probe.rejected, []);
    assert.equal(probe.log.some((e) => e.startsWith('play:') && e.endsWith(':D')), false, `不是任务点的视频不应被播放: ${probe.log.join(' | ')}`);
    assert.deepEqual(probe.log.filter((e) => e.startsWith('open:')), ['open:D', 'open:B'], '应当越过 2.1 直接到 2.2');
    assert.ok(probe.log.includes('play:big:B'));
    assert.ok(probe.log.includes('ended:B'));
    assert.equal(runner.sectionsDone, 1);
});

test('mooc2: --no-mute 时不动静音状态', async (t) => {
    const out = await runMooc2(t, { mute: false }, '&start=D');
    if (!out) return;
    const { probe } = out;
    assert.ok(probe.log.includes('play:big:B'));
    assert.equal(probe.log.some((e) => e.startsWith('muted:')), false, `不应静音: ${probe.log.join(' | ')}`);
});

async function freePort() {
    const server = createServer();
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address();
    await new Promise((done) => server.close(done));
    return port;
}

test('一键启动：连不上时自己开专用 Chrome，打开起始页，webdriver 为 false', async (t) => {
    if (!findBrowser({ browser: 'chrome' })) return t.skip('本机没有 Chrome');
    let chromium;
    try {
        ({ chromium } = await import('playwright-core'));
    } catch (e) {
        return t.skip('未安装 playwright-core');
    }
    const server = await startFixtureServer({ layout: 'mooc2' });
    const profileDir = await mkdtemp(join(tmpdir(), 'xxt-launch-'));
    const port = await freePort();
    let pid = null;
    let browser = null;
    try {
        /* 真实运行时不带 --headless，这里只是为了测试时不弹窗 */
        ({ pid } = await launchDedicatedBrowser(
            { ...defaults, cdpPort: port, browser: 'chrome', browserProfile: profileDir },
            createLogger('silent'),
            { url: server.url, extraArgs: ['--headless=new'] },
        ));
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        /* 只认 chaoxing.com 的 pickCoursePage 不适用于本地桩（单元测试里另测），这里直接找 */
        let page = null;
        for (let i = 0; i < 40 && !page; i += 1) {
            page = browser.contexts()[0].pages().find((p) => p.url().startsWith(server.url.split('?')[0]));
            if (!page) await new Promise((done) => setTimeout(done, 250));
        }
        assert.ok(page, '专用 Chrome 应当打开了起始页');
        assert.equal(await page.evaluate(() => navigator.webdriver), false, '自己启动的 Chrome 不应带自动化标志');
    } finally {
        /* 真正把浏览器关掉要走 CDP 的 Browser.close：
         * 管理员身份下 Chrome 会先降权再重启一次, 我们 spawn 到的那个 pid 早就退了,
         * process.kill 杀不到真正的浏览器, 进程留着不放手, profile 目录就删不掉(EBUSY)。 */
        if (browser) {
            await browser.newBrowserCDPSession()
                .then((cdp) => cdp.send('Browser.close'))
                .catch(() => {});
            await browser.close().catch(() => {});
        }
        if (pid) { try { process.kill(pid); } catch (e) { /* 已经退出 */ } }
        await server.close();
        await new Promise((done) => setTimeout(done, 800));
        /* Windows 上句柄释放有延迟, 给几次重试 */
        await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
});
