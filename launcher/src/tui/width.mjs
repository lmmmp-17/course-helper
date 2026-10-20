/* ------------------------------------------------------------------
 * 终端里的显示宽度：中文、全角符号占两列，其余占一列。
 *
 * 界面自己用的装饰一律是 ASCII（[x]、(o)、> 之类）：箭头、▶、框线字符
 * 在 East Asian Width 里是「宽度不定」，中文 Windows 控制台会画成两列，
 * 布局就错位了。工具日志里的字符管不了，所以每一行都按这里算宽度截断，
 * 再配合关掉终端的自动换行（screen.mjs），多出来的也只会被截掉。
 * ------------------------------------------------------------------ */

/* 占两列的区间（East Asian Width 为 W / F 的主要部分，加上常见的 emoji） */
const WIDE = [
    [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
    [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
    [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
    [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
    [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
    [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
    [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f],
    [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
    [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f251],
    [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff],
    [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

/* 不占位置的：组合附加符号、零宽字符、变体选择符 */
const ZERO = [
    [0x0300, 0x036f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
    [0x1f3fb, 0x1f3ff], [0xe0100, 0xe01ef],
];

const inRanges = (code, ranges) => {
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (code < ranges[mid][0]) hi = mid - 1;
        else if (code > ranges[mid][1]) lo = mid + 1;
        else return true;
    }
    return false;
};

export function charWidth(char) {
    const code = char.codePointAt(0);
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
    if (inRanges(code, ZERO)) return 0;
    return inRanges(code, WIDE) ? 2 : 1;
}

export function textWidth(text) {
    let width = 0;
    for (const char of String(text)) width += charWidth(char);
    return width;
}

/* 截到不超过 width 列。被截掉的话末尾换成 ...，一个宽字符放不下就用空格补齐 */
export function truncate(text, width, ellipsis = '...') {
    text = String(text);
    if (textWidth(text) <= width) return text;
    const room = Math.max(0, width - ellipsis.length);
    let out = '';
    let used = 0;
    for (const char of text) {
        const w = charWidth(char);
        if (used + w > room) break;
        out += char;
        used += w;
    }
    return `${out}${' '.repeat(room - used)}${ellipsis.slice(0, width)}`;
}

/* 截断后用空格补到正好 width 列 */
export function fit(text, width) {
    const cut = truncate(text, width);
    return cut + ' '.repeat(Math.max(0, width - textWidth(cut)));
}

/* 按显示宽度折行：英文尽量在空格处断，中文哪里都能断 */
export function wrap(text, width) {
    const lines = [];
    for (const paragraph of String(text).split('\n')) {
        let line = '';
        let used = 0;
        let lastSpace = -1;
        for (const char of paragraph) {
            const w = charWidth(char);
            if (used + w > width && line) {
                /* 正好断在空格上：空格不带到下一行开头 */
                if (char === ' ') {
                    lines.push(line);
                    line = '';
                    used = 0;
                    lastSpace = -1;
                    continue;
                }
                if (lastSpace > 0 && /[\x21-\x7e]/.test(char)) {
                    lines.push(line.slice(0, lastSpace));
                    line = line.slice(lastSpace + 1);
                } else {
                    lines.push(line);
                    line = '';
                }
                used = textWidth(line);
                lastSpace = -1;
            }
            if (char === ' ') lastSpace = line.length;
            line += char;
            used += w;
        }
        lines.push(line);
    }
    return lines;
}
