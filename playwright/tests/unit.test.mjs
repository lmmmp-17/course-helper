/* 不需要浏览器的部分：选下一项、参数解析、节奏、平台提示 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { human } from '../src/human.mjs';
import { createPointer } from '../src/pointer.mjs';
import { parseArgs, defaults } from '../src/config.mjs';
import { isAllowedUrl } from '../src/selectors.mjs';
import { LearningRunner, keyEntries, pickNext } from '../src/learning.mjs';
import { createLogger } from '../src/logger.mjs';
import { launchHint, findBrowser, browserCandidates, dedicatedArgs, sideProfileDir } from '../src/platform.mjs';
import { launchOptions, launchDedicatedBrowser, pickCoursePage, openBrowser } from '../src/browser.mjs';
import { ensureInstalled } from '../src/setup.mjs';
import { createServer } from 'node:http';

const silent = createLogger('silent');
const leaf = (kind, title, extra = {}) => ({ type: 'leaf', kind, title, done: false, active: false, ...extra });
const node = (title) => ({ type: 'node', title });

test('选下一项：越过已完成的和课堂，取第一个没完成的视频', () => {
    const entries = keyEntries([
        leaf('视频', 'A', { active: true }),
        leaf('视频', 'B', { done: true }),
        leaf('课堂', 'C'),
        leaf('视频', 'D'),
    ]);
    assert.equal(pickNext(entries).target.title, 'D');
});

test('选下一项：折叠的知识点排在前面时先展开它', () => {
    /* 实测：折叠节点下的学习项不渲染，不展开就永远看不到 */
    const entries = keyEntries([leaf('视频', 'A', { active: true }), node('二、折叠的'), leaf('视频', 'D')]);
    const first = pickNext(entries);
    assert.equal(first.target.type, 'node');
    const second = pickNext(entries, { expanded: new Set([first.target.key]) });
    assert.equal(second.target.title, 'D', '展开过的节点不再展开第二次');
});

test('选下一项：后面都没有了就回到前面；这一轮开过的不再开', () => {
    const entries = keyEntries([leaf('图文', 'R'), leaf('视频', 'A', { active: true }), leaf('视频', 'B', { done: true })]);
    const picked = pickNext(entries);
    assert.equal(picked.target.title, 'R');
    assert.equal(picked.wrapped, true);
    assert.equal(pickNext(entries, { attempted: new Set([picked.target.key]) }).target, null);
    assert.equal(pickNext(entries, { articles: false }).target, null, '--no-articles 时图文不算');
});

test('同名条目的 key 互不相同，并且插入新条目后不变', () => {
    const before = keyEntries([leaf('视频', '同名'), leaf('视频', '同名')]);
    assert.notEqual(before[0].key, before[1].key);
    const after = keyEntries([leaf('视频', '同名'), leaf('视频', '新插入'), leaf('视频', '同名')]);
    assert.equal(after[2].key, before[1].key);
});

test('参数：默认静音、看图文；--no-mute / --no-articles / --max-items', () => {
    assert.equal(parseArgs([]).config.mute, true);
    assert.equal(parseArgs([]).config.articles, true);
    assert.equal(parseArgs(['--no-mute']).config.mute, false);
    assert.equal(parseArgs(['--no-articles']).config.articles, false);
    assert.equal(parseArgs(['--max-items', '2']).config.maxItems, 2);
    assert.throws(() => parseArgs(['--max-itmes', '2']), /无法识别/);
});

test('只接受 yuketang.cn 的地址', () => {
    assert.equal(isAllowedUrl('https://changjiang.yuketang.cn/ai-workspace/lms-graph/1/video/2'), true);
    assert.equal(isAllowedUrl('https://yuketang.cn.evil.com/'), false);
    assert.equal(isAllowedUrl('file:///etc/passwd'), false);
});

test('启动提示和 launch 模式都在浏览器这一层静音', () => {
    assert.match(launchHint(9222), /--mute-audio/);
    assert.match(launchHint(9222), /yuketang-chrome/);
    assert.match(launchHint(9222), /--disable-backgrounding-occluded-windows/, 'Windows 上窗口被盖住会变 hidden，手动命令也得带');
    assert.match(launchHint(9222, 'edge'), /yuketang-edge/, 'Edge 用自己的 profile 目录');
    assert.match(launchHint(9222, 'edge'), /--disable-features=msImplicitSignin\S* --disable-sync/, '手动命令也要关掉自动登录和同步');
    const edgeArgs = dedicatedArgs({ port: 1, profileDir: '/p', kind: 'edge' });
    assert.ok(edgeArgs.includes('--disable-sync'));
    assert.equal(edgeArgs.filter((x) => x.startsWith('--disable-features=')).length, 1);
    assert.equal(dedicatedArgs({ port: 1, profileDir: '/p' }).some((x) => /disable-sync|disable-features/.test(x)), false, 'Edge 独有的开关不加给 Chrome');
    assert.equal(launchOptions({ kind: 'edge' }).channel, 'msedge');
    assert.ok(launchOptions().args.includes('--mute-audio'));
    assert.equal(launchOptions({ mute: false }).args.includes('--mute-audio'), false);
    assert.ok(launchOptions().ignoreDefaultArgs.includes('--enable-automation'));
    assert.equal(launchOptions().headless, false);
});

test('指针微动的间隔铺满配置区间, 不被轮询压成固定节拍', async () => {
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
        const fired = [];
        const runner = new LearningRunner({
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
    } finally {
        Date.now = realNow;
    }
});

test('播放中页面被关掉: 如实停下, 不算这一项完成', async () => {
    const page = {
        isClosed: () => true,
        locator: () => ({ first: () => ({ evaluate: async () => { throw new Error('Target page, context or browser has been closed'); } }) }),
    };
    const runner = new LearningRunner({ page, pointer: {}, config: { ...defaults, pollIntervalMs: 5 }, log: silent });
    assert.equal(await runner.watchUntilEnd(), 'stopped');
    assert.equal(runner.stopped, true);
    assert.equal(runner.itemsDone, 0);
});

test('目录暂时读不到（平台重新渲染）时等一会儿再读，不一次失败就停', async () => {
    let calls = 0;
    const page = {
        async evaluate() {
            calls += 1;
            if (calls < 3) throw new Error('Execution context was destroyed');
            return [{ type: 'leaf', index: 0, kind: '视频', title: 'A', done: false, active: true }];
        },
    };
    const runner = new LearningRunner({ page, pointer: {}, config: defaults, log: silent });
    const entries = await runner.readCatalogSettled(5000);
    assert.equal(entries.length, 1);
    assert.equal(calls, 3);
});

test('播放中但在缓冲时只等着，不去点播放键；缓冲太久才停下', async () => {
    /* 实测: readyState 1、seeking、paused 为 false, 约 50 秒后自己恢复 */
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
        const state = { currentTime: 0, duration: 1861, paused: false, ended: false, muted: true, readyState: 1, seeking: true };
        const page = { isClosed: () => false, locator: () => ({ first: () => ({ evaluate: async () => { now += 1300; return { ...state }; } }) }) };
        const runner = new LearningRunner({ page, pointer: { async drift() {} }, config: { ...defaults, pollIntervalMs: 1, idleActivity: false }, log: silent });
        let clicks = 0;
        runner.startPlayback = async () => { clicks += 1; return true; };
        assert.equal(await runner.watchUntilEnd(), 'stopped');
        assert.equal(clicks, 0, '缓冲中不应去点播放键');
        assert.ok(now - 1_000_000 >= defaults.bufferingTimeoutMs, '应当等满缓冲超时才停');
    } finally {
        Date.now = realNow;
    }
});

test('等待时长的离散度贴近真人实测值；指针起点是 (0,0)', () => {
    /* 本地靶场实测：真人连续操作的间隔变异系数是 0.45~0.49，均匀取值只有 0.17~0.28 */
    for (const spec of [[2600, 9000], 1000]) {
        const xs = Array.from({ length: 20000 }, () => human.ms(spec));
        const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
        const cv = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)) / mean;
        assert.ok(cv > 0.40 && cv < 0.55, `${JSON.stringify(spec)} 的 CV 实际 ${cv.toFixed(3)}`);
    }
    const pointer = createPointer({ viewportSize: () => ({ width: 1280, height: 800 }), mouse: {} });
    assert.deepEqual([pointer.state.x, pointer.state.y], [0, 0]);
});

test('找浏览器：Windows / macOS 看固定位置，Linux 在 PATH 里找，--browser-path 优先', () => {
    const win = browserCandidates('chrome', 'win32', { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' });
    assert.equal(win[0], 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    const linux = findBrowser({ platform: 'linux', env: { PATH: '/nope:/opt/bin' }, exists: (p) => p === '/opt/bin/chromium' });
    assert.deepEqual(linux, { kind: 'chrome', exe: '/opt/bin/chromium' });
    assert.equal(findBrowser({ configured: '/missing', exists: () => false }), null);
});

test('Edge：没装 Chrome 时 auto 用 Edge；明确选了哪个就只找哪个；profile 分开', () => {
    const env = { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)' };
    const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const onlyEdge = (p) => p === edgeExe;
    assert.deepEqual(findBrowser({ platform: 'win32', env, exists: onlyEdge }), { kind: 'edge', exe: edgeExe });
    assert.equal(findBrowser({ browser: 'chrome', platform: 'win32', env, exists: onlyEdge }), null, '选了 Chrome 就不悄悄换成 Edge');
    assert.equal(findBrowser({ platform: 'win32', env, exists: () => true }).kind, 'chrome', 'auto 两个都有时用 Chrome');
    assert.match(sideProfileDir('chrome'), /yuketang-chrome$/, 'Chrome 沿用原来的目录，已经登录过的不用重登');
    assert.match(sideProfileDir('edge'), /yuketang-edge$/);
    assert.throws(() => parseArgs(['--browser', 'firefox']), /--browser 只能是/);
    assert.equal(parseArgs(['--browser', 'Edge']).config.browser, 'edge');
    assert.equal(parseArgs(['--chrome-path', '/x']).config.browserPath, '/x', '旧参数名照旧能用');
});

test('端口上开着另一种浏览器时不悄悄接管，说清楚怎么办', async () => {
    const server = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ Browser: 'Edg/141.0.3537.71', 'User-Agent': 'Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0' }));
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    try {
        await assert.rejects(
            openBrowser({ ...defaults, cdpPort: server.address().port, browser: 'chrome' }, silent),
            /开着的是 Edge，不是你选的 Chrome.*--cdp-port/s,
        );
    } finally {
        server.close();
    }
});

test('自动启动专用浏览器：参数和手动命令同一组、静音、独立进程', async () => {
    const args = dedicatedArgs({ port: 9222, profileDir: '/home/u/yuketang-chrome', url: 'https://changjiang.yuketang.cn/' });
    assert.ok(args.includes('--mute-audio'));
    assert.ok(args.includes('--disable-backgrounding-occluded-windows'), 'Windows 上窗口被盖住会变 hidden，视频直接停');
    assert.equal(args.some((a) => /automation|headless|webdriver/i.test(a)), false);

    const server = createServer((req, res) => { res.writeHead(200); res.end('{}'); });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    let call = null;
    try {
        await launchDedicatedBrowser(
            { ...defaults, cdpPort: server.address().port, browserPath: process.execPath, browserProfile: '/tmp/p' },
            silent,
            { spawnProcess(exe, a, options) { call = { a, options }; return { pid: 1, on() {}, unref() {} }; } },
        );
    } finally {
        server.close();
    }
    assert.equal(call.options.detached, true);
    assert.equal(call.a.at(-1), 'https://changjiang.yuketang.cn/', '默认打开雨课堂首页');
});

test('没有学习空间页面时一直等，用户点开视频后自动接管；Ctrl+C 能退出', async () => {
    const pages = [{ url: () => 'https://changjiang.yuketang.cn/v2/web/index' }];
    const target = {
        url: () => 'https://changjiang.yuketang.cn/ai-workspace/lms-graph/1/video/2?node_id=3',
        async waitForLoadState() {},
        async bringToFront() {},
    };
    setTimeout(() => pages.push(target), 400);
    assert.equal(await pickCoursePage({ pages: () => pages }, { ...defaults }, silent, { stopped: false }), target);

    const abort = { stopped: false };
    setTimeout(() => { abort.stopped = true; }, 300);
    await assert.rejects(pickCoursePage({ pages: () => [] }, { ...defaults }, silent, abort), /已退出/);
});

test('第一次运行自动安装依赖；装过就不再装；失败时给出镜像提示', () => {
    const calls = [];
    const ok = (cmd, options) => { calls.push({ cmd, options }); return { status: 0 }; };
    assert.equal(ensureInstalled(silent, { dir: '/nonexistent-dir', run: ok }), true);
    assert.equal(calls[0].options.shell, true);
    assert.equal(ensureInstalled(silent, { run: ok }), false);
    assert.throws(() => ensureInstalled(silent, { dir: '/nonexistent-dir', run: () => ({ status: 1 }) }), /npmmirror/);
});

test('默认调试端口和学习通（9222）、智慧树连接模式（9224）错开，三个工具能同时跑', () => {
    assert.equal(defaults.cdpPort, 9223);
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
