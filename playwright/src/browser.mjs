/* ------------------------------------------------------------------
 * 浏览器接入
 *
 * 两种模式，默认用第一种：
 *
 * Chrome 和 Edge 都行（--browser，默认 auto：有 Chrome 用 Chrome，没有用 Edge）。
 * 两者都是 Chromium 内核，下面说的每一条对 Edge 同样成立。
 *
 * 1. connect（推荐）：连接到你自己启动的 Chrome。
 *    浏览器是你平时用的那一个——真实 profile、真实登录态、真实扩展列表，
 *    navigator.webdriver 为 false，没有 --enable-automation 带来的那一串特征。
 *    Playwright 只是通过 CDP 接管输入，不参与浏览器的启动。
 *
 * 2. launch：让脚本自己拉起 Chrome。
 *    方便，但 Playwright 默认会带上 --enable-automation 等参数，所以这里显式
 *    去掉它们并关掉 AutomationControlled，同时坚持用本机真实 Chrome
 *    （channel: 'chrome' / 'msedge'）和持久化 profile，而不是 bundled Chromium + 临时目录。
 *    即便如此，它在特征上仍然不如模式 1，所以只作为备选。
 *
 * 两种模式都不跑 headless：无头浏览器的特征面比自动化标志本身还大。
 * ------------------------------------------------------------------ */
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { isAllowedUrl, HOME_URL, COURSE_PAGE } from './selectors.mjs';
import { BROWSERS, browserName, findBrowser, launchHint, sideProfileDir, dedicatedArgs } from './platform.mjs';
import { sleep } from './human.mjs';
import { keyHint } from './stop-signal.mjs';

async function loadPlaywright() {
    try {
        return await import('playwright-core');
    } catch (e) {
        const error = new Error(
            '未找到 playwright-core。重新运行 start 脚本（或 node run.mjs --setup）会自动安装。'
        );
        error.cause = e;
        throw error;
    }
}

/* 调试端口上有没有浏览器、是哪一种。Edge 的 User-Agent 里带 Edg/ */
export function kindOfVersion(version = {}) {
    return /\bEdg\//.test(`${version['User-Agent'] || ''} ${version.Browser || ''}`) ? 'edge' : 'chrome';
}

async function probeEndpoint(endpoint) {
    try {
        const res = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1500) });
        if (!res.ok) return null;
        return { kind: kindOfVersion(await res.json().catch(() => ({}))) };
    } catch (e) {
        return null;
    }
}

function missingBrowserMessage(config) {
    if (config.browserPath) {
        return `--browser-path 指定的 ${config.browserPath} 不存在或不能执行。`;
    }
    const where = '装在别的位置的话，用 --browser-path <可执行文件> 指定。';
    if (config.browser === 'chrome') return `没找到本机的 Google Chrome。装好后重新运行，或者用 --browser edge 改用 Edge；${where}`;
    if (config.browser === 'edge') return `没找到本机的 Microsoft Edge。装好后重新运行，或者用 --browser chrome 改用 Chrome；${where}`;
    return `没找到本机的 Chrome，也没找到 Edge。装好其中一个后重新运行；${where}`;
}

/* 连不上调试端口时，自己把专用浏览器开起来。
 *
 * 这和用户照 README 手动敲命令启动是同一件事：同一个独立 profile、同一组参数，
 * 只是由脚本代劳。浏览器是作为普通进程启动的，不经过 Playwright 的 launch，
 * 所以不会带上 --enable-automation 之类的参数。脚本退出时不关它（登录状态在里面）。 */
export async function launchDedicatedBrowser(config, log, { spawnProcess = spawn, extraArgs = [], url = HOME_URL, find = findBrowser } = {}) {
    const found = find({ browser: config.browser, configured: config.browserPath });
    if (!found) throw new Error(missingBrowserMessage(config));
    const { kind, exe } = found;
    const name = browserName(kind);
    const profileDir = config.browserProfile ? resolve(config.browserProfile) : sideProfileDir(kind);
    const args = [...dedicatedArgs({ port: config.cdpPort, profileDir, mute: config.mute, url, kind }), ...extraArgs];
    log.say(`启动专用 ${name}（独立 profile：${profileDir}${config.mute ? '，静音' : ''}）`);
    const child = spawnProcess(exe, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();

    const endpoint = `http://127.0.0.1:${config.cdpPort}`;
    const deadline = Date.now() + (config.chromeStartTimeoutMs ?? 30000);
    while (Date.now() < deadline) {
        if (await probeEndpoint(endpoint)) return { pid: child.pid, kind };
        await sleep(400);
    }
    throw new Error(
        `${name} 启动了，但调试端口 ${config.cdpPort} 一直没打开。\n` +
        `最常见的原因：这个专用 ${name} 之前已经被手动打开过、而且没带调试端口。把所有 ${name} 窗口都关掉再运行一次。\n` +
        '端口被别的程序占用的话，用 --cdp-port 换一个，比如 --cdp-port 9333。'
    );
}

/* 启动参数单独拎出来，便于断言——这几项都不是随手写的：
 *   headless: false   无头浏览器的特征面比自动化标志本身还大，UA 里直接带
 *                     HeadlessChrome，还缺一堆真实窗口才有的东西
 *   channel           用本机真实 Chrome / Edge，而不是 Playwright 自带的 Chromium
 *   ignoreDefaultArgs 去掉 Playwright 默认加的 --enable-automation
 *   AutomationControlled 关掉之后 navigator.webdriver 才是 false
 *   viewport: null    跟随真实窗口尺寸，不要那个固定的 1280x720
 */
export function launchOptions({ mute = true, kind = 'chrome' } = {}) {
    return {
        channel: (BROWSERS[kind] || BROWSERS.chrome).channel,
        headless: false,
        viewport: null,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        ignoreDefaultArgs: ['--enable-automation', '--disable-component-update'],
        args: [
            '--disable-blink-features=AutomationControlled',
            '--start-maximized',
            /* 自己启动的专用 profile 顺手在浏览器这一层也静音: 页面读不到它
             * (muted / volume 都不变), 只是声音不送到声卡。Playwright 只在
             * 无头模式才默认带这一项。connect 模式管不到启动参数, 靠播放器上的静音。 */
            ...(mute ? ['--mute-audio'] : []),
            /* 这里不加 Edge 的 EDGE_ARGS：Playwright 自己会带一条 --disable-features，
             * 再写一条会把它整条盖掉（同名开关后一个生效）。它自带的那组里已经有
             * --disable-sync 和 msForceBrowserSignIn，但没有 msImplicitSignin。 */
        ],
    };
}

export async function openBrowser(config, log) {
    const { chromium } = await loadPlaywright();

    if (config.mode === 'launch') {
        /* profile 目录按绝对路径传，不然换个工作目录就换了一个 profile */
        const profileDir = resolve(config.profileDir);
        /* auto 时看本机装了哪个；指定了 --browser-path 也按它来 */
        const found = findBrowser({ browser: config.browser, configured: config.browserPath });
        const kind = found ? found.kind : (config.browser === 'edge' ? 'edge' : 'chrome');
        log.say(`启动本机 ${browserName(kind)}，profile: ${profileDir}`);
        const options = launchOptions({ mute: config.mute, kind });
        if (config.browserPath) options.executablePath = config.browserPath;
        const context = await chromium.launchPersistentContext(profileDir, options);
        /* Playwright 的默认操作超时是“不限”，元素一直不出现就会无声地挂住 */
        context.setDefaultTimeout(config.actionTimeoutMs);
        return {
            context,
            owned: true,
            async close() {
                await context.close();
            },
        };
    }

    const endpoint = `http://127.0.0.1:${config.cdpPort}`;
    let launched = null;
    const running = await probeEndpoint(endpoint);
    /* 端口上已经开着另一种浏览器：多半是之前用另一种跑过、专用窗口还没关。
     * 明确选了浏览器就别悄悄接管另一种，说清楚怎么办；auto 时有哪个用哪个。 */
    if (running && config.browser !== 'auto' && running.kind !== config.browser) {
        throw new Error(
            `${endpoint} 上开着的是 ${browserName(running.kind)}，不是你选的 ${browserName(config.browser)}。\n` +
            `把那个专用 ${browserName(running.kind)} 窗口关掉再运行；或者用 --cdp-port 换一个端口，比如 --cdp-port 9333。`
        );
    }
    let kind = running ? running.kind : null;
    if (!running) {
        if (!config.autoLaunch) {
            const found = findBrowser({ browser: config.browser, configured: config.browserPath });
            const hintKind = found ? found.kind : (config.browser === 'edge' ? 'edge' : 'chrome');
            const name = browserName(hintKind);
            throw new Error(
                `连不上 ${endpoint}。请先这样启动一个可被接管的 ${name}：\n\n` +
                `  ${launchHint(config.cdpPort, hintKind, found ? found.exe : '')}\n\n` +
                `注意：如果 ${name} 已经在运行，直接加 --remote-debugging-port 是不会生效的——\n` +
                '参数会被转交给已有实例，端口上什么都没有。上面的命令用了一个独立的 profile\n' +
                '目录来绕开这一点，第一次需要在里面登录一次学习通。\n' +
                '然后在那个窗口里打开课程播放页，再重新运行本脚本。'
            );
        }
        launched = await launchDedicatedBrowser(config, log);
        kind = launched.kind;
    }
    log.say(`连接 ${browserName(kind)}: ${endpoint}`);
    let browser;
    try {
        browser = await chromium.connectOverCDP(endpoint);
    } catch (e) {
        throw new Error(`连不上 ${endpoint}：${e.message.split('\n')[0]}`);
    }
    const context = browser.contexts()[0];
    if (!context) throw new Error(`这个 ${browserName(kind)} 实例里没有可用的浏览上下文`);
    context.setDefaultTimeout(config.actionTimeoutMs);
    return {
        context,
        browser,
        owned: false,
        launchedBrowser: Boolean(launched),
        browserName: browserName(kind),
        /* 不是我们启动的浏览器就只断开连接，不去关别人的窗口 */
        async close() {
            await browser.close();
        },
    };
}

/* 优先接管已经打开的课程页。没有的话：给了 --url 就打开它，否则等用户在浏览器里
 * 登录、点开课程——以前这里直接报错退出，用户得开好页面再重新运行一遍。 */
export async function pickCoursePage(context, config, log, abort = { stopped: false }) {
    const find = () => context.pages().find((page) => isAllowedUrl(page.url()) && COURSE_PAGE.test(page.url()));
    const opened = find();
    if (opened) {
        log.say(`接管已打开的课程页: ${opened.url()}`);
        await opened.bringToFront();
        return opened;
    }

    if (config.url) {
        if (!isAllowedUrl(config.url)) {
            throw new Error(`--url 必须是 chaoxing.com 下的地址，拿到的是: ${config.url}`);
        }
        const pages = context.pages();
        const page = pages.find((item) => item.url() === 'about:blank') || await context.newPage();
        log.say(`打开课程页: ${config.url}`);
        await page.bringToFront();
        await page.goto(config.url, { waitUntil: 'domcontentloaded' });
        return page;
    }

    log.say(`请在浏览器里登录学习通，进入要学的课程，点开任意一节（播放页）。打开之后会自动开始${keyHint('，按 Ctrl+C 退出')}。`);
    const deadline = config.waitCourseMs > 0 ? Date.now() + config.waitCourseMs : Infinity;
    const waitingSince = Date.now();
    while (!abort.stopped && Date.now() < deadline) {
        await sleep(1500);
        /* 转一下让用户知道脚本还活着, 不是卡死了 */
        log.status(`⏳ 等你打开课程播放页…（已等 ${Math.round((Date.now() - waitingSince) / 1000)} 秒${keyHint('，Ctrl+C 退出')}）`);
        const page = find();
        if (page) {
            log.clearStatus();
            log.say(`找到课程页: ${page.url()}`);
            /* 页面刚开始加载，让它先稳一会儿再动手 */
            await page.waitForLoadState('domcontentloaded').catch(() => {});
            return page;
        }
    }
    log.clearStatus();
    throw new Error(abort.stopped ? '已退出' : '等了很久没有看到课程播放页，已退出。');
}
