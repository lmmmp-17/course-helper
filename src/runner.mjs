/* ------------------------------------------------------------------
 * 跑工具的子进程，把输出收集起来给界面看。
 *
 * 同一时间只允许跑一个：三个工具都要开浏览器、抢调试端口，并行跑只会互相打架。
 * ------------------------------------------------------------------ */
import { spawn } from 'node:child_process';
import { readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildArgs, applyConfig, missingRequired } from './args.mjs';
import { entryFor, locate } from './tools.mjs';

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

    const state = () => (current ? {
        running: true,
        tool: current.tool.id,
        name: current.tool.name,
        startedAt: current.startedAt,
        status: current.status,
        lines: current.lines,
        exit: null,
    } : { running: false, tool: null, name: null, startedAt: null, status: '', lines: [], exit: lastExit });

    let lastExit = null;

    function push(line) {
        if (!current) return;
        if (line.startsWith(STATUS_PREFIX)) {
            current.status = line.slice(STATUS_PREFIX.length);
            emit({ type: 'status', status: current.status });
            return;
        }
        current.lines.push(line);
        if (current.lines.length > MAX_LINES) current.lines.splice(0, current.lines.length - MAX_LINES);
        emit({ type: 'line', line });
    }

    /* 子进程的输出是按块来的，要自己按行切 */
    function reader() {
        let buffer = '';
        return (chunk) => {
            buffer += chunk.toString();
            const parts = buffer.split(/\r?\n/);
            buffer = parts.pop() ?? '';
            for (const part of parts) if (part.trim()) push(part.replace(/\r/g, ''));
        };
    }

    /* config 类工具：先把界面上的值写进它自己的配置文件 */
    async function writeConfig(tool, dir, values) {
        const name = tool.configFile[platform] || tool.configFile.linux;
        const file = resolve(dir, name);
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
                status: '正在启动…',
                lines: [],
            };
            lastExit = null;
            emit({ type: 'started', tool: tool.id, name: tool.name });

            child.stdout?.on('data', reader());
            child.stderr?.on('data', reader());
            child.on('error', (error) => push(`启动失败：${error.message}`));
            child.on('close', (code, signal) => {
                lastExit = { code, signal, at: Date.now(), tool: tool.id, name: tool.name };
                current = null;
                emit({ type: 'exit', ...lastExit });
            });
            return state();
        },

        stop() {
            if (!current) return false;
            /* 先温和地停：两个 Node 工具收到 SIGINT 会自己收尾 */
            current.child.kill('SIGINT');
            const child = current.child;
            setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 8000).unref?.();
            return true;
        },
    };
}
