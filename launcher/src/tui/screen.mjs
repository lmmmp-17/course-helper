/* ------------------------------------------------------------------
 * 终端：备用屏幕、raw 模式、按键、整帧绘制。
 *
 * 只用 VT 序列。Windows 10 以上的控制台由 Node（libuv）自己打开 VT 支持，
 * 方向键在 raw 模式下也会被翻译成同样的转义序列。
 *
 * 任何方式退出（正常、信号、未捕获的异常）都要把终端恢复原样，不然用户的
 * 命令行就留在备用屏幕里、光标也看不见了。
 * ------------------------------------------------------------------ */
import { textWidth, truncate } from './width.mjs';

const ESC = '\x1b[';
export const STYLE = {
    plain: '',
    soft: `${ESC}90m`,          /* 灰：说明文字、时间 */
    strong: `${ESC}1m`,
    mark: `${ESC}30;43m`,       /* 荧光笔：只标正在发生的事 */
    pen: `${ESC}31m`,           /* 红笔：错误 */
    penStrong: `${ESC}1;31m`,
    focus: `${ESC}7m`,          /* 反色：键盘焦点 */
};
const RESET = `${ESC}0m`;

/* 一行由若干段组成：[{ text, style }]。按显示宽度截到 width，保证不越过右边 */
export function renderRow(segments, width) {
    let out = '';
    let used = 0;
    for (const { text, style = '' } of segments) {
        if (used >= width) break;
        const piece = truncate(text, width - used, '');
        if (!piece) continue;
        out += style ? `${style}${piece}${RESET}` : piece;
        used += textWidth(piece);
    }
    return out;
}

/* 按键解析：把 raw 模式下读到的字节切成一个个按键 */
const SEQUENCES = [
    ['\x1b[A', 'up'], ['\x1b[B', 'down'], ['\x1b[C', 'right'], ['\x1b[D', 'left'],
    ['\x1bOA', 'up'], ['\x1bOB', 'down'], ['\x1bOC', 'right'], ['\x1bOD', 'left'],
    ['\x1b[5~', 'pageup'], ['\x1b[6~', 'pagedown'], ['\x1b[3~', 'delete'],
    ['\x1b[H', 'home'], ['\x1b[F', 'end'], ['\x1b[1~', 'home'], ['\x1b[4~', 'end'], ['\x1bOH', 'home'], ['\x1bOF', 'end'],
    ['\x1b[Z', 'backtab'],
];

export function parseKeys(chunk) {
    const keys = [];
    let rest = String(chunk);
    while (rest) {
        const seq = SEQUENCES.find(([s]) => rest.startsWith(s));
        if (seq) { keys.push({ name: seq[1] }); rest = rest.slice(seq[0].length); continue; }
        if (rest.startsWith('\x1b[')) {
            /* 认不出的 CSI 序列整段丢掉，不要当成普通字符输进输入框 */
            const end = rest.slice(2).search(/[@-~]/);
            rest = end < 0 ? '' : rest.slice(end + 3);
            continue;
        }
        const char = String.fromCodePoint(rest.codePointAt(0));
        rest = rest.slice(char.length);
        if (char === '\x1b') keys.push({ name: 'escape' });
        else if (char === '\x03') keys.push({ name: 'ctrl-c' });
        else if (char === '\r' || char === '\n') keys.push({ name: 'enter' });
        else if (char === '\t') keys.push({ name: 'tab' });
        else if (char === '\x7f' || char === '\b') keys.push({ name: 'backspace' });
        else if (char === ' ') keys.push({ name: 'space', char });
        else if (char >= ' ') keys.push({ name: 'char', char });
    }
    return keys;
}

export function openScreen({ input = process.stdin, output = process.stdout } = {}) {
    let closed = false;
    const write = (text) => { if (!closed) output.write(text); };

    /* 备用屏幕、藏光标、关自动换行（超出右边的直接截掉，不会把下一行挤乱） */
    write(`${ESC}?1049h${ESC}?25l${ESC}?7l${ESC}2J`);
    if (input.isTTY) input.setRawMode(true);
    input.resume();
    input.setEncoding?.('utf8');

    function close() {
        if (closed) return;
        output.write(`${RESET}${ESC}?7h${ESC}?25h${ESC}?1049l`);
        closed = true;
        if (input.isTTY) input.setRawMode(false);
        input.pause();
    }
    /* 正常退出、被信号结束、程序崩了，都要先把终端还回去 */
    const onExit = () => close();
    process.on('exit', onExit);

    return {
        get width() { return output.columns || 80; },
        get height() { return output.rows || 24; },
        onKeys(handler) {
            const listener = (chunk) => { for (const key of parseKeys(chunk)) handler(key); };
            input.on('data', listener);
            return () => input.off('data', listener);
        },
        onResize(handler) {
            output.on('resize', handler);
            return () => output.off('resize', handler);
        },
        /* rows：每行一组段落。每行都用绝对位置写、写完清到行尾，宽度算错也不会串行 */
        draw(rows) {
            let out = '';
            for (let i = 0; i < this.height; i += 1) {
                out += `${ESC}${i + 1};1H${renderRow(rows[i] || [], this.width)}${ESC}K`;
            }
            write(out);
        },
        close() {
            close();
            process.off('exit', onExit);
        },
    };
}
