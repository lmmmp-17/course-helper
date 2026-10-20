/* ------------------------------------------------------------------
 * 配置
 * 时间相关的值要么是基准毫秒（实际执行时抖动），要么是 [min, max] 区间。
 * 没有一个是“照着这个数准点执行”的。
 * ------------------------------------------------------------------ */
import { BROWSER_CHOICES } from './platform.mjs';

export const defaults = {
    mode: 'connect',                    /* connect | launch */
    cdpPort: 9222,
    profileDir: '.chrome-profile',      /* 仅 launch 模式使用 */
    url: '',
    logLevel: 'quiet',                  /* silent | quiet | normal | verbose */
    autoLaunch: true,                   /* 连不上调试端口时自己启动专用浏览器 */
    browser: 'auto',                    /* auto | chrome | edge。auto = 有 Chrome 用 Chrome，没有用 Edge */
    browserPath: '',                    /* 浏览器可执行文件，空 = 自动找 */
    browserProfile: '',                 /* 专用浏览器的 profile 目录，空 = 用户目录下的 xuexitong-chrome / xuexitong-edge */
    waitCourseMs: 0,                    /* 等用户打开课程页的上限，0 = 一直等 */

    /* 播放 */
    /* 'max' = 切到播放器倍速菜单里最高的一档(实测学习通和雨课堂都提供到 2x)。
     * 给数字则取不超过它的最高档; 给 1 就完全不碰倍速。
     * 只会用菜单里列出来的档位——那才是平台允许的, 也不用去写 playbackRate。 */
    playbackRate: 'max',
    allowScriptedPlay: true,            /* 真实点击起播失败时才退回 video.play() */
    mute: true,                         /* 起播前静音, 一点声音都不出; --no-mute 关掉 */
    resumeWhileHidden: true,
    /* 本节没有待播的视频(剩下的是计分测验、课件等)时直接去下一节。
     * 计分的测验我们不碰, 也不该卡在那里, 所以默认跳过; --no-auto-advance-no-video
     * 可以改回「停下来等你处理」。 */
    autoAdvanceNoVideo: true,
    maxSections: 0,                     /* 0 = 不限 */
    maxChapterTestTries: 3,
    maxStepSwitchTries: 4,

    /* 节奏 */
    startupDelayMs: [1200, 5500],
    treeTimeoutMs: 30000,
    actionTimeoutMs: 15000,             /* 单个 Playwright 操作的上限，默认是不限 */
    pollIntervalMs: 1200,
    videoWaitMs: 8000,              /* 等播放器把 video 元素装出来 */
    jobsWaitMs: 6000,               /* 等卡片 frame 里的任务点装出来 */
    sectionSwitchWaitMs: 8000,      /* 点完目录后等激活项变过去 */
    guardNoProgressMs: 8000,
    resumeCooldownMs: 2500,
    sectionPauseMs: [2600, 9000],
    sectionLoadMs: [2600, 4800],
    videoProbeMs: [400, 900],           /* 等播放器时的重试间隔 */
    stepProbeMs: [600, 1400],           /* 非视频步骤上看一眼有没有视频 */
    stepSwitchWaitMs: [1800, 3400],     /* 点完视频页签之后等页面切过去 */
    testPeekMs: [1600, 4600],           /* 测验页上“看一眼”再点下一步 */
    testAdvanceWaitMs: [1900, 3400],
    longBreakChance: 0.12,
    longBreakMs: [20000, 70000],
    idleActivity: true,
    idleActivityMs: [18000, 55000],
};

const NUMBERS = new Set([
    'cdpPort', 'maxSections', 'maxChapterTestTries',
    'treeTimeoutMs', 'pollIntervalMs', 'guardNoProgressMs', 'resumeCooldownMs', 'longBreakChance', 'waitCourseMs',
    'maxStepSwitchTries', 'videoWaitMs', 'actionTimeoutMs', 'jobsWaitMs', 'sectionSwitchWaitMs',
]);
const FLAGS = new Set([
    'allowScriptedPlay', 'resumeWhileHidden', 'autoAdvanceNoVideo', 'idleActivity', 'mute', 'autoLaunch',
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
用真实输入事件驱动学习通课程播放（Playwright 版）

用法
  Windows：双击仓库根目录的 start.cmd；Linux / macOS：./start.sh
  或者在 playwright/ 目录下：node run.mjs [选项]

  第一次运行会自动安装依赖。连不上浏览器时会自己启动一个专用的 Chrome 或 Edge
  （独立 profile、静音），在里面登录、点开课程的任意一节，脚本就会开始。

浏览器
  --cdp-port <端口>       调试端口，默认 9222
  --browser <浏览器>      auto | chrome | edge，默认 auto：有 Chrome 用 Chrome，没有用 Edge
  --browser-path <路径>   浏览器可执行文件，默认自动找（旧名 --chrome-path 也认）
  --browser-profile <目录>
                          专用浏览器的 profile 目录，默认用户目录下的 xuexitong-chrome
                          或 xuexitong-edge（旧名 --chrome-profile 也认）
  --no-auto-launch        连不上时不自动启动浏览器，只报错
  --url <地址>            直接打开这个课程页，不等你手动点
  --wait-course-ms <ms>   等你打开课程页的上限，默认 0 = 一直等
  --launch                改用 Playwright 启动浏览器（特征多一些，不推荐）
  --profile-dir <目录>    --launch 模式的 profile 目录，默认 .chrome-profile

行为
  --max-sections <n>      播完 n 节就停，默认不限
  --no-auto-advance-no-video
                          本节只剩测验等非视频任务点时停下来（默认直接跳到下一节）
  --no-mute               起播时不静音（默认静音，不会外放）
  --playback-rate <倍速>  默认 max，切到播放器倍速菜单里最高的一档；
                          给数字则取不超过它的最高档，给 1 就完全不碰倍速
  --no-idle-activity      关掉播放期间的指针微动
  --no-resume-while-hidden  页面在后台时不去动播放状态
  --no-allow-scripted-play  禁止退回 video.play()，只用真实点击
  --poll-interval-ms <ms> 进度轮询基准间隔，默认 1200
  --log-level <档>        silent | quiet | normal | verbose

其它
  --setup                 重新安装依赖
  --check                 只做特征自检并退出，不动课程进度
  --inspect               只读检查课程页结构，不点击、不播放
  --help                  显示这段说明
`.trim();
