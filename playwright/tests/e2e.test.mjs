/* ------------------------------------------------------------------
 * 端到端：用本机真实 Chrome 跑完整流程
 *
 * 桩页面（fixtures/workspace.html）照真实页面实测的结构搭，并且只接受 isTrusted
 * 的事件，合成事件一律记进 rejected 且不产生效果。所以这里通过就说明：点目录、
 * 展开知识点、点播放、滚轮，全都是浏览器自己构造的可信事件。
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
import { LearningRunner } from '../src/learning.mjs';
import { createLogger } from '../src/logger.mjs';
import { defaults } from '../src/config.mjs';
import { launchDedicatedBrowser } from '../src/browser.mjs';
import { findBrowser } from '../src/platform.mjs';
import { createServer } from 'node:net';

const fast = {
    ...defaults,
    startupDelayMs: [40, 120],
    pollIntervalMs: 160,
    itemPauseMs: [60, 160],
    itemLoadMs: [150, 300],
    expandWaitMs: [150, 300],
    guardNoProgressMs: 2500,
    resumeCooldownMs: 900,
    longBreakChance: 0,
    idleActivityMs: [250, 500],
    videoWaitMs: 6000,
    itemSwitchWaitMs: 4000,
    catalogTimeoutMs: 15000,
    articleReadMs: [500, 800],
    articleScrollMs: [150, 300],
};

async function launch() {
    let chromium;
    try {
        ({ chromium } = await import('playwright-core'));
    } catch (e) {
        return { skip: '未安装 playwright-core（在 playwright/ 下执行 npm install）' };
    }
    const profileDir = await mkdtemp(join(tmpdir(), 'ykt-e2e-'));
    try {
        const context = await chromium.launchPersistentContext(profileDir, {
            channel: 'chrome',
            headless: true,
            viewport: { width: 1280, height: 760 },
            ignoreDefaultArgs: ['--enable-automation'],
            args: ['--disable-blink-features=AutomationControlled', '--mute-audio'],
        });
        return { context, profileDir };
    } catch (e) {
        await rm(profileDir, { recursive: true, force: true });
        return { skip: `起不来本机 Chrome：${e.message.split('\n')[0]}` };
    }
}

async function runFixture(t, overrides = {}, query = '') {
    const launched = await launch();
    if (launched.skip) return t.skip(launched.skip);
    const { context, profileDir } = launched;
    const server = await startFixtureServer();
    try {
        const page = await context.newPage();
        await page.goto(server.url + query, { waitUntil: 'domcontentloaded' });
        const pointer = createPointer(page, { x: 0, y: 0 });
        const runner = new LearningRunner({ page, pointer, config: { ...fast, ...overrides }, log: createLogger('silent') });
        await runner.run();
        return { probe: await page.evaluate(() => window.__probe), runner };
    } finally {
        await context.close();
        await server.close();
        await rm(profileDir, { recursive: true, force: true });
    }
}

test('完整流程：放完当前视频，展开折叠的知识点，依次学完后面的，最后回头补前面的图文', async (t) => {
    const out = await runFixture(t);
    if (!out) return;
    const { probe, runner } = out;
    const log = probe.log.join(' | ');
    assert.deepEqual(probe.rejected, [], `出现了不可信事件: ${probe.rejected}`);

    /* 已完成的 V1、课堂 C1/C2 不进去；V3 藏在折叠节点里，要先展开 */
    assert.deepEqual(
        probe.log.filter((e) => e.startsWith('open:') || e.startsWith('expand:')),
        ['open:V2', 'expand:二、折叠着的知识点', 'open:V3', 'open:V4', 'open:A1', 'open:R1'],
        `顺序不对: ${log}`,
    );
    for (const id of ['V2', 'V3', 'V4']) {
        const played = probe.log.indexOf(`play:big:${id}`);
        assert.ok(played >= 0, `${id} 应当真实点大播放按钮起播: ${log}`);
        const muted = probe.log.indexOf(`muted:${id}`);
        assert.ok(muted >= 0 && muted < played, `${id} 应当先静音再起播: ${log}`);
        assert.ok(probe.log.includes(`ended:${id}`), `${id} 应当播完`);
    }
    assert.equal(probe.scriptedPlays, 0, '不应退回 video.play()');
    /* 倍速走播放器自己的菜单, 切到最高的一档 */
    assert.ok(probe.log.includes('rate:2:V2'), `应当切到菜单里最高的 2x: ${log}`);
    /* 起播前 .status-box 遮罩盖住整个播放器, 控制栏点不到, 所以倍速在起播之后调 */
    assert.ok(probe.log.indexOf('play:big:V2') < probe.log.indexOf('rate:2:V2'), '倍速应当在起播之后调');
    assert.ok(probe.log.indexOf('rate:2:V2') < probe.log.indexOf('ended:V2'), '倍速应当在播完之前调好');
    assert.ok(probe.wheels > 0, '应当用真实滚轮滚过目录或图文');
    assert.equal(runner.itemsDone, 5, '三个视频加两篇图文');
});

test('--no-articles 只看视频，图文不进去', async (t) => {
    const out = await runFixture(t, { articles: false });
    if (!out) return;
    const { probe } = out;
    assert.deepEqual(probe.rejected, []);
    assert.deepEqual(probe.log.filter((e) => e.startsWith('open:')), ['open:V2', 'open:V3', 'open:V4']);
});

test('--max-items 到上限就停在这一项，不先点进下一项', async (t) => {
    const out = await runFixture(t, { maxItems: 1 });
    if (!out) return;
    const { probe, runner } = out;
    assert.deepEqual(probe.log.filter((e) => e.startsWith('open:')), ['open:V2']);
    assert.ok(probe.log.includes('ended:V2'));
    assert.equal(runner.itemsDone, 1);
});

test('--no-mute 时不动静音状态', async (t) => {
    const out = await runFixture(t, { mute: false, maxItems: 1 });
    if (!out) return;
    const { probe } = out;
    assert.ok(probe.log.includes('play:big:V2'));
    assert.equal(probe.log.some((e) => e.startsWith('muted:')), false, `不应静音: ${probe.log.join(' | ')}`);
});

test('当前项已经完成时不重放，直接去下一个没完成的', async (t) => {
    const out = await runFixture(t, { maxItems: 1 }, '?start=V1');
    if (!out) return;
    const { probe } = out;
    assert.equal(probe.log.some((e) => e.endsWith(':V1') && e.startsWith('play:')), false, `不应重放 V1: ${probe.log.join(' | ')}`);
    assert.deepEqual(probe.log.filter((e) => e.startsWith('open:')), ['open:V1', 'open:V2']);
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
    const server = await startFixtureServer();
    const profileDir = await mkdtemp(join(tmpdir(), 'ykt-launch-'));
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
        let page = null;
        for (let i = 0; i < 40 && !page; i += 1) {
            page = browser.contexts()[0].pages().find((p) => p.url().includes('/ai-workspace/lms-graph/'));
            if (!page) await new Promise((done) => setTimeout(done, 250));
        }
        assert.ok(page, '专用 Chrome 应当打开了起始页');
        assert.equal(await page.evaluate(() => navigator.webdriver), false);
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

test('另一套播放器(xtplayer)：同样能识别、起播、切倍速', async (t) => {
    /* 实测这门课里两套播放器混着用: 数字人播放器是 video#video, 另一套是
     * video.xt_video_player(id 动态生成)。只认前者时, 后者的视频会被判成
     * "视频没加载"——哪怕它正在播。桩里 V2 用数字人, 其余用 xtplayer。 */
    const out = await runFixture(t, { maxItems: 1 }, '?start=V4');
    if (!out) return;
    const { probe, runner } = out;
    const log = probe.log.join(' | ');
    assert.deepEqual(probe.rejected, [], `出现了不可信事件: ${probe.rejected}`);
    assert.ok(probe.log.includes('play:big:V4'), `应当真实点大播放按钮起播: ${log}`);
    /* 这套播放器有看门狗，直接设 muted 会被它改回去，必须点它自己的音量按钮 */
    assert.ok(probe.log.includes('mute-reset:V4'), `桩应当复现看门狗把 muted 改回去: ${log}`);
    assert.ok(probe.log.includes('volume-click:V4'), `应当回退去点播放器的音量按钮: ${log}`);
    assert.ok(probe.log.indexOf('volume-click:V4') < probe.log.indexOf('play:big:V4'),
        `静音要在起播之前保持住，不能先带着声音播再补救: ${log}`);
    assert.ok(probe.log.includes('muted:V4'), `最终应当是静音的: ${log}`);
    assert.ok(probe.log.includes('rate:2:V4'), `应当切到菜单里最高的 2x: ${log}`);
    assert.ok(probe.log.includes('ended:V4'), `应当播完: ${log}`);
    assert.equal(probe.scriptedPlays, 0, '不应退回 video.play()');
    assert.equal(runner.itemsDone, 1);
});
