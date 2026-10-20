/* ------------------------------------------------------------------
 * 配置
 * 时间相关的值要么是基准毫秒（实际执行时抖动），要么是 [min, max] 区间。
 * 没有一个是“照着这个数准点执行”的。
 * ------------------------------------------------------------------ */
import { BROWSER_CHOICES } from './platform.mjs';

export const defaults = {
    mode: 'connect',                    /* connect | launch */
    cdpPort: 9223,                      /* 学习通的专用浏览器用 9222，错开才能两个一起跑 */
    profileDir: '.chrome-profile',      /* 仅 launch 模式使用 */
    url: '',
    logLevel: 'quiet',                  /* silent | quiet | normal | verbose */
    autoLaunch: true,                   /* 连不上调试端口时自己启动专用浏览器 */
    browser: 'auto',                    /* auto | chrome | edge。auto = 有 Chrome 用 Chrome，没有用 Edge */
    browserPath: '',                    /* 浏览器可执行文件，空 = 自动找 */
    browserProfile: '',                 /* 专用浏览器的 profile 目录，空 = 用户目录下的 yuketang-chrome / yuketang-edge */
    waitCourseMs: 0,                    /* 等用户打开学习空间页面的上限，0 = 一直等 */

    /* 学习 */
    mute: true,                         /* 起播前静音, 一点声音都不出; --no-mute 关掉 */
    /* 'max' = 切到播放器倍速菜单里最高的一档(实测提供到 2x)。给数字则取不超过它的
     * 最高档; 给 1 就完全不碰倍速。只会用菜单里列出来的档位——那才是平台允许的。 */
    playbackRate: 'max',
    articles: true,                     /* 图文也打开阅读; --no-articles 只看视频 */
    allowScriptedPlay: true,            /* 真实点击起播失败时才退回 video.play() */
    resumeWhileHidden: true,
    maxItems: 0,                        /* 最多学多少项, 0 = 不限 */
    maxResumeTries: 3,                  /* 连续这么多次恢复播放都没起来就停下 */

    /* 节奏 */
    startupDelayMs: [1200, 5500],
    catalogTimeoutMs: 30000,
    actionTimeoutMs: 15000,             /* 单个 Playwright 操作的上限，默认是不限 */
    pollIntervalMs: 1200,
    videoWaitMs: 12000,                 /* 切到视频项后等播放器装好 */
    itemSwitchWaitMs: 10000,            /* 点完目录后等当前项变过去 */
    expandWaitMs: [700, 1600],          /* 展开知识点之后等学习项渲染出来 */
    guardNoProgressMs: 8000,
    bufferingTimeoutMs: 120000,         /* 播放中但一直在缓冲, 超过这么久才算出问题 */
    resumeCooldownMs: 2500,
    itemPauseMs: [2600, 9000],          /* 一项学完到点下一项之间的停顿 */
    itemLoadMs: [1800, 3600],
    articleReadMs: [25000, 70000],      /* 图文的阅读时间 */
    articleScrollMs: [2500, 9000],      /* 阅读时两次滚动之间 */
    longBreakChance: 0.12,
    longBreakMs: [20000, 70000],
    idleActivity: true,
    idleActivityMs: [18000, 55000],
};

const NUMBERS = new Set([
    'cdpPort', 'maxItems', 'maxResumeTries', 'catalogTimeoutMs', 'actionTimeoutMs', 'pollIntervalMs',
    'videoWaitMs', 'itemSwitchWaitMs', 'guardNoProgressMs', 'resumeCooldownMs', 'longBreakChance',
    'bufferingTimeoutMs', 'waitCourseMs',
]);
const FLAGS = new Set([
    'mute', 'articles', 'allowScriptedPlay', 'resumeWhileHidden', 'idleActivity', 'autoLaunch',
]);

const camel = (name) => name.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());

/* 只支持 Chrome 时的旧参数名，照旧能用 */
const ALIASES = { chromePath: 'browserPath', chromeProfile: 'browserProfile' };

export function parseArgs(argv) {
    const options = {};
    let check = false;
    let inspect = false;
    let help = false;
    let setup = false;

    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token === '--help' || token === '-h') { help = true; continue; }
        if (token === '--check') { check = true; continue; }
        if (token === '--inspect') { inspect = true; continue; }
        if (token === '--setup') { setup = true; continue; }
        if (token === '--launch') { options.mode = 'launch'; continue; }
        if (token === '--connect') { options.mode = 'connect'; continue; }
        if (!token.startsWith('--')) throw new Error(`无法识别的参数: ${token}`);

        const body = token.slice(2);
        const eq = body.indexOf('=');
        let name = camel(eq >= 0 ? body.slice(0, eq) : body);
        name = ALIASES[name] || name;
        let value = eq >= 0 ? body.slice(eq + 1) : null;

        let negated = false;
        if (name.startsWith('no') && name.length > 2 && name[2] === name[2].toUpperCase()) {
            const candidate = name[2].toLowerCase() + name.slice(3);
            if (FLAGS.has(candidate)) {
                name = candidate;
                negated = true;
            }
        }

        if (FLAGS.has(name)) {
            options[name] = negated ? false : (value === null ? true : value !== 'false');
            continue;
        }
        /* 先确认参数名认识，再去取值——否则打错一个名字只会说“缺少取值” */
        if (!(name in defaults)) throw new Error(`无法识别的参数: ${token}`);
        if (value === null) {
            value = argv[i + 1];
            if (value === undefined || value.startsWith('--')) throw new Error(`参数 ${token} 缺少取值`);
            i += 1;
        }
        if (NUMBERS.has(name)) {
            const parsed = Number(value);
            if (!Number.isFinite(parsed)) throw new Error(`参数 ${token} 需要是数字，拿到的是: ${value}`);
            options[name] = parsed;
            continue;
        }
        options[name] = value;
    }
    if (options.mode && !['connect', 'launch'].includes(options.mode)) {
        throw new Error('--mode 只能是 connect 或 launch');
    }
    if (options.browser !== undefined) {
        options.browser = String(options.browser).toLowerCase();
        if (!BROWSER_CHOICES.includes(options.browser)) {
            throw new Error(`--browser 只能是 ${BROWSER_CHOICES.join('、')}，拿到的是: ${options.browser}`);
        }
    }

    return { config: { ...defaults, ...options }, check, inspect, help, setup };
}

export const helpText = `
用真实浏览器学习长江雨课堂「学习空间」里的视频和图文

用法
  Windows：双击仓库根目录的 start.cmd；Linux / macOS：./start.sh
  或者在 playwright/ 目录下：node run.mjs [选项]

  第一次运行会自动安装依赖。连不上浏览器时会自己启动一个专用的 Chrome 或 Edge
  （独立 profile、静音），在里面登录、点开课程里的任意一个视频，脚本就会开始。

浏览器
  --cdp-port <端口>       调试端口，默认 9223（和学习通的 9222 错开）
  --browser <浏览器>      auto | chrome | edge，默认 auto：有 Chrome 用 Chrome，没有用 Edge
  --browser-path <路径>   浏览器可执行文件，默认自动找（旧名 --chrome-path 也认）
  --browser-profile <目录>
                          专用浏览器的 profile 目录，默认用户目录下的 yuketang-chrome
                          或 yuketang-edge（旧名 --chrome-profile 也认）
  --no-auto-launch        连不上时不自动启动浏览器，只报错
  --url <地址>            直接打开这个学习空间页面，不等你手动点
  --wait-course-ms <ms>   等你打开学习空间页面的上限，默认 0 = 一直等
  --launch                改用 Playwright 启动浏览器（特征多一些，不推荐）
  --profile-dir <目录>    --launch 模式的 profile 目录，默认 .chrome-profile

行为
  --max-items <n>         学完 n 项就停，默认不限
  --no-articles           只看视频，跳过图文
  --playback-rate <倍速>  默认 max，切到播放器倍速菜单里最高的一档；
                          给数字则取不超过它的最高档，给 1 就完全不碰倍速
  --no-mute               起播时不静音（默认静音，不会外放）
  --no-idle-activity      关掉播放期间的指针微动
  --no-resume-while-hidden  页面在后台时不去动播放状态
  --no-allow-scripted-play  禁止退回 video.play()，只用真实点击
  --poll-interval-ms <ms> 进度轮询基准间隔，默认 1200
  --log-level <档>        silent | quiet | normal | verbose

其它
  --setup                 重新安装依赖
  --check                 只做特征自检并退出，不动学习进度
  --inspect               只读检查目录和当前项，不点击、不播放
  --help                  显示这段说明
`;
