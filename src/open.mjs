/* ------------------------------------------------------------------
 * 用系统默认浏览器打开控制台。
 *
 * 为什么不开在脚本自己启动的那个专用 Chrome 里：那些工具要靠课程页的
 * document.visibilityState 保持 visible 才能持续播放，而这一项没有办法模拟。
 * 控制台要是跟课程页同在一个窗口里，你一切过去课程页就变成后台标签了。
 * 开在你平时用的浏览器里（另一个进程、另一个窗口）就没这个问题。
 * ------------------------------------------------------------------ */
import { spawn } from 'node:child_process';

export function openCommand(url, platform = process.platform) {
    if (platform === 'win32') {
        /* start 的第一个引号参数会被当成窗口标题，所以要先给一个空标题 */
        return { command: 'cmd', args: ['/c', 'start', '', url], shell: false };
    }
    if (platform === 'darwin') return { command: 'open', args: [url], shell: false };
    return { command: 'xdg-open', args: [url], shell: false };
}

export function openInBrowser(url, { platform = process.platform, spawnProcess = spawn } = {}) {
    const { command, args, shell } = openCommand(url, platform);
    try {
        const child = spawnProcess(command, args, { shell, detached: true, stdio: 'ignore' });
        child.on?.('error', () => {});
        child.unref?.();
        return true;
    } catch (e) {
        return false;
    }
}
