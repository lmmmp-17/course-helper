/* 日志分档，默认只打印关键状态：输出本身没必要刷屏，排障时再调高。
 *
 * 另外带一条「状态行」：播一个视频要十几分钟，这期间如果终端一行不打，
 * 用户没法判断脚本是在正常跑还是卡住了。状态行在终端里就地刷新（不往下滚），
 * 输出被重定向到文件时则退化成每分钟记一行，不会把日志刷满。
 */
const LEVELS = { silent: 0, quiet: 1, normal: 2, verbose: 3 };

/* 状态行写进文件时的最小间隔 */
const FILE_STATUS_INTERVAL_MS = 60_000;

export function createLogger(level = 'quiet', options = {}) {
    const rank = LEVELS[level] ?? LEVELS.quiet;
    const stream = options.stream ?? process.stdout;
    const live = options.isTty ?? Boolean(stream.isTTY);
    const now = options.now ?? (() => Date.now());
    const stamp = () => new Date().toTimeString().slice(0, 8);

    let statusText = '';
    let lastFileStatusAt = 0;

    /* 终端里状态行停在当前行上，打别的内容之前要先把它擦掉，打完再画回来 */
    const eraseLine = () => { if (live && statusText) stream.write('\r\u001b[2K'); };
    const redrawLine = () => { if (live && statusText) stream.write(statusText); };

    const write = (min, out, args) => {
        if (rank < min) return;
        eraseLine();
        out(`[${stamp()}]`, ...args);
        redrawLine();
    };

    return {
        level,
        say: (...args) => write(LEVELS.quiet, console.log, args),
        note: (...args) => write(LEVELS.normal, console.log, args),
        trace: (...args) => write(LEVELS.verbose, console.log, args),
        warn: (...args) => write(LEVELS.silent + 1, console.warn, args),
        error: (...args) => {
            eraseLine();
            console.error(`[${stamp()}]`, ...args);
            redrawLine();
        },

        /* 当前在干什么。反复调用只刷新同一行 */
        status(text) {
            if (rank < LEVELS.quiet) return;
            if (live) {
                statusText = text;
                stream.write(`\r\u001b[2K${text}`);
                return;
            }
            /* 非终端（重定向到文件、后台运行）：按间隔落一行，保留时间戳 */
            if (now() - lastFileStatusAt < FILE_STATUS_INTERVAL_MS) return;
            lastFileStatusAt = now();
            console.log(`[${stamp()}] ${text}`);
        },

        /* 状态结束：把那一行收掉，后面的输出从干净的一行开始 */
        clearStatus() {
            if (live && statusText) stream.write('\r\u001b[2K');
            statusText = '';
        },
    };
}
