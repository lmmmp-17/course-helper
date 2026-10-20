#!/usr/bin/env node
/* ------------------------------------------------------------------
 * 统一启动器：开一个本地控制台，在里面挑工具、填选项、看进度。
 *
 * 零依赖，只用 Node 自带的东西。Ctrl+C 退出；退出时会把正在跑的工具一起停掉。
 * ------------------------------------------------------------------ */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createRunner } from './src/runner.mjs';
import { startServer } from './src/server.mjs';
import { openInBrowser } from './src/open.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

function parse(argv) {
    const options = { port: 0, open: true };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--port') { options.port = Number(argv[i + 1]) || 0; i += 1; continue; }
        if (argv[i] === '--no-open') { options.open = false; continue; }
        if (argv[i] === '--help' || argv[i] === '-h') { options.help = true; continue; }
        throw new Error(`无法识别的参数: ${argv[i]}`);
    }
    return options;
}

const HELP = `
网课助手（统一启动器）

用法
  Windows：双击 start.cmd；Linux / macOS：./start.sh
  或者：node run.mjs [选项]

选项
  --port <端口>   指定本地端口，默认随机
  --no-open       不自动打开浏览器，只打印地址
  --help          显示这段说明

控制台会在你平时用的浏览器里打开（不是脚本启动的那个专用 Chrome / Edge——
课程页得留在它自己的窗口里，不然会变成后台标签）。
`.trim();

async function main() {
    const options = parse(process.argv.slice(2));
    if (options.help) { console.log(HELP); return 0; }

    const runner = createRunner({ root: ROOT });
    const server = await startServer({
        root: ROOT,
        runner,
        publicDir: resolve(ROOT, 'public'),
        port: options.port,
    });

    console.log('控制台已就绪：');
    console.log(`  ${server.url}`);
    console.log('');
    if (options.open && openInBrowser(server.url)) {
        console.log('已经用你的默认浏览器打开了。没弹出来的话，手动复制上面那条地址。');
    } else {
        console.log('请把上面那条地址复制到浏览器里打开。');
    }
    console.log('按 Ctrl+C 退出（正在跑的工具会全部停掉）。');

    await new Promise((done) => {
        const bye = () => {
            console.log('\n正在退出…');
            runner.stop();
            server.close().finally(done);
        };
        process.on('SIGINT', bye);
        process.on('SIGTERM', bye);
    });
    return 0;
}

main().then(
    (code) => process.exit(code ?? 0),
    (error) => { console.error(`\n${error.message}`); process.exit(1); },
);
