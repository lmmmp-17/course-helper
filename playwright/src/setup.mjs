/* ------------------------------------------------------------------
 * 第一次运行时自动安装依赖
 *
 * 唯一的依赖是 playwright-core（不下载浏览器）。以前要求用户先手动 npm install，
 * 现在 run.mjs 启动时看一眼，没装就自己装，用户只需要运行一个入口。
 * ------------------------------------------------------------------ */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

export function isInstalled(dir = APP_DIR) {
    return existsSync(join(dir, 'node_modules', 'playwright-core', 'package.json'));
}

/* npm 在 Windows 上是 npm.cmd，Node 20 起不经过 shell 不能直接启动 .cmd，
 * 所以统一走 shell。命令是写死的，没有拼接任何外部输入。 */
export function installDependencies(log, { dir = APP_DIR, run = spawnSync } = {}) {
    log.say('正在安装依赖（npm install，只装 playwright-core，不下载浏览器）...');
    const result = run('npm install --no-audit --no-fund', { cwd: dir, stdio: 'inherit', shell: true });
    if (result.error || result.status !== 0) {
        throw new Error(
            '依赖安装失败。检查网络后重新运行即可。\n' +
            '国内网络慢的话，可以先执行这一句换成国内镜像，再重新运行：\n' +
            '  npm config set registry https://registry.npmmirror.com'
        );
    }
}

export function ensureInstalled(log, { force = false, ...options } = {}) {
    if (!force && isInstalled(options.dir)) return false;
    installDependencies(log, options);
    return true;
}
