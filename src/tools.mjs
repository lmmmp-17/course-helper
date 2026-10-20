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

export const TOOLS = [
    {
        id: 'xuexitong',
        name: '学习通',
        summary: '真实浏览器播放课程视频，按任务点跳过已完成的小节',
        /* 相对本项目的位置。用户把仓库放在别处时可以在界面上改 */
        dir: '../../xuexitongScript',
        entry: { win32: 'start.cmd', posix: './start.sh' },
        kind: 'flags',
        /* 开始之后要用户做什么，直接显示在界面上 */
        hint: '会自动打开一个专用 Chrome。在里面登录学习通，点开课程的任意一节，脚本就开始。',
        options: [
            { flag: '--max-sections', label: '最多播几节', type: 'number', placeholder: '留空 = 不限' },
            {
                flag: '--playback-rate',
                label: '倍速',
                type: 'select',
                choices: [
                    { value: 'max', label: '最高（播放器菜单里最高的一档）' },
                    { value: '1', label: '不改（1x）' },
                ],
                default: 'max',
            },
            { flag: '--no-mute', label: '不静音', type: 'bool', help: '默认静音，勾上才出声' },
            {
                flag: '--no-auto-advance-no-video',
                label: '遇到只剩测验的小节就停下',
                type: 'bool',
                help: '默认是跳过去找下一个有视频的小节',
            },
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
        hint: '会自动打开一个专用 Chrome。在里面登录雨课堂，点开课程里任意一个视频，脚本就开始。',
        options: [
            { flag: '--max-items', label: '最多学几项', type: 'number', placeholder: '留空 = 不限' },
            {
                flag: '--playback-rate',
                label: '倍速',
                type: 'select',
                choices: [
                    { value: 'max', label: '最高（播放器菜单里最高的一档）' },
                    { value: '1', label: '不改（1x）' },
                ],
                default: 'max',
            },
            { flag: '--no-articles', label: '只看视频，跳过图文', type: 'bool' },
            { flag: '--no-mute', label: '不静音', type: 'bool', help: '默认静音，勾上才出声' },
            { flag: '--log-level', label: '日志详细程度', type: 'select', hidden: true,
              choices: [{ value: 'quiet', label: '正常' }, { value: 'verbose', label: '详细' }], default: 'quiet' },
        ],
    },
    {
        id: 'autovisor',
        name: '智慧树',
        summary: '自动播放课程视频、处理课中弹题',
        dir: '../Autovisor',
        entry: { win32: 'run.cmd', posix: './run.sh' },
        kind: 'config',
        /* 配置写进这个文件；按平台取不同的文件名，和它自己的入口脚本一致 */
        configFile: { win32: 'config.ini', linux: 'config.linux.ini', darwin: 'config.macos.ini' },
        hint: '第一次运行会生成配置文件。课程地址要填课程播放页（能直接看到视频的那一页）。',
        options: [
            { key: ['course-url', 'URL1'], label: '课程地址', type: 'text', required: true,
              placeholder: 'https://studyvideoh5.zhihuishu.com/stuStudy?...' },
            { key: ['course-option', 'limitSpeed'], label: '倍速', type: 'select',
              choices: [
                  { value: 'max', label: '最高（播放器菜单里最高的一档）' },
                  { value: '0', label: '不改' },
              ], default: 'max' },
            { key: ['course-option', 'limitMaxTime'], label: '每门课最多跑几分钟', type: 'number', default: '30',
              help: '0 = 不限' },
            { key: ['course-option', 'soundOff'], label: '静音', type: 'bool', default: true, invert: true,
              help: '取消勾选才出声' },
            { key: ['user-account', 'username'], label: '手机号', type: 'text', placeholder: '留空则在浏览器里手动登录' },
            { key: ['user-account', 'password'], label: '密码', type: 'password', placeholder: '留空则在浏览器里手动登录' },
        ],
    },
];

/* 工具在本机存不存在：目录和入口脚本都要在 */
export function locate(tool, root, platform = process.platform) {
    const dir = dirOf(tool, root);
    const entry = entryFor(tool, platform).replace(/^\.\//, '');
    return { dir, entry, ready: existsSync(dir) && existsSync(resolve(dir, entry)) };
}

export function describe(root, platform = process.platform) {
    return TOOLS.map((tool) => {
        const { dir, ready } = locate(tool, root, platform);
        return {
            id: tool.id,
            name: tool.name,
            summary: tool.summary,
            hint: tool.hint,
            kind: tool.kind,
            dir,
            ready,
            options: tool.options.filter((option) => !option.hidden),
        };
    });
}

export function byId(id) {
    return TOOLS.find((tool) => tool.id === id) || null;
}
