/* ------------------------------------------------------------------
 * 跑工具的子进程，把输出收集起来给界面看。
 *
 * 同一时间只允许跑一个：三个工具都要开浏览器、抢调试端口，并行跑只会互相打架。
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
    let current = null;
    const listeners = new Set();

    const emit = (event) => {
        for (const listener of listeners) {
            try { listener(event); } catch (e) { /* 某个界面断了不影响其它的 */ }
        }
    };

    /* 上一次运行的日志在退出后留着：刷新页面也能看到它是怎么停的 */
    let lastExit = null;
    let lastLines = [];

    const state = () => (current ? {
        running: true,
        tool: current.tool.id,
        name: current.tool.name,
        startedAt: current.startedAt,
        values: current.values,
        status: current.status,
        lines: current.lines,
        exit: null,
    } : { running: false, tool: null, name: null, startedAt: null, values: {}, status: '', lines: lastLines, exit: lastExit });

    /* 每行带上收到的时间（Autovisor 的行里没有时间）和是不是 stderr
     * （两个 Node 工具的警告、错误都走 stderr） */
    function push(line, err = false) {
        if (!current) return;
        if (line.startsWith(STATUS_PREFIX)) {
            current.status = line.slice(STATUS_PREFIX.length);
            emit({ type: 'status', status: current.status });
            return;
        }
        const entry = { line, at: Date.now(), err };
        current.lines.push(entry);
        if (current.lines.length > MAX_LINES) current.lines.splice(0, current.lines.length - MAX_LINES);
        emit({ type: 'line', ...entry });
    }

    /* 子进程的输出是按块来的，要自己按行切 */
    function reader(err) {
        let buffer = '';
        return (chunk) => {
            buffer += chunk.toString();
            const parts = buffer.split(/\r?\n/);
            buffer = parts.pop() ?? '';
            for (const part of parts) if (part.trim()) push(part.replace(/\r/g, ''), err);
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

    return {
        state,
        onEvent(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },

        async start(tool, values = {}) {
            if (current) throw new Error(`${current.tool.name} 还在跑，先停掉它`);
            const missing = missingRequired(tool, values);
            if (missing.length) throw new Error(`还没填：${missing.join('、')}`);

            const { dir, ready } = locate(tool, root, platform);
            if (!ready) throw new Error(`找不到 ${tool.name} 的目录或入口脚本：${dir}`);

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
            const child = spawnProcess(command, args, {
                cwd: dir,
                shell: useShell,
                /* 让工具知道输出要给界面看：状态行改成 [[status]] 单独一行 */
                env: { ...process.env, COURSE_UI: '1' },
            });

            current = {
                tool,
                child,
                startedAt: Date.now(),
                values: shown(tool, values),
                status: '',
                lines: [],
            };
            lastExit = null;
            lastLines = [];
            emit({ type: 'started', tool: tool.id, name: tool.name, startedAt: current.startedAt, values: current.values });

            child.stdout?.on('data', reader(false));
            child.stderr?.on('data', reader(true));
            child.on('error', (error) => push(`启动失败：${error.message}`, true));
            child.on('close', (code, signal) => {
                lastExit = { code, signal, at: Date.now(), tool: tool.id, name: tool.name, stopped: Boolean(current?.stopping) };
                lastLines = current?.lines ?? [];
                current = null;
                emit({ type: 'exit', ...lastExit });
            });
            return state();
        },

        stop() {
            if (!current) return false;
            current.stopping = true;
            const child = current.child;
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
        },
    };
}
