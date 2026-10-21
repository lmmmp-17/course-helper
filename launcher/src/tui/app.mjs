/* ------------------------------------------------------------------
 * 终端版界面（TUI）：和窗口版同一个后端、同一份设置，信息结构也一样。
 * 布局照设计稿 design/new/wangke-design/tui.txt：
 *
 *    网课助手      1 学习通 >12:34      2 长江雨课堂      3 智慧树 停了
 *   -----------------------------------------------------------------
 *                 平台说明
 *           设置  一行摘要            （开始前；C 展开成「全部设置」）
 *                 [x] 静音
 *                   Enter 开始：学习通
 *     已运行 0:12  当前状态（荧光笔）
 *           记录  最新一行 刚刚
 *       23:29:16  日志……
 *   -----------------------------------------------------------------
 *    按键说明（随状态变）
 *
 * 页边 14 列、右对齐，之后空 2 列是正文。装饰只用 ASCII（见 width.mjs）。
 * 状态和渲染分开：createApp 只管状态、按键和「这一帧长什么样」，不碰终端。
 * ------------------------------------------------------------------ */
import { byId, describe } from '../tools.mjs';
import { STYLE, openScreen } from './screen.mjs';
import { fit, textWidth, wrap } from './width.mjs';
import { NOTE_PREP, NOTE_RUN, ago, clock, exitText, parseLine, phaseAfter, since, summarize } from '../present.mjs';

const MAX_LOG = 1000;
const MARGIN = 14;
const MIN_WIDTH = 60;
const MIN_HEIGHT = 18;

const keyOf = (option) => option.flag || option.key.join('.');

function initialValue(option) {
    if (option.current !== undefined) return option.current;
    if (option.remembered !== undefined && option.type !== 'password') return option.remembered;
    if (option.default !== undefined) return option.default;
    return option.type === 'bool' ? false : '';
}

/* 页边：右对齐到 14 列，再空两列 */
const margin = (text = '', style = STYLE.soft) => [{ text: `${' '.repeat(Math.max(0, MARGIN - textWidth(text)))}${text}  `, style }];
const indent = () => [{ text: ' '.repeat(MARGIN + 2) }];

export function createApp({ tools, runner, settings = null, now = Date.now, onChange = () => {} }) {
    const blank = () => ({
        run: null, exit: null, toolStatus: '', lastLine: '', lastAt: 0, phase: '', lines: [],
        starting: false, stopping: false, seen: true, error: '',
    });
    const runs = {};
    const runOf = (id) => (runs[id] ??= blank());
    const forms = {};
    const formOf = (tool) => (forms[tool.id] ??= {
        values: Object.fromEntries(tool.options.map((option) => [keyOf(option), initialValue(option)])),
        open: false,
        focus: 0,
        invalid: new Set(),
        problem: '',
    });

    const saved = settings?.read().picked;
    const state = {
        picked: tools.find((tool) => tool.id === saved) || tools[0],
        confirmQuit: false,
        quitting: false,
        logScroll: 0,
    };
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    const running = () => tools.filter((tool) => runOf(tool.id).run);

    function store(id, entries) {
        const run = runOf(id);
        let added = 0;
        for (const entry of entries) {
            const line = parseLine(entry);
            if (!line.text) continue;
            run.lastLine = line.text;
            run.lastAt = entry.at || now();
            run.phase = phaseAfter(run.phase, line.text);
            run.lines.push(line);
            added += 1;
        }
        if (run.lines.length > MAX_LOG) run.lines.splice(0, run.lines.length - MAX_LOG);
        return added;
    }

    /* 后端已经在跑的（理论上终端版启动时不会有，但状态机不该假设） */
    for (const [id, data] of Object.entries(runner.state().runs || {})) {
        const run = runOf(id);
        run.run = data.running ? { startedAt: data.startedAt, values: data.values } : null;
        run.exit = data.exit;
        run.toolStatus = data.status || '';
        store(id, data.lines || []);
    }

    runner.onEvent((event) => {
        const run = runOf(event.tool);
        const shown = state.picked?.id === event.tool;
        if (event.type === 'started') {
            Object.assign(run, blank(), { run: { startedAt: event.startedAt, values: event.values } });
            if (shown) state.logScroll = 0;
        } else if (event.type === 'status') {
            run.toolStatus = event.status;
        } else if (event.type === 'line') {
            const added = store(event.tool, [event]);
            /* 往上翻着看的时候，新日志进来不把视线拽走 */
            if (shown && state.logScroll > 0) state.logScroll += added;
        } else if (event.type === 'exit') {
            run.run = null;
            run.exit = event;
            run.stopping = false;
            run.phase = '';
            run.seen = shown;
        }
        onChange();
    });

    function pick(tool) {
        if (!tool || tool === state.picked) return;
        state.picked = tool;
        runOf(tool.id).seen = true;
        state.logScroll = 0;
        try { settings?.pick(tool.id); } catch (e) { /* 记不住就算了 */ }
    }
    const shift = (offset) => pick(tools[(tools.indexOf(state.picked) + offset + tools.length) % tools.length]);

    async function start(tool) {
        const run = runOf(tool.id);
        const form = formOf(tool);
        if (run.run || run.starting) return;
        run.error = '';
        form.problem = '';
        /* 数字框只收整数，和窗口版一样先在这边拦下 */
        const bad = tool.options.filter((option) => {
            const value = String(form.values[keyOf(option)] ?? '').trim();
            return option.type === 'number' && value && !/^\d+$/.test(value);
        });
        form.invalid = new Set(bad.map((option) => option.label));
        if (bad.length) {
            form.open = true;
            form.problem = `${bad.map((option) => option.label).join('、')} 要填整数`;
            onChange();
            return;
        }
        run.starting = true;
        onChange();
        try {
            await runner.start(byId(tool.id), { ...form.values });
        } catch (error) {
            run.error = error.message;
        } finally {
            run.starting = false;
            onChange();
        }
    }

    function stop(tool) {
        const run = runOf(tool.id);
        if (!run.run || run.stopping) return;
        run.stopping = true;
        runner.stop(tool.id);
    }

    async function quit() {
        state.confirmQuit = false;
        state.quitting = true;
        onChange();
        runner.stop();
        /* 等工具收完尾：它们收尾时还会往管道里写日志 */
        await runner.whenIdle(10000);
        resolveDone();
    }

    /* 改过填错的那一项，红字提示就该消失，不用等下一次 Enter */
    function touched(option, form) {
        form.invalid.delete(option.label);
        if (!form.invalid.size) form.problem = '';
    }

    function editField(option, key, form) {
        const id = keyOf(option);
        const value = form.values[id];
        if (option.type === 'bool') {
            if (key.name === 'space') { form.values[id] = !value; return true; }
            return false;
        }
        if (option.type === 'select') {
            const step = key.name === 'left' ? -1 : (key.name === 'right' || key.name === 'space') ? 1 : 0;
            if (!step) return false;
            const index = option.choices.findIndex((choice) => choice.value === String(value));
            form.values[id] = option.choices[(index + step + option.choices.length) % option.choices.length].value;
            return true;
        }
        /* 文字、数字、密码：在末尾输入和删除 */
        const text = String(value ?? '');
        if (key.name === 'backspace') { form.values[id] = [...text].slice(0, -1).join(''); touched(option, form); return true; }
        const char = key.name === 'space' ? ' ' : key.name === 'char' ? key.char : null;
        if (char === null) return false;
        form.values[id] = text + char;
        touched(option, form);
        return true;
    }

    /* 展开的设置里，静音排在最后（和窗口版一样单独一行） */
    const fieldsOf = (tool) => [...tool.options.filter((o) => o.role !== 'mute'), ...tool.options.filter((o) => o.role === 'mute')];
    const muteOf = (tool) => tool.options.find((option) => option.role === 'mute');

    function handleKey(key) {
        if (state.quitting) {
            if (key.name === 'ctrl-c') process.exit(1);
            return;
        }
        if (state.confirmQuit) {
            if (key.name === 'char' && /^[yY]$/.test(key.char)) quit();
            else if (key.name === 'ctrl-c') quit();
            else state.confirmQuit = false;
            onChange();
            return;
        }
        const tool = state.picked;
        const run = runOf(tool.id);
        const form = formOf(tool);
        const char = key.name === 'char' ? key.char : '';
        const editingForm = tool.ready && !run.run && form.open;
        const fields = fieldsOf(tool);
        form.focus = Math.min(form.focus, Math.max(0, fields.length - 1));
        const focused = editingForm ? fields[form.focus] : null;
        const typing = focused && ['text', 'number', 'password'].includes(focused.type);

        if (key.name === 'ctrl-c' || (/^[qQ]$/.test(char) && !typing)) {
            if (running().length) state.confirmQuit = true;
            else quit();
        } else if (key.name === 'pageup') state.logScroll += 5;
        else if (key.name === 'pagedown') state.logScroll = Math.max(0, state.logScroll - 5);
        else if (key.name === 'end' && !typing) state.logScroll = 0;
        else if (/^[123]$/.test(char) && !typing) pick(tools[Number(char) - 1]);
        else if (editingForm) {
            /* 展开的设置：Tab / 上下换一项，空格勾选、左右切换，Esc 收起，Enter 开始 */
            if (key.name === 'tab' || key.name === 'down') form.focus = (form.focus + 1) % fields.length;
            else if (key.name === 'backtab' || key.name === 'up') form.focus = (form.focus - 1 + fields.length) % fields.length;
            else if (key.name === 'escape') form.open = false;
            else if (key.name === 'enter') start(tool);
            else editField(focused, key, form);
        } else if (key.name === 'tab') shift(1);
        else if (key.name === 'backtab') shift(-1);
        else if (run.run) {
            if (/^[sS]$/.test(char)) stop(tool);
        } else if (tool.ready) {
            const mute = muteOf(tool);
            if (key.name === 'enter') start(tool);
            else if (/^[mM]$/.test(char) && mute) form.values[keyOf(mute)] = !form.values[keyOf(mute)];
            else if (/^[cC]$/.test(char)) { form.open = true; form.focus = 0; }
        }
        onChange();
    }

    /* ---------- 画面 ---------- */

    function tabsRow() {
        const row = [{ text: ' 网课助手      ', style: STYLE.strong }];
        tools.forEach((tool, i) => {
            const run = runOf(tool.id);
            const picked = tool === state.picked;
            row.push({ text: `${i + 1} `, style: STYLE.soft });
            row.push({ text: picked ? ` ${tool.name} ` : tool.name, style: picked ? STYLE.mark : tool.ready ? STYLE.plain : STYLE.soft });
            if (!tool.ready) row.push({ text: ' 没找到', style: STYLE.soft });
            else if (run.run) row.push({ text: ` >${since(run.run.startedAt, now())}`, style: STYLE.strong });
            else if (run.starting) row.push({ text: ' 启动中...', style: STYLE.soft });
            else if (run.exit && !run.seen && exitText(run.exit).failed) row.push({ text: ' 停了', style: STYLE.penStrong });
            row.push({ text: '      ' });
        });
        return row;
    }

    const rule = (width) => [{ text: ` ${'-'.repeat(Math.max(0, width - 2))}`, style: STYLE.soft }];
    const bodyWidth = (width) => Math.max(10, width - MARGIN - 2);
    const prose = (text, width, style = STYLE.soft) => wrap(text, bodyWidth(width)).map((line) => [...indent(), { text: line, style }]);

    /* expanded：展开的「全部设置」里每项前面留两格放焦点标记 >；收起时的静音那一行不留 */
    function fieldRows(tool, option, form, focused, width, expanded = true) {
        const value = form.values[keyOf(option)];
        const wrong = form.invalid.has(option.label);
        const mark = { text: expanded ? (focused ? '> ' : '  ') : '', style: STYLE.strong };
        const help = (text, style = STYLE.soft) => ({ text: `   ${text}`, style });
        if (option.type === 'bool') {
            const row = [...indent(), mark, { text: `[${value ? 'x' : ' '}] ${option.label}`, style: focused ? STYLE.focus : '' }];
            if (option.role === 'mute' && !value) row.push(help('取消静音后视频会外放声音', STYLE.penStrong));
            else if (option.help) row.push(help(option.help));
            return [row];
        }
        const label = margin(option.label, wrong ? STYLE.penStrong : STYLE.soft);
        if (option.type === 'select') {
            const row = [...label, mark];
            for (const choice of option.choices) {
                const on = String(value) === choice.value;
                row.push({ text: `(${on ? 'o' : ' '}) ${choice.label}`, style: focused && on ? STYLE.focus : '' }, { text: '  ' });
            }
            const used = row.reduce((sum, seg) => sum + textWidth(seg.text), 0);
            if (!option.help) return [row];
            /* 说明放不下就另起一行，和设计稿一样 */
            if (used + 3 + textWidth(option.help) <= width) return [[...row, help(option.help)]];
            return [row, [...indent(), { text: `    ${option.help}`, style: STYLE.soft }]];
        }
        const raw = String(value ?? '');
        const shown = option.type === 'password' ? '*'.repeat([...raw].length) : raw;
        const field = shown ? `${shown}${focused ? '_' : ''}` : '______';
        const row = [...label, mark, { text: fit(field, Math.max(6, textWidth(field))), style: focused ? STYLE.focus : '' }];
        if (!raw && option.placeholder) row.push(help(option.placeholder));
        else if (option.help) row.push(help(option.help));
        return [row];
    }

    function keyBar(tool, run, form) {
        if (state.quitting) return { text: ` 正在停止 ${running().length} 个在跑的平台，等它们收尾...（再按一次 Ctrl+C 直接退出）`, style: STYLE.pen };
        if (state.confirmQuit) return { text: ` 还有 ${running().length} 个平台在跑，退出会把它们都停掉。按 y 退出，其它键取消。`, style: STYLE.penStrong };
        const parts = [];
        if (tool.ready && !run.run && form.open) {
            parts.push('Tab / 上下 换一项', '空格 勾选、切换', 'Esc 收起', 'Enter 开始', 'Q 退出');
        } else {
            parts.push('1 2 3 切换平台');
            if (run.run) parts.push(`S 停止：${tool.name}`);
            else if (tool.ready) parts.push(run.exit ? 'Enter 再开始' : 'Enter 开始', 'M 静音开关', 'C 改设置');
            if (run.lines.length) parts.push('PgUp PgDn 翻记录');
            if (state.logScroll) parts.push('End 回到最新');
            parts.push('Q 退出');
        }
        return { text: ` ${parts.join('    ')}`, style: STYLE.soft };
    }

    function view(width, height) {
        if (width < MIN_WIDTH || height < MIN_HEIGHT) {
            return [[{ text: `终端窗口太小了，拉大一点（至少 ${MIN_WIDTH} 列 x ${MIN_HEIGHT} 行）。q 退出。`, style: STYLE.pen }]];
        }
        const tool = state.picked;
        const run = runOf(tool.id);
        const form = formOf(tool);
        const rows = [tabsRow(), rule(width)];

        if (!tool.ready) {
            rows.push([...indent(), { text: `没找到${tool.name}的程序目录：`, style: STYLE.penStrong }]);
            rows.push([...indent(), { text: tool.dir }]);
            rows.push(...prose('程序放在别处的话，在启动器目录里建一个 tools.local.json 写上实际路径（README 里有例子），再重新打开网课助手。', width));
        } else {
            rows.push(...prose(tool.hint, width).slice(0, 2));
            rows.push([]);
            if (run.run) {
                const parts = [...margin('这次的设置')];
                summarize(tool, run.run.values || {}).forEach((part, i) => {
                    if (i) parts.push({ text: '，' });
                    parts.push({ text: part.text, style: part.warn ? STYLE.penStrong : '' });
                });
                if (run.stopping) parts.push({ text: '   正在停止...一般几秒，最多 8 秒', style: STYLE.soft });
                rows.push(parts);
            } else {
                const mute = muteOf(tool);
                if (form.open) {
                    rows.push(margin('全部设置'));
                    fieldsOf(tool).forEach((option, i) => rows.push(...fieldRows(tool, option, form, i === form.focus, width)));
                } else {
                    const shown = tool.options.filter((option) => option.role !== 'mute');
                    const text = summarize({ ...tool, options: shown }, form.values).map((part) => part.text).join('，');
                    rows.push([...margin('设置'), { text }]);
                    if (mute) rows.push(...fieldRows(tool, mute, form, false, width, false));
                }
                const problem = form.problem || run.error;
                if (problem) rows.push([...indent(), { text: problem, style: STYLE.penStrong }]);
                rows.push([]);
                const label = run.starting ? ' 正在启动... ' : ` Enter ${run.exit ? '再开始' : '开始'}：${tool.name} `;
                rows.push([...indent(), { text: '  ' }, { text: label, style: run.starting ? STYLE.soft : STYLE.button }]);
            }
        }

        /* 状态那一行：页边写已运行 / 停在 / 结束。窗口版写「结束于」，
         * 这里页边只有 14 列，「结束于 13:17:38」放不下 */
        if (run.run) {
            rows.push([]);
            rows.push([...margin(`已运行 ${since(run.run.startedAt, now())}`), { text: ` ${run.toolStatus || run.lastLine || '正在启动...'} `, style: STYLE.mark }]);
            rows.push(...prose(run.phase === 'prepare' ? NOTE_PREP : NOTE_RUN, width, run.phase === 'prepare' ? '' : STYLE.soft));
        } else if (run.exit) {
            const { text, failed } = exitText(run.exit);
            rows.push([]);
            rows.push([...margin(`${failed ? '停在' : '结束'} ${clock(run.exit.at)}`), { text, style: failed ? STYLE.penStrong : STYLE.strong }]);
        }

        /* 记录占满剩下的行；最后两行留给分隔线和按键说明 */
        const room = height - rows.length - 2;
        if (room > 2 && run.lines.length) {
            rows.push([]);
            const fresh = run.run ? `最新一行 ${ago(run.lastAt, now())}` : `共 ${run.lines.length} 行`;
            const scrolled = state.logScroll ? `   （往上翻了 ${state.logScroll} 行）` : '';
            rows.push([...margin('记录'), { text: `${fresh}${scrolled}`, style: STYLE.soft }]);
            const pane = room - 2;
            const lines = run.lines;
            state.logScroll = Math.min(state.logScroll, Math.max(0, lines.length - pane));
            const end = lines.length - state.logScroll;
            for (const line of lines.slice(Math.max(0, end - pane), end)) {
                const mark = line.level === 'error' ? 'x ' : line.level === 'warn' ? '! ' : '';
                const style = line.level === 'error' ? STYLE.penStrong : line.level === 'warn' ? STYLE.pencil : '';
                rows.push([...margin(line.time), { text: `${mark}${line.text}`, style }]);
            }
        }

        while (rows.length < height - 2) rows.push([]);
        rows.length = height - 2;
        rows.push(rule(width));
        rows.push([keyBar(tool, run, form)]);
        return rows;
    }

    /* 终端窗口（或标签页）的标题，和窗口版的标题栏说法一样 */
    function title() {
        const live = running();
        const failed = tools.find((tool) => {
            const run = runOf(tool.id);
            return !run.run && run.exit && !run.seen && exitText(run.exit).failed;
        });
        if (failed) return `✕ ${failed.name} 停了${live.length ? `（还有 ${live.length} 个在跑）` : ''}`;
        if (live.length === 1) return `▶ ${live[0].name} ${since(runOf(live[0].id).run.startedAt, now())}`;
        if (live.length > 1) return `▶ ${live.map((tool) => tool.name).join('、')}`;
        return '网课助手';
    }

    return { handleKey, view, title, done, state, runs: runOf, forms: formOf };
}

/* 真正跑在终端里：画面每秒刷新一次（已运行时长），有变化时尽快重画 */
export async function runTui({ root, runner, settings, platform = process.platform, screen = openScreen() }) {
    const tools = describe(root, platform, { remembered: settings?.read().values || {} });
    let pending = null;
    const draw = () => {
        pending = null;
        screen.draw(app.view(screen.width, screen.height));
        screen.title(app.title());
    };
    const schedule = () => { if (!pending) pending = setTimeout(draw, 30); };
    const app = createApp({ tools, runner, settings, onChange: schedule });
    const offKeys = screen.onKeys((key) => app.handleKey(key));
    const offResize = screen.onResize(schedule);
    const tick = setInterval(schedule, 1000);
    draw();
    try {
        await app.done;
    } finally {
        clearInterval(tick);
        clearTimeout(pending);
        offKeys();
        offResize();
        screen.close();
    }
}
