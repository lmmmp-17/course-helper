/* ------------------------------------------------------------------
 * 终端版界面（TUI）：和窗口版同一个后端、同一份设置，信息结构也一样。
 *
 *   顶部    三个平台，在跑的写已运行时长，中途出错没看过的标「停了」
 *   中间    没在跑：表单；在跑：这次的设置 + 停止
 *           当前状态（荧光笔）、提醒
 *   下面    日志，PgUp / PgDn 翻
 *   最底    按键说明，或者退出确认
 *
 * 状态和渲染分开：createApp 只管状态、按键和「这一帧长什么样」，不碰终端，
 * 单元测试直接喂按键、读画面。真正画到终端上的是 runTui。
 * ------------------------------------------------------------------ */
import { byId, describe } from '../tools.mjs';
import { STYLE, openScreen } from './screen.mjs';
import { fit, wrap } from './width.mjs';
import { exitText, parseLine, since, summarize } from '../present.mjs';

const MAX_LOG = 1000;
const LABEL = 20;
const INPUT = 24;
const MIN_WIDTH = 60;
const MIN_HEIGHT = 18;
const NOTE = '播放视频的那个浏览器窗口别最小化，也别在里面切到别的标签页；被别的窗口盖住没关系。';
const HELP = 'Tab 切平台   上下 选项   左右/空格 改选项   回车 开始/停止   PgUp/PgDn 翻日志   q 退出';

const keyOf = (option) => option.flag || option.key.join('.');

function initialValue(option) {
    if (option.current !== undefined) return option.current;
    if (option.remembered !== undefined && option.type !== 'password') return option.remembered;
    if (option.default !== undefined) return option.default;
    return option.type === 'bool' ? false : '';
}

export function createApp({ tools, runner, settings = null, now = Date.now, onChange = () => {} }) {
    const blank = () => ({
        run: null, exit: null, toolStatus: '', lastLine: '', lines: [],
        starting: false, stopping: false, seen: true, error: '',
    });
    const runs = {};
    const runOf = (id) => (runs[id] ??= blank());
    const forms = {};
    const formOf = (tool) => (forms[tool.id] ??= {
        values: Object.fromEntries(tool.options.map((option) => [keyOf(option), initialValue(option)])),
        focus: 0,
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
            if (shown) { formOf(state.picked).focus = 0; state.logScroll = 0; }
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
            run.seen = shown;
            const form = forms[event.tool];
            if (form) form.focus = 0;
        }
        onChange();
    });

    /* 当前平台能被键盘选中的东西：没在跑时是每个字段加「开始」，在跑时只有「停止」 */
    function focusables(tool) {
        if (!tool.ready) return [];
        if (runOf(tool.id).run) return [{ kind: 'stop' }];
        return [...tool.options.map((option) => ({ kind: 'field', option })), { kind: 'start' }];
    }

    function pick(offset) {
        const index = tools.indexOf(state.picked);
        state.picked = tools[(index + offset + tools.length) % tools.length];
        runOf(state.picked.id).seen = true;
        state.logScroll = 0;
        try { settings?.pick(state.picked.id); } catch (e) { /* 记不住就算了 */ }
    }

    async function start(tool) {
        const run = runOf(tool.id);
        if (run.run || run.starting) return;
        run.starting = true;
        run.error = '';
        onChange();
        try {
            await runner.start(byId(tool.id), { ...formOf(tool).values });
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

    function editField(option, key, form) {
        const id = keyOf(option);
        const value = form.values[id];
        if (option.type === 'bool') {
            if (key.name === 'space' || key.name === 'left' || key.name === 'right') { form.values[id] = !value; return true; }
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
        if (key.name === 'backspace') { form.values[id] = [...text].slice(0, -1).join(''); return true; }
        const char = key.name === 'space' ? ' ' : key.name === 'char' ? key.char : null;
        if (char === null) return false;
        if (option.type === 'number' && !/^[0-9]$/.test(char)) return true;
        form.values[id] = text + char;
        return true;
    }

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
        const items = focusables(tool);
        const form = formOf(tool);
        form.focus = Math.min(form.focus, Math.max(0, items.length - 1));
        const item = items[form.focus];
        const editingText = item?.kind === 'field' && ['text', 'number', 'password'].includes(item.option.type);

        if (key.name === 'ctrl-c' || (key.name === 'char' && key.char === 'q' && !editingText)) {
            if (running().length) state.confirmQuit = true;
            else quit();
        } else if (key.name === 'tab') pick(1);
        else if (key.name === 'backtab') pick(-1);
        else if (key.name === 'up') form.focus = Math.max(0, form.focus - 1);
        else if (key.name === 'down') form.focus = Math.min(items.length - 1, form.focus + 1);
        else if (key.name === 'pageup') state.logScroll += 5;
        else if (key.name === 'pagedown') state.logScroll = Math.max(0, state.logScroll - 5);
        else if (key.name === 'enter') {
            if (item?.kind === 'stop') stop(tool);
            else if (items.length) start(tool);
        } else if (item?.kind === 'field') editField(item.option, key, form);
        else if (key.name === 'space' && item?.kind === 'start') start(tool);
        else if (key.name === 'space' && item?.kind === 'stop') stop(tool);
        onChange();
    }

    /* ---------- 画面 ---------- */

    function tabsRow() {
        const row = [{ text: ' 网课助手   ', style: STYLE.strong }];
        for (const tool of tools) {
            const run = runOf(tool.id);
            const picked = tool === state.picked;
            row.push({ text: ` ${tool.name} `, style: picked ? STYLE.mark : tool.ready ? STYLE.plain : STYLE.soft });
            if (run.run) row.push({ text: ` >${since(run.run.startedAt, now())}`, style: STYLE.soft });
            else if (run.starting) row.push({ text: ' ...', style: STYLE.soft });
            else if (run.exit && !run.seen && exitText(run.exit).failed) row.push({ text: ' 停了', style: STYLE.pen });
            row.push({ text: '   ' });
        }
        return row;
    }

    function fieldRow(option, value, focused, width) {
        const marker = { text: focused ? ' > ' : '   ', style: focused ? STYLE.strong : '' };
        const help = (text, style = STYLE.soft) => ({ text: `   ${text}`, style });
        if (option.type === 'bool') {
            const row = [marker, { text: ' '.repeat(LABEL) },
                { text: `[${value ? 'x' : ' '}] ${option.label}`, style: focused ? STYLE.focus : '' }];
            if (option.role === 'mute' && !value) row.push(help('取消静音后视频会外放声音', STYLE.pen));
            else if (option.help) row.push(help(option.help));
            return row;
        }
        const label = { text: fit(option.label, LABEL), style: STYLE.soft };
        if (option.type === 'select') {
            const row = [marker, label];
            for (const choice of option.choices) {
                const on = String(value) === choice.value;
                row.push({ text: `(${on ? 'o' : ' '}) ${choice.label}`, style: focused && on ? STYLE.focus : '' }, { text: '  ' });
            }
            if (option.help) row.push(help(option.help));
            return row;
        }
        const raw = String(value ?? '');
        const shown = option.type === 'password' ? '*'.repeat([...raw].length) : raw;
        const empty = !raw && option.placeholder;
        const inside = empty ? fit(option.placeholder, INPUT) : fit(`${shown}${focused ? '_' : ''}`, INPUT);
        const row = [marker, label, { text: '[' }, { text: inside, style: focused ? STYLE.focus : empty ? STYLE.soft : '' }, { text: ']' }];
        if (option.help) row.push(help(option.help));
        return row;
    }

    function view(width, height) {
        if (width < MIN_WIDTH || height < MIN_HEIGHT) {
            return [[{ text: `终端窗口太小了，拉大一点（至少 ${MIN_WIDTH} 列 x ${MIN_HEIGHT} 行）。q 退出。`, style: STYLE.pen }]];
        }
        const tool = state.picked;
        const run = runOf(tool.id);
        const form = formOf(tool);
        const items = focusables(tool);
        const rows = [tabsRow(), []];

        if (!tool.ready) {
            rows.push([{ text: `   没找到${tool.name}：${tool.dir}`, style: STYLE.pen }]);
            rows.push([{ text: '   工具目录放在别处的话，在 launcher 目录里建一个 tools.local.json 写上实际路径（README 里有例子）。', style: STYLE.soft }]);
        } else {
            for (const line of wrap(tool.hint, width - 4).slice(0, 2)) rows.push([{ text: `   ${line}`, style: STYLE.soft }]);
            rows.push([]);
            if (run.run) {
                const parts = [{ text: '   ' }, { text: fit('这次的设置', LABEL), style: STYLE.soft }];
                summarize(tool, run.run.values || {}).forEach((part, i) => {
                    if (i) parts.push({ text: '，' });
                    parts.push({ text: part.text, style: part.warn ? STYLE.pen : '' });
                });
                rows.push(parts);
                rows.push([]);
                const label = run.stopping ? '[ 正在停止... ]' : `[ 停止：${tool.name} ]`;
                rows.push([{ text: ' > ', style: STYLE.strong }, { text: label, style: STYLE.focus }]);
            } else {
                items.forEach((item, i) => {
                    if (item.kind === 'field') rows.push(fieldRow(item.option, form.values[keyOf(item.option)], i === form.focus, width));
                });
                if (run.error) rows.push([{ text: `   ${run.error}`, style: STYLE.pen }]);
                rows.push([]);
                const focused = items[form.focus]?.kind === 'start';
                const label = run.starting ? '[ 正在启动... ]' : `[ 开始：${tool.name} ]`;
                rows.push([{ text: focused ? ' > ' : '   ', style: STYLE.strong }, { text: label, style: focused ? STYLE.focus : STYLE.strong }]);
            }
        }

        rows.push([]);
        if (run.run) {
            rows.push([{ text: `   已运行 ${since(run.run.startedAt, now())}   `, style: STYLE.soft },
                { text: ` ${run.toolStatus || run.lastLine || '正在启动...'} `, style: STYLE.mark }]);
            rows.push([{ text: `   ${NOTE}`, style: STYLE.soft }]);
        } else if (run.exit) {
            const { text, failed } = exitText(run.exit);
            rows.push([{ text: `   ${text}`, style: failed ? STYLE.penStrong : STYLE.strong }]);
        }

        /* 日志占满剩下的行，最后一行留给按键说明 */
        const room = height - rows.length - 2;
        if (room > 0 && run.lines.length) {
            rows.push([]);
            const lines = run.lines;
            const pane = room - 1;
            state.logScroll = Math.min(state.logScroll, Math.max(0, lines.length - pane));
            const end = lines.length - state.logScroll;
            for (const line of lines.slice(Math.max(0, end - pane), end)) {
                const style = line.level ? STYLE.pen : '';
                rows.push([{ text: `   ${line.time}  `, style: STYLE.soft }, { text: line.text, style }]);
            }
        }

        while (rows.length < height - 1) rows.push([]);
        rows.length = height - 1;
        if (state.quitting) {
            rows.push([{ text: ` 正在停止 ${running().length} 个在跑的平台，等它们收尾...（再按一次 Ctrl+C 直接退出）`, style: STYLE.pen }]);
        } else if (state.confirmQuit) {
            rows.push([{ text: ` 还有 ${running().length} 个平台在跑，退出会把它们都停掉。按 y 退出，其它键取消。`, style: STYLE.penStrong }]);
        } else {
            const scrolled = state.logScroll ? `   （日志往上翻了 ${state.logScroll} 行，PgDn 回到最新）` : '';
            rows.push([{ text: ` ${HELP}${scrolled}`, style: STYLE.soft }]);
        }
        return rows;
    }

    return { handleKey, view, done, state, runs: runOf, forms: formOf };
}

/* 真正跑在终端里：画面每秒刷新一次（已运行时长），有变化时尽快重画 */
export async function runTui({ root, runner, settings, platform = process.platform, screen = openScreen() }) {
    const tools = describe(root, platform, { remembered: settings?.read().values || {} });
    let pending = null;
    const draw = () => {
        pending = null;
        screen.draw(app.view(screen.width, screen.height));
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

