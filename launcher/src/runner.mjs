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
const MAX_LINES = 400;

export function createRunner({ root, platform = process.platform, spawnProcess = spawn } = {}) {
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

    function stopOne(run) {
        const { current } = run;
        if (!current) return false;
        current.stopping = true;
        const { child } = current;
        if (platform === 'win32') {
            /* Windows 上入口是经 cmd.exe 起的，kill 只结束 cmd.exe，真正干活的
             * node / python 会留在后台接着播。只能按进程树结束——代价是工具
             * 来不及打印收尾的总结。 */
            spawnProcess('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
            return true;
        }
        /* 先温和地停：两个 Node 工具收到 SIGINT 会自己收尾 */
        child.kill('SIGINT');
        setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 8000).unref?.();
        return true;
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

                const entry = entryFor(tool, platform);
                /* Windows 上 .cmd 必须经过 shell 才能启动；命令本身是登记表里写死的，
                 * 参数单独传，不拼进命令行字符串 */
                const useShell = platform === 'win32';
                const command = useShell ? `"${resolve(dir, entry)}"` : entry;
                child = spawnProcess(command, args, {
                    cwd: dir,
                    shell: useShell,
                    /* 让工具知道输出要给界面看：状态行改成 [[status]] 单独一行 */
                    env: { ...process.env, COURSE_UI: '1' },
                });
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
    };
}
