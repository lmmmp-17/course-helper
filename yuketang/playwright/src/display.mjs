/* 给普通用户看的几个小格式化函数：进度条、时长、标题截断。
 * 这些只影响终端显示，不参与任何判断。 */

export function formatTime(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const m = String(Math.floor(total / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return `${m}:${s}`;
}

/* 分钟数说成人话：「42 分钟」「1 小时 05 分」 */
export function formatDuration(ms) {
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) return '不到 1 分钟';
    if (minutes < 60) return `${minutes} 分钟`;
    return `${Math.floor(minutes / 60)} 小时 ${String(minutes % 60).padStart(2, '0')} 分`;
}

export function bar(ratio, width = 10) {
    const safe = Math.max(0, Math.min(1, Number(ratio) || 0));
    const filled = Math.round(safe * width);
    return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/* 标题可能很长，截断时按中文字符占两格估宽，避免把状态行撑到换行 */
export function clip(text, maxColumns = 24) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    let columns = 0;
    let out = '';
    for (const ch of value) {
        const w = /[⺀-鿿＀-￯]/.test(ch) ? 2 : 1;
        if (columns + w > maxColumns) return `${out}…`;
        columns += w;
        out += ch;
    }
    return out;
}
