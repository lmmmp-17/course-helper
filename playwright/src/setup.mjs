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

/* 国内镜像。用这个工具的人大多在国内，registry.npmjs.org 从很多网络上很慢或者连不上，
 * 所以默认走镜像；用户自己在 npm 里配过源的话听用户的。镜像装不上再用官方源试一次。
 * 带 --registry 时 npm 只替换下载地址，package-lock.json 不变（实测）。 */
export const MIRROR = 'https://registry.npmmirror.com/';
export const OFFICIAL = 'https://registry.npmjs.org/';

/* npm 在 Windows 上是 npm.cmd，Node 20 起不经过 shell 不能直接启动 .cmd，
 * 所以统一走 shell。命令是写死的，没有拼接任何外部输入。 */
export function registriesToTry({ dir = APP_DIR, run = spawnSync } = {}) {
    const result = run('npm config get registry', { cwd: dir, shell: true, encoding: 'utf8' });
    const configured = String(result.stdout || '').trim().replace(/\/?$/, '/');
    /* 用户自己配了别的源（公司内网、别的镜像）：只用它 */
    if (!result.error && result.status === 0 && configured !== '/' && configured !== OFFICIAL) return [null];
    return [MIRROR, OFFICIAL];
}

export function installDependencies(log, { dir = APP_DIR, run = spawnSync } = {}) {
    log.say('正在安装依赖（npm install，只装 playwright-core，不下载浏览器）...');
    const registries = registriesToTry({ dir, run });
    for (const [i, registry] of registries.entries()) {
        if (i) log.say('从国内镜像没装上，改用官方源再试一次...');
        const flag = registry ? ` --registry=${registry}` : '';
        const result = run(`npm install --no-audit --no-fund${flag}`, { cwd: dir, stdio: 'inherit', shell: true });
        if (!result.error && result.status === 0) return;
    }
    throw new Error(
        registries.length > 1
            ? '依赖安装失败（国内镜像和官方源都试过了）。检查网络后重新运行即可。'
            : '依赖安装失败。你的 npm 配了自己的源，检查它能不能连上，或者执行 npm config delete registry 改回默认。'
    );
}

export function ensureInstalled(log, { force = false, ...options } = {}) {
    if (!force && isInstalled(options.dir)) return false;
    installDependencies(log, options);
    return true;
}
