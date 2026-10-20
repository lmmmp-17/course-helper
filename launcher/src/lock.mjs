/* ------------------------------------------------------------------
 * 同一时间只能有一个后端在跑。
 *
 * 窗口版和终端版各自都能启动工具。两个一起开的话，同一个平台会被启动两次，
 * 抢同一个专用浏览器和调试端口。所以用一个锁文件互斥，记下是谁占着：
 *   { pid, kind: 'gui' | 'tui' | 'web', since }
 * 占锁的进程已经不在了（崩溃、被强杀），锁就当作失效，直接接手。
 * ------------------------------------------------------------------ */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export const KIND_NAMES = { gui: '窗口版', tui: '终端版', web: '浏览器版' };

function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        /* 进程在，只是没权限发信号 */
        return e.code === 'EPERM';
    }
}

export function lockFile(dir) {
    return (dir.includes('\\') ? win32.join : posix.join)(dir, 'launcher.lock');
}

export function readLock(dir) {
    try {
        const data = JSON.parse(readFileSync(lockFile(dir), 'utf8'));
        return Number.isInteger(data.pid) ? data : null;
    } catch (e) {
        return null;
    }
}

/* 拿到锁返回 { ok: true, release }；被别人占着返回 { ok: false, holder } */
export function acquireLock({ dir, kind, pid = process.pid, isAlive = alive, now = Date.now }) {
    mkdirSync(dir, { recursive: true });
    const file = lockFile(dir);
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const fd = openSync(file, 'wx');
            writeSync(fd, JSON.stringify({ pid, kind, since: now() }));
            closeSync(fd);
            return {
                ok: true,
                file,
                release() {
                    /* 只删自己的：万一锁已经被别人接手了，不能把人家的删掉 */
                    if (readLock(dir)?.pid !== pid) return;
                    try { unlinkSync(file); } catch (e) { /* 已经没了 */ }
                },
            };
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            const holder = readLock(dir);
            if (holder && holder.pid !== pid && isAlive(holder.pid)) return { ok: false, file, holder };
            /* 失效的锁（或者读不出来的坏文件）：删掉再抢一次 */
            try { unlinkSync(file); } catch (err) { /* 别人刚删了 */ }
        }
    }
    return { ok: false, file, holder: readLock(dir) };
}

/* 给人看的一句话：谁占着、怎么办 */
export function describeHolder(holder, file) {
    const who = KIND_NAMES[holder?.kind] || '另一个';
    return `${who}的网课助手正在运行，先在那边退出，再打开这里。`
        + `（确定没有在运行的话，删掉 ${file} 再试）`;
}
