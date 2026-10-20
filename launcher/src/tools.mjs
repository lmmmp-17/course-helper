/* ------------------------------------------------------------------
 * 工具登记表
 *
 * 每个工具一条描述，界面是照着这张表画出来的——加一个工具只要加一条，
 * 不用改界面代码。
 *
 * 两类工具：
 *   kind: 'flags'   选项通过命令行参数传（学习通、雨课堂这类 Node 工具）
 *   kind: 'config'  选项写进配置文件，再运行入口脚本（Autovisor 这类）
 * ------------------------------------------------------------------ */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readConfig } from './args.mjs';

/* 仓库放在哪儿因机器而异（实测 Windows 上在 claude-wintest 下），所以留一个
 * 覆盖文件：tools.local.json，形如 { "yuketang": "D:\\code\\yuketang" }。
 * 它在 .gitignore 里，不会被提交。 */
function overrides(root) {
    try {
        return JSON.parse(readFileSync(resolve(root, 'tools.local.json'), 'utf8'));
    } catch (e) {
        return {};
    }
}

export function dirOf(tool, root) {
    const custom = overrides(root)[tool.id];
    return custom ? resolve(root, custom) : resolve(root, tool.dir);
}

/* 入口脚本按平台取：Windows 双击 .cmd，其余用 .sh */
export function entryFor(tool, platform = process.platform) {
    return platform === 'win32' ? tool.entry.win32 : tool.entry.posix;
}

/* 学习通、雨课堂共用：两个工具的 --browser 是同一套取值 */
const BROWSER_FLAG = {
    flag: '--browser',
    label: '浏览器',
    type: 'select',
    choices: [
        { value: 'auto', label: '自动' },
        { value: 'chrome', label: 'Chrome' },
        { value: 'edge', label: 'Edge' },
    ],
    default: 'auto',
    help: '自动 = 装了 Chrome 就用 Chrome，没有就用 Edge',
};

export const TOOLS = [
    {
        id: 'xuexitong',
        name: '学习通',
        summary: '真实浏览器播放课程视频，按任务点跳过已完成的小节',
        /* 相对 launcher/ 的位置：合并仓库里三个工具和 launcher 是平级的子目录。
         * 放在别处时用 tools.local.json 改 */
        dir: '../xuexitong',
        entry: { win32: 'start.cmd', posix: './start.sh' },
        kind: 'flags',
        /* 开始之后要用户做什么，直接显示在界面上 */
        hint: '会自动打开一个专用的浏览器窗口。在里面登录学习通，点开课程的任意一节，脚本就开始。',
        options: [
            { flag: '--max-sections', label: '最多播几节', type: 'number', placeholder: '留空 = 不限' },
            {
                flag: '--playback-rate',
                label: '倍速',
                type: 'select',
                choices: [
                    { value: 'max', label: '最高' },
                    { value: '1', label: '不改' },
                ],
                default: 'max',
                help: '最高 = 播放器倍速菜单里能选的最高一档',
            },
            { flag: '--no-mute', label: '静音', type: 'bool', default: true, invert: true, role: 'mute' },
            {
                flag: '--no-auto-advance-no-video',
                label: '遇到只剩测验的小节就停下',
                type: 'bool',
                help: '默认是跳过去找下一个有视频的小节',
            },
            BROWSER_FLAG,
            { flag: '--log-level', label: '日志详细程度', type: 'select', hidden: true,
              choices: [{ value: 'quiet', label: '正常' }, { value: 'verbose', label: '详细' }], default: 'quiet' },
        ],
    },
    {
        id: 'yuketang',
        name: '长江雨课堂',
        summary: '真实浏览器学习「学习空间」里的视频和图文',
        dir: '../yuketang',
        entry: { win32: 'start.cmd', posix: './start.sh' },
        kind: 'flags',
        hint: '会自动打开一个专用的浏览器窗口。在里面登录雨课堂，点开课程里任意一个视频，脚本就开始。',
        options: [
            { flag: '--max-items', label: '最多学几项', type: 'number', placeholder: '留空 = 不限' },
            {
                flag: '--playback-rate',
                label: '倍速',
                type: 'select',
                choices: [
                    { value: 'max', label: '最高' },
                    { value: '1', label: '不改' },
                ],
                default: 'max',
                help: '最高 = 播放器倍速菜单里能选的最高一档',
            },
            { flag: '--no-articles', label: '只看视频，跳过图文', type: 'bool' },
            { flag: '--no-mute', label: '静音', type: 'bool', default: true, invert: true, role: 'mute' },
            BROWSER_FLAG,
            { flag: '--log-level', label: '日志详细程度', type: 'select', hidden: true,
              choices: [{ value: 'quiet', label: '正常' }, { value: 'verbose', label: '详细' }], default: 'quiet' },
        ],
    },
    {
        id: 'autovisor',
        name: '智慧树',
        summary: '自动播放课程视频、处理课中弹题',
        dir: '../autovisor',
        entry: { win32: 'run.cmd', posix: './run.sh' },
        kind: 'config',
        /* 配置写进这个文件；按平台取不同的文件名，和它自己的入口脚本一致 */
        configFile: { win32: 'config.ini', linux: 'config.linux.ini', darwin: 'config.macos.ini' },
        hint: '会自动打开一个浏览器。在里面登录智慧树，点开要刷的课程（进到能看到视频的播放页），脚本就开始。',
        /* 和另外两个平台一样：不填课程地址，等你在浏览器里点开课程。
         * 配置文件里的 URL1… 是单独运行 run.cmd / run.sh 时用的，这里不用它 */
        fixedArgs: ['--wait-course'],
        options: [
            { key: ['course-option', 'limitSpeed'], label: '倍速', type: 'select',
              choices: [
                  { value: 'max', label: '最高' },
                  { value: '0', label: '不改' },
              ], default: 'max', help: '最高 = 播放器倍速菜单里能选的最高一档' },
            { key: ['course-option', 'limitMaxTime'], label: '每门课最多跑几分钟', type: 'number', default: '30',
              help: '0 = 不限' },
            { key: ['course-option', 'soundOff'], label: '静音', type: 'bool', default: true, role: 'mute' },
            /* Autovisor 自己的默认：Windows 用 Edge（系统自带），别的平台用 Chrome */
            { key: ['browser-option', 'driver'], label: '浏览器', type: 'select',
              choices: [
                  { value: 'Edge', label: 'Edge' },
                  { value: 'Chrome', label: 'Chrome' },
                  { value: 'Chromium', label: 'Chromium', platforms: ['linux'] },
              ], default: 'Chrome', platformDefault: { win32: 'Edge' },
              help: '选电脑上装着的那个' },
            { key: ['script-option', 'enableHideWindow'], label: '把浏览器窗口移出屏幕', type: 'bool', default: false,
              platforms: ['win32'], help: '看不见但照常播放。报窗口句柄错误时取消勾选' },
            { key: ['script-option', 'enableAutoCaptcha'], label: '自动完成登录滑块', type: 'bool', default: false,
              help: '填了手机号和密码才用得上；第一次勾上会多装 numpy、opencv' },
            { key: ['user-account', 'username'], label: '手机号', type: 'text', placeholder: '留空则在浏览器里手动登录' },
            { key: ['user-account', 'password'], label: '密码', type: 'password', placeholder: '留空则在浏览器里手动登录' },
        ],
    },
];

/* config 类工具的配置文件，按平台取，和它自己的入口脚本一致 */
export function configPath(tool, dir, platform = process.platform) {
    return resolve(dir, tool.configFile[platform] || tool.configFile.linux);
}

/* 已有配置里的值，用来预填表单——用户可能已经用工具自带的方式配过了。
 * 密码不回传给页面。 */
function currentValues(tool, dir, platform) {
    if (tool.kind !== 'config') return {};
    try {
        return readConfig(readFileSync(configPath(tool, dir, platform), 'utf8'), tool);
    } catch (e) {
        return {};
    }
}

/* 工具在本机存不存在：目录和入口脚本都要在 */
export function locate(tool, root, platform = process.platform) {
    const dir = dirOf(tool, root);
    const entry = entryFor(tool, platform).replace(/^\.\//, '');
    return { dir, entry, ready: existsSync(dir) && existsSync(resolve(dir, entry)) };
}

export function describe(root, platform = process.platform) {
    return TOOLS.map((tool) => {
        const { dir, ready } = locate(tool, root, platform);
        const current = ready ? currentValues(tool, dir, platform) : {};
        return {
            id: tool.id,
            name: tool.name,
            summary: tool.summary,
            hint: tool.hint,
            kind: tool.kind,
            dir,
            ready,
            options: tool.options
                .filter((option) => !option.hidden)
                .filter((option) => !option.platforms || option.platforms.includes(platform))
                .map((option) => {
                    const key = option.flag || option.key.join('.');
                    const shown = { ...option };
                    if (option.platformDefault && platform in option.platformDefault) {
                        shown.default = option.platformDefault[platform];
                    }
                    if (option.choices) {
                        shown.choices = option.choices.filter((choice) => !choice.platforms || choice.platforms.includes(platform));
                    }
                    if (key in current) shown.current = current[key];
                    return shown;
                }),
        };
    });
}

export function byId(id) {
    return TOOLS.find((tool) => tool.id === id) || null;
}
