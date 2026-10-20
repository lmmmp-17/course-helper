/* ------------------------------------------------------------------
 * 怎么把运行状态说给人听：日志行、结束原因、已运行时长、这次的设置。
 *
 * 终端版用这里的实现；窗口版（public/index.html）是静态页面，里面有一份
 * 同样的逻辑，改说法时两边一起改，保证两个入口说的是同一句话。
 * ------------------------------------------------------------------ */

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export const clock = (at) => new Date(at).toTimeString().slice(0, 8);

/* 两种格式：Node 工具是 "[12:01:03] 内容"，警告和错误走 stderr；
 * Autovisor 是 "[INFO] 内容"，不带时间 */
export function parseLine(entry) {
    let text = String(entry.line).replace(ANSI, '').trimEnd();
    let time = null;
    let level = entry.err ? 'warn' : '';
    let match = text.match(/^\[(\d{2}:\d{2}:\d{2})(?:\.\d+)?\]\s*/);
    if (match) { time = match[1]; text = text.slice(match[0].length); }
    match = text.match(/^\[(INFO|WARN|ERROR)\]\s*/);
    if (match) {
        level = match[1] === 'ERROR' ? 'error' : match[1] === 'WARN' ? 'warn' : level;
        text = text.slice(match[0].length);
    }
    return { time: time || clock(entry.at), text: text.trim(), level };
}

export function since(start, now = Date.now()) {
    const s = Math.max(0, Math.floor((now - start) / 1000));
    const h = Math.floor(s / 3600);
    const m = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
    return `${h ? `${h}:` : ''}${m}:${String(s % 60).padStart(2, '0')}`;
}

export function exitText(exit) {
    if (exit.stopped) return { text: `${exit.name} 已停止`, failed: false };
    if (exit.code === 0) return { text: `${exit.name} 跑完了`, failed: false };
    const why = exit.code === null ? `被系统结束（${exit.signal}）` : `退出码 ${exit.code}`;
    return { text: `${exit.name} 中途停了，${why}。原因一般在下面最后几行`, failed: true };
}

const keyOf = (option) => option.flag || option.key.join('.');

/* 这次用了什么设置，一行字。返回 [{ text, warn }]，没开静音那一项要用红笔 */
export function summarize(tool, used) {
    const parts = [];
    for (const option of tool.options) {
        const key = keyOf(option);
        if (!(key in used) || option.type === 'password') continue;
        const value = used[key];
        if (option.type === 'bool') {
            if (option.role === 'mute') parts.push(value ? { text: '静音' } : { text: '会外放声音', warn: true });
            else if (value) parts.push({ text: option.label });
            continue;
        }
        if (option.type === 'select') {
            const choice = option.choices.find((c) => c.value === String(value));
            parts.push({ text: `${option.label} ${choice ? choice.label : value}` });
            continue;
        }
        const text = String(value ?? '').trim();
        if (text) parts.push({ text: `${option.label} ${text.length > 36 ? `${text.slice(0, 36)}...` : text}` });
    }
    return parts.length ? parts : [{ text: '默认设置' }];
}
