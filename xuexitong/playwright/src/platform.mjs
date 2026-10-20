/* ------------------------------------------------------------------
 * 平台差异
 * Node 和 playwright-core 本身跨平台，需要分平台处理的只有两件事：
 * 浏览器（Chrome / Edge）可执行文件的位置，和 profile 目录的写法。
 * ------------------------------------------------------------------ */
import { homedir } from 'node:os';
import { accessSync, constants } from 'node:fs';
import { join, posix, win32 } from 'node:path';

const SIDE_PROFILE_BASE = 'xuexitong';

/* 支持的两种浏览器。都是 Chromium 内核，启动参数和 CDP 完全一样，
 * 差别只在装在哪儿、叫什么。Windows 上 Edge 是系统自带的，没装 Chrome 也能用。 */
export const BROWSERS = {
    chrome: {
        name: 'Chrome',
        /* Playwright 的 launch 模式用的 channel */
        channel: 'chrome',
        hint: {
            darwin: '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"',
            win32: '"%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe"',
            linux: 'google-chrome',
        },
    },
    edge: {
        name: 'Edge',
        channel: 'msedge',
        hint: {
            darwin: '"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"',
            win32: '"%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe"',
            linux: 'microsoft-edge',
        },
    },
};

/* --browser 的取值：auto 先找 Chrome，没有再找 Edge */
export const BROWSER_CHOICES = ['auto', 'chrome', 'edge'];

export function browserName(kind) {
    return BROWSERS[kind] ? BROWSERS[kind].name : '浏览器';
}

/* 用户用 --browser-path 指了一个可执行文件、又没说是哪种时，按文件名猜 */
export function kindOfPath(file) {
    return /msedge|microsoft[ -]edge/i.test(file) ? 'edge' : 'chrome';
}

/* 专用 profile 按浏览器分开放：Chrome 和 Edge 的 profile 格式不完全兼容，
 * 混用一个目录会把对方的数据「升级」坏。Chrome 沿用原来的目录名，已经登录过的不用重登。 */
export function sideProfileName(kind = 'chrome') {
    return `${SIDE_PROFILE_BASE}-${kind === 'edge' ? 'edge' : 'chrome'}`;
}

export function sideProfilePath(kind = 'chrome') {
    if (process.platform === 'win32') return `%USERPROFILE%\\${sideProfileName(kind)}`;
    return join(homedir(), sideProfileName(kind));
}

/* 专用 profile 的真实路径（自动启动浏览器时用；上面那个是给人抄的命令） */
export function sideProfileDir(kind = 'chrome') {
    return join(homedir(), sideProfileName(kind));
}

/* 本机某种浏览器可能在的位置。Linux 上的是命令名，要去 PATH 里找 */
export function browserCandidates(kind = 'chrome', platform = process.platform, env = process.env, home = homedir()) {
    if (platform === 'win32') {
        const programFiles = env.PROGRAMFILES || env.ProgramFiles;
        const programFilesX86 = env['PROGRAMFILES(X86)'] || env['ProgramFiles(x86)'];
        const roots = kind === 'edge'
            /* Edge 一直装在 Program Files (x86)，新一些的机器上也见过装在 Program Files */
            ? [programFilesX86, programFiles, env.LOCALAPPDATA]
            : [programFiles, programFilesX86, env.LOCALAPPDATA];
        const tail = kind === 'edge' ? ['Microsoft', 'Edge', 'Application', 'msedge.exe'] : ['Google', 'Chrome', 'Application', 'chrome.exe'];
        return roots.filter(Boolean).map((root) => win32.join(root, ...tail));
    }
    if (platform === 'darwin') {
        const app = kind === 'edge' ? 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge' : 'Google Chrome.app/Contents/MacOS/Google Chrome';
        return [posix.join('/Applications', app), posix.join(home, 'Applications', app)];
    }
    return kind === 'edge'
        ? ['microsoft-edge', 'microsoft-edge-stable']
        : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
}

/* 模拟别的平台时(单元测试)要用那个平台的分隔符, 不能用宿主机的:
 * Windows 上 delimiter 是 ';'、join 用 '\\', 拿来拆 Linux 的 PATH 会拆不开。 */
function pathUtil(platform) {
    return platform === 'win32' ? win32 : posix;
}

function executable(file) {
    try {
        accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return true;
    } catch (e) {
        return false;
    }
}

function findOne(kind, platform, env, exists) {
    for (const candidate of browserCandidates(kind, platform, env)) {
        const absolute = platform === 'win32' || candidate.includes('/');
        if (absolute) {
            if (exists(candidate)) return candidate;
            continue;
        }
        const path = pathUtil(platform);
        for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
            if (exists(path.join(dir, candidate))) return path.join(dir, candidate);
        }
    }
    return null;
}

/* 找到要用的浏览器，返回 { kind, exe }，都没有就是 null。
 *   browser     auto | chrome | edge。auto 先找 Chrome，没有再找 Edge
 *   configured  用户用 --browser-path 指定的可执行文件，优先用它；不存在就是 null，
 *               不悄悄换成别的 */
export function findBrowser({ browser = 'auto', configured = '', platform = process.platform, env = process.env, exists = executable } = {}) {
    if (configured) {
        if (!exists(configured)) return null;
        return { kind: browser === 'auto' ? kindOfPath(configured) : browser, exe: configured };
    }
    const kinds = browser === 'auto' ? ['chrome', 'edge'] : [browser];
    for (const kind of kinds) {
        const exe = findOne(kind, platform, env, exists);
        if (exe) return { kind, exe };
    }
    return null;
}

/* Edge 独有的几项。实测（Edge 155 / Win11，Windows 登录着微软账号）：只带
 * --no-first-run 时，Edge 会把这个全新的专用 profile 也用系统账号自动登录上，并打开
 * 全量同步——弹一个「正在你的所有设备上同步」的模态框把页面压暗，主账号的书签、密码、
 * 扩展同步进来，这边的浏览记录也同步回去。专用 profile 就不再独立了。
 *   msImplicitSignin      跟着系统账号自动登录
 *   msForceBrowserSignIn  强制登录（Playwright 启动 Edge 时也关这一项）
 *   --disable-sync        同步（Playwright 启动时也带）
 * 都只改浏览器自己的行为，页面上看不到。用组策略也能关，但那会连用户自己的 Edge 一起改。 */
export const EDGE_ARGS = ['--disable-features=msImplicitSignin,msForceBrowserSignIn', '--disable-sync'];

/* 自动启动专用浏览器时的参数，和下面 launchHint 让人手动敲的是同一组，
 * 只多了两个跳过首次运行引导的开关。没有任何自动化相关的参数。
 *
 * --disable-backgrounding-occluded-windows：Windows 上 Chrome 会追踪窗口有没有被
 * 盖住。实测（Chrome 155 / Win11）窗口被别的窗口完全盖住后 1 秒内页面就变 hidden，
 * 视频被直接暂停——不是变慢，盖着的那段时间进度一点不走。加了这一项被盖住也保持
 * visible；最小化照样会 hidden，这个兜不住。Playwright 自己 launch 时默认就带。
 * Chrome 和 Edge 用的是同一组：这些都是 Chromium 本身的开关，Edge 照认。 */
export function dedicatedArgs({ port, profileDir, mute = true, url = '', kind = 'chrome' }) {
    return [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-backgrounding-occluded-windows',
        ...(kind === 'edge' ? EDGE_ARGS : []),
        ...(mute ? ['--mute-audio'] : []),
        ...(url ? [url] : []),
    ];
}

/* 给出当前平台下启动「可被接管的浏览器」的完整命令。
 *
 * 这里刻意用一个独立的 --user-data-dir，而不是你平时的默认 profile。原因是个坑：
 * 浏览器已经在运行时，再执行一次 chrome --remote-debugging-port=9222 并不会
 * 开出调试端口——参数会被转交给已有实例，命令直接返回，端口上什么都没有。
 * 要么先把浏览器完全退出，要么像下面这样用另一个 profile 目录开一个独立实例。
 * 独立目录第一次需要登录一次学习通，之后登录态就一直留在那个目录里。
 * Edge 更容易踩这个坑：它关掉窗口后默认还在后台留着进程（启动加速）。
 *
 * --mute-audio 让这个专用实例整个不出声(页面读不到它)。脚本默认也会在播放器上
 * 静音，这一项是兜底: 实测在教室里外放过一次。
 *
 * exe 是本机实际找到的位置，有就用它，比写死的默认路径靠谱。 */
export function launchHint(port, kind = 'chrome', exe = '') {
    const { hint } = BROWSERS[kind] || BROWSERS.chrome;
    const command = exe ? `"${exe}"` : (hint[process.platform] || hint.linux);
    const flags = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir="${sideProfilePath(kind)}"`,
        '--disable-backgrounding-occluded-windows',
        ...(kind === 'edge' ? EDGE_ARGS : []),
        '--mute-audio',
    ];
    if (process.platform === 'win32') {
        return `${command} ${flags.join(' ')}`;
    }
    return `${command} ${flags.join(' ')} &`;
}

export function describePlatform() {
    const names = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
    return names[process.platform] || process.platform;
}
