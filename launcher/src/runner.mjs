/* ------------------------------------------------------------------
 * 跑工具的子进程，把输出收集起来给界面看。
 *
 * 三个工具可以同时跑：各开各的浏览器（专用 profile 不同），调试端口也错开了
 * （学习通 9222、雨课堂 9223、智慧树普通模式由 Playwright 自己管，连接模式 9224）。
 * 同一个工具只能开一个——两个学习通会抢同一个专用浏览器。
 * ------------------------------------------------------------------ */
import { spawn } from 'node:child_process';
import { readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { buildArgs, applyConfig, missingRequired } from './args.mjs';
import { entryFor, locate, configPath } from './tools.mjs';

/* 工具用 [[status]] 前缀单独报"当前在干什么"，其余都是普通日志。
 * 没有这个前缀时界面就只显示原始输出，功能照常。 */
const STATUS_PREFIX = '[[status]] ';
/* 关掉 stdin 之后等工具自己收尾的时间，过了还在就强制结束整棵进程树 */
export const STOP_GRACE_MS = 8000;

/* Windows 上 .cmd 只能经 cmd.exe 启动。以前用 spawn(…, args, { shell: true })，Node 会
 * 把参数原样拼进命令行，新版 Node 已经把这种用法标成弃用（DEP0190）。这里自己拼：
 * cmd.exe /d /s /c ""入口" "参数"…"，和 shell: true 生成的是同一种命令行。
 * 参数只来自登记表和界面上的选项；带 cmd 特殊字符的一律拒绝，免得被当成命令执行。 */
const CMD_UNSAFE = /["%^&|<>\r\n]/;
export function windowsCommand(script, args) {
    for (const arg of [script, ...args]) {
        if (CMD_UNSAFE.test(arg)) throw new Error(`参数里有不能用的字符：${arg}`);
    }
    const line = [script, ...args].map((arg) => `"${arg}"`).join(' ');
    return ['cmd.exe', ['/d', '/s', '/c', `"${line}"`]];
}
const MAX_LINES = 400;

export function createRunner({ root, platform = process.platform, spawnProcess = spawn, killProcess = process.kill, settings = null } = {}) {
    /* 按工具记：正在跑的那个进程，和上一次是怎么停的（刷新页面也能看到） */
    const runs = new Map();
    const listeners = new Set();

    const emit = (event) => {
        for (const listener of listeners) {
            try { listener(event); } catch (e) { /* 某个界面断了不影响其它的 */ }
        }
    };

    const slot = (tool) => {
        if (!runs.has(tool.id)) runs.set(tool.id, { tool, current: null, lastExit: null, lastLines: [] });
        return runs.get(tool.id);
    };

    function toolState(id) {
        const run = runs.get(id);
        if (!run) return { tool: id, running: false, startedAt: null, values: {}, status: '', lines: [], exit: null };
        const { current } = run;
        return current ? {
            tool: id,
            name: run.tool.name,
            running: true,
            startedAt: current.startedAt,
            values: current.values,
            status: current.status,
            lines: current.lines,
            exit: null,
        } : { tool: id, name: run.tool.name, running: false, startedAt: null, values: {}, status: '', lines: run.lastLines, exit: run.lastExit };
    }

    const state = () => ({ runs: Object.fromEntries([...runs.keys()].map((id) => [id, toolState(id)])) });

    /* 每行带上收到的时间（Autovisor 的行里没有时间）和是不是 stderr
     * （两个 Node 工具的警告、错误都走 stderr） */
    function push(run, line, err = false) {
        const { current } = run;
        if (!current) return;
        const tool = run.tool.id;
        if (line.startsWith(STATUS_PREFIX)) {
            current.status = line.slice(STATUS_PREFIX.length);
            emit({ type: 'status', tool, status: current.status });
            return;
        }
        const entry = { line, at: Date.now(), err };
        current.lines.push(entry);
        if (current.lines.length > MAX_LINES) current.lines.splice(0, current.lines.length - MAX_LINES);
        emit({ type: 'line', tool, ...entry });
    }

    /* 子进程的输出是按块来的，要自己按行切 */
    function reader(run, err) {
        let buffer = '';
        return (chunk) => {
            buffer += chunk.toString();
            const parts = buffer.split(/\r?\n/);
            buffer = parts.pop() ?? '';
            for (const part of parts) if (part.trim()) push(run, part.replace(/\r/g, ''), err);
        };
    }

    /* 这次用了哪些设置，给界面显示。密码不往外送 */
    function shown(tool, values) {
        const out = {};
        for (const option of tool.options) {
            const key = option.flag || option.key.join('.');
            if (option.type === 'password' || !(key in values)) continue;
            out[key] = values[key];
        }
        return out;
    }

    /* config 类工具：先把界面上的值写进它自己的配置文件 */
    async function writeConfig(tool, dir, values) {
        const file = configPath(tool, dir, platform);
        const name = basename(file);
        let text;
        try {
            text = await readFile(file, 'utf8');
        } catch (e) {
            /* 还没有配置文件就从模板复制一份 */
            const template = resolve(dir, `${name}.example`);
            await access(template);
            await copyFile(template, file);
            text = await readFile(file, 'utf8');
        }
        await writeFile(file, applyConfig(text, tool, values), 'utf8');
        return name;
    }

    /* 宽限期过了还没退出：强制结束整棵进程树 */
    function killTree(child) {
        if (platform === 'win32') {
            spawnProcess('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on?.('error', () => {});
            return;
        }
        /* POSIX 上工具是在自己的进程组里起的（detached），按组结束，uv、python、浏览器一个不落 */
        try {
            killProcess(-child.pid, 'SIGKILL');
        } catch (e) {
            child.kill('SIGKILL');
        }
    }

    function stopOne(run) {
        const { current } = run;
        if (!current) return false;
        if (current.stopping) return true;
        current.stopping = true;
        const { child } = current;
        /* 统一的停止信号：关掉子进程的 stdin。三个工具在 COURSE_UI=1 时把它当成 Ctrl+C，
         * 自己收尾：关浏览器连接、打印总结，智慧树的 Playwright 也会删掉临时目录。
         *
         * 以前 Windows 上只能按进程树强杀：入口隔着 cmd.exe，发不了 Ctrl+C；不带 /F 的
         * taskkill /T 也不行，Edge 的渲染、GPU 子进程没有窗口只能强杀，taskkill 从叶子往根
         * 处理，整条链都被拒，Edge 的窗口根本收不到关闭（pc 实测）。POSIX 上也不再发 SIGINT：
         * 和 stdin 一起到的话，Autovisor 会收到两次中断，第二次打断正在进行的收尾。 */
        try {
            child.stdin?.end();
        } catch (e) {
            /* 已经关了 */
        }
        /* 判断要看 exitCode / signalCode：child.killed 只表示信号发出去过 */
        setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) killTree(child);
        }, STOP_GRACE_MS).unref?.();
        return true;
    }

    /* 所有在跑的都退出了，或者超时，就返回（退出启动器时等工具收完尾再走） */
    function whenIdle(timeoutMs) {
        return new Promise((resolve) => {
            let timer = null;
            const off = (() => {
                const listener = () => check();
                listeners.add(listener);
                return () => listeners.delete(listener);
            })();
            function check() {
                if ([...runs.values()].some((run) => run.current)) return;
                off();
                clearTimeout(timer);
                resolve(true);
            }
            timer = setTimeout(() => { off(); resolve(false); }, timeoutMs);
            check();
        });
    }

    return {
        state,
        toolState,
        onEvent(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },

        async start(tool, values = {}) {
            const run = slot(tool);
            /* 检查和登记之间有 await，先占住，免得连点两下起两个 */
            if (run.current || run.pending) throw new Error(`${tool.name} 已经在跑了，先停掉它`);
            const missing = missingRequired(tool, values);
            if (missing.length) throw new Error(`还没填：${missing.join('、')}`);

            const { dir, ready } = locate(tool, root, platform);
            if (!ready) throw new Error(`找不到 ${tool.name} 的目录或入口脚本：${dir}`);

            run.pending = true;
            let child;
            try {
                const args = tool.kind === 'flags' ? buildArgs(tool, values) : [];
                if (tool.kind === 'config') {
                    const name = await writeConfig(tool, dir, values);
                    args.push('--config', name);
                }
                args.push(...(tool.fixedArgs || []));

                const entry = entryFor(tool, platform);
                /* 让工具知道输出要给界面看：状态行改成 [[status]] 单独一行；
                 * Windows 的 .cmd 入口据此也不在结尾 pause（stdin 是管道，会一直等下去） */
                const env = {
                    ...process.env,
                    COURSE_UI: '1',
                    /* 中文 Windows 上 Python 往管道写用的是 cp936，这边按 UTF-8 解码就成了乱码
                     * （pc 实测智慧树的日志全是乱码）。和控制台是不是 65001 无关 */
                    PYTHONUTF8: '1',
                    PYTHONIOENCODING: 'utf-8',
                };
                /* stdin 留成管道：关掉它就是让工具停（见 stopOne） */
                const stdio = ['pipe', 'pipe', 'pipe'];
                child = platform === 'win32'
                    ? spawnProcess(...windowsCommand(resolve(dir, entry), args), { cwd: dir, env, stdio, windowsVerbatimArguments: true })
                    /* 自己一个进程组：强制结束时按组杀；终端里的 Ctrl+C 也不会越过启动器直接打到工具上 */
                    : spawnProcess(entry, args, { cwd: dir, env, stdio, detached: true });
            } finally {
                run.pending = false;
            }

            run.current = {
                child,
                startedAt: Date.now(),
                values: shown(tool, values),
                status: '',
                lines: [],
            };
            run.lastExit = null;
            run.lastLines = [];
            /* 记下这次填的值，两个入口下次打开都能预填。写不进去不影响跑 */
            try { settings?.remember(tool, values); } catch (e) { /* 配置目录不可写之类 */ }
            emit({ type: 'started', tool: tool.id, name: tool.name, startedAt: run.current.startedAt, values: run.current.values });

            child.stdout?.on('data', reader(run, false));
            child.stderr?.on('data', reader(run, true));
            child.on('error', (error) => push(run, `启动失败：${error.message}`, true));
            child.on('close', (code, signal) => {
                run.lastExit = { code, signal, at: Date.now(), tool: tool.id, name: tool.name, stopped: Boolean(run.current?.stopping) };
                run.lastLines = run.current?.lines ?? [];
                run.current = null;
                emit({ type: 'exit', ...run.lastExit });
            });
            return toolState(tool.id);
        },

        /* 不给 id 就全停（退出启动器时用） */
        stop(id) {
            if (id === undefined) {
                let any = false;
                for (const run of runs.values()) any = stopOne(run) || any;
                return any;
            }
            const run = runs.get(id);
            return run ? stopOne(run) : false;
        },

        running() {
            return [...runs.values()].filter((run) => run.current).map((run) => run.tool.id);
        },

        whenIdle,
    };
}
