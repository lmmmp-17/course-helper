#!/usr/bin/env node
/* ------------------------------------------------------------------
 * 网课助手的后端入口：挑工具、填选项、看进度，三个平台可以同时跑。
 *
 * 零依赖，只用 Node 自带的东西。几种界面共用同一个后端和同一份设置
 * （settings.mjs），同一时间只能开一个（lock.mjs）：
 *   --web        在默认浏览器里打开控制台（排错用）
 *   --handshake  给 Windows 窗口版外壳用：只往 stdout 打一行 JSON，
 *                stdin 关掉就停掉所有工具再退出
 * 退出时会把正在跑的工具一起停掉，等它们收完尾再走。
 * ------------------------------------------------------------------ */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createRunner, STOP_GRACE_MS } from './src/runner.mjs';
import { startServer } from './src/server.mjs';
import { openInBrowser } from './src/open.mjs';
import { createSettings } from './src/settings.mjs';
import { acquireLock, describeHolder } from './src/lock.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

function parse(argv) {
    const options = { port: 0, open: true, handshake: false };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--port') { options.port = Number(argv[i + 1]) || 0; i += 1; continue; }
        if (argv[i] === '--no-open') { options.open = false; continue; }
        if (argv[i] === '--web') { continue; }
        if (argv[i] === '--handshake') { options.handshake = true; options.open = false; continue; }
        if (argv[i] === '--help' || argv[i] === '-h') { options.help = true; continue; }
        throw new Error(`无法识别的参数: ${argv[i]}`);
    }
    return options;
}

const HELP = `
网课助手

用法
  Windows：双击 网课助手.exe（窗口版）；Linux / macOS：./start.sh
  或者：node launcher/run.mjs [选项]

选项
  --web           在你的默认浏览器里打开控制台
  --port <端口>   指定本地端口，默认随机
  --no-open       不自动打开浏览器，只打印地址
  --help          显示这段说明

控制台不会开在脚本启动的那个专用 Chrome / Edge 里：
课程页得留在它自己的窗口里，不然会变成后台标签。
`.trim();

async function main() {
    const options = parse(process.argv.slice(2));
    if (options.help) { console.log(HELP); return 0; }

    /* 窗口版外壳只读 stdout 的第一行，其余的话都写到 stderr */
    const say = options.handshake ? (text) => process.stderr.write(`${text}\n`) : (text) => console.log(text);
    const reply = (data) => process.stdout.write(`${JSON.stringify(data)}\n`);

    const settings = createSettings();
    const lock = acquireLock({ dir: settings.dir, kind: options.handshake ? 'gui' : 'web' });
    if (!lock.ok) {
        const message = describeHolder(lock.holder, lock.file);
        if (options.handshake) reply({ ready: false, error: 'locked', holder: lock.holder, message });
        else console.error(message);
        return 3;
    }
    process.on('exit', () => lock.release());

    const runner = createRunner({ root: ROOT, settings });
    const server = await startServer({
        root: ROOT,
        runner,
        settings,
        publicDir: resolve(ROOT, 'public'),
        port: options.port,
    });

    if (options.handshake) {
        reply({ ready: true, url: server.url });
    } else {
        say('控制台已就绪：');
        say(`  ${server.url}`);
        say('');
        if (options.open && openInBrowser(server.url)) {
            say('已经用你的默认浏览器打开了。没弹出来的话，手动复制上面那条地址。');
        } else {
            say('请把上面那条地址复制到浏览器里打开。');
        }
        say('按 Ctrl+C 退出（正在跑的工具会全部停掉）。');
    }

    await new Promise((done) => {
        let leaving = false;
        const bye = async () => {
            /* 再按一次 Ctrl+C：不等了 */
            if (leaving) process.exit(1);
            leaving = true;
            const live = runner.running();
            say(live.length ? `\n正在停止 ${live.length} 个在跑的工具，等它们收尾…（再按一次 Ctrl+C 直接退出）` : '\n正在退出…');
            runner.stop();
            /* 等工具收完尾再走：后端先退的话，工具收尾时往已经关掉的管道里写日志会出错 */
            await runner.whenIdle(STOP_GRACE_MS + 2000);
            server.close().finally(done);
        };
        process.on('SIGINT', bye);
        process.on('SIGTERM', bye);
        if (options.handshake) {
            /* 窗口关了（或者外壳被强杀），管道就断了：照样收尾，不留孤儿进程 */
            process.stdin.on('end', bye);
            process.stdin.on('error', bye);
            process.stdin.resume();
        }
    });
    return 0;
}

main().then(
    (code) => process.exit(code ?? 0),
    (error) => { console.error(`\n${error.message}`); process.exit(1); },
);
