/* 终端版：宽度、按键、状态机。不开真终端，直接喂按键、读画面 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { charWidth, textWidth, truncate, fit, wrap } from '../src/tui/width.mjs';
import { parseKeys, renderRow } from '../src/tui/screen.mjs';
import { createApp } from '../src/tui/app.mjs';
import { createRunner } from '../src/runner.mjs';
import { createSettings } from '../src/settings.mjs';
import { describe } from '../src/tools.mjs';


test('宽度：中文和全角两列，ASCII 一列，组合符号不占位', () => {
    assert.equal(charWidth('学'), 2);
    assert.equal(charWidth('，'), 2);
    assert.equal(charWidth('a'), 1);
    assert.equal(charWidth('⏳'), 2, '工具日志里的 emoji');
    assert.equal(charWidth('́'), 0);
    assert.equal(textWidth('学习通 ok'), 9);
});

test('截断和补齐按显示宽度算，宽字符放不下就用空格顶上', () => {
    assert.equal(truncate('学习通课程', 7), '学习...');
    assert.equal(textWidth(truncate('学习通课程', 8)), 8);
    assert.equal(truncate('短', 10), '短');
    assert.equal(fit('学', 4), '学  ');
    assert.equal(textWidth(fit('一二三四五六', 7)), 7);
    assert.deepEqual(wrap('一二三四五', 4), ['一二', '三四', '五']);
    assert.deepEqual(wrap('hello world again', 11), ['hello world', 'again']);
});

test('按键：方向键、翻页、回车、Ctrl+C、中文输入；认不出的序列丢掉', () => {
    const names = (s) => parseKeys(s).map((k) => k.name === 'char' ? k.char : k.name);
    assert.deepEqual(names('\x1b[A\x1b[B\x1b[C\x1b[D'), ['up', 'down', 'right', 'left']);
    assert.deepEqual(names('\x1b[5~\x1b[6~\t\x1b[Z'), ['pageup', 'pagedown', 'tab', 'backtab']);
    assert.deepEqual(names('\r\x03\x7f '), ['enter', 'ctrl-c', 'backspace', 'space']);
    assert.deepEqual(names('学a'), ['学', 'a']);
    assert.deepEqual(names('\x1b[1;5Cx'), ['x'], 'Ctrl+右 这种组合键不该输进输入框');
});

test('一行不会超过终端宽度：样式不算宽度', () => {
    const row = renderRow([{ text: '学习通', style: '\x1b[1m' }, { text: 'abcdef' }], 8);
    assert.equal(textWidth(row.replace(/\x1b\[[0-9;]*m/g, '')), 8);
});

/* ---------- 状态机 ---------- */

function fakeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() { child.stdinEnded = true; } };
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {};
    return child;
}

/* 测试绝不能碰真实的工具目录：智慧树启动前会改写它自己的配置文件。
 * 所以起一个临时的 launcher 根目录，用 tools.local.json 把三个工具指到临时目录里 */
async function setup(t) {
    const dir = await mkdtemp(join(tmpdir(), 'tui-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const root = join(dir, 'launcher');
    const dirs = {};
    for (const id of ['xuexitong', 'yuketang', 'autovisor']) {
        dirs[id] = join(dir, id);
        await mkdir(dirs[id], { recursive: true });
        await writeFile(join(dirs[id], id === 'autovisor' ? 'run.sh' : 'start.sh'), '#!/bin/sh\n', 'utf8');
    }
    await writeFile(join(dirs.autovisor, 'config.linux.ini'), '[course-option]\nsoundOff = True\n', 'utf8');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'tools.local.json'), JSON.stringify(dirs), 'utf8');

    const settings = createSettings({ dir: join(dir, 'settings') });
    const children = {};
    const calls = [];
    const runner = createRunner({
        root, platform: 'linux', settings,
        spawnProcess: (command, args, options) => {
            calls.push({ cwd: options.cwd, args });
            const child = fakeChild();
            children[options.cwd.split('/').at(-1)] = child;
            return child;
        },
    });
    const tools = describe(root, 'linux', { remembered: settings.read().values });
    let offset = 0;
    const app = createApp({ tools, runner, settings, now: () => Date.now() + offset });
    const screen = (w = 100, h = 30) => app.view(w, h).map((row) => row.map((seg) => seg.text).join('')).join('\n');
    const press = (...names) => {
        for (const name of names) app.handleKey(name.length === 1 && name !== ' ' ? { name: 'char', char: name } : { name: name === ' ' ? 'space' : name });
    };
    const tick = async () => new Promise((done) => setImmediate(done));
    /* 智慧树启动前要异步写配置文件，等到真的启动了再往下 */
    const started = async (count) => {
        for (let i = 0; i < 200 && calls.length < count; i += 1) await new Promise((done) => setTimeout(done, 5));
        assert.equal(calls.length, count);
    };
    return { app, runner, settings, children, calls, screen, press, tick, started, dirs, advance: (ms) => { offset += ms; } };
}

test('终端版：表单、勾选、单选、只收数字的输入框、取消静音的警告', async (t) => {
    const { screen, press } = await setup(t);
    let view = screen();
    assert.match(view, /网课助手/);
    assert.match(view, /学习通/);
    assert.match(view, /最多播几节/);
    assert.match(view, /\[ 开始：学习通 \]/);

    press('1', 'a', '2');          /* 第一项是「最多播几节」，只收数字 */
    assert.match(screen(), /\[12_/);
    press('down', 'right');        /* 倍速：最高 → 不改 */
    assert.match(screen(), /\( \) 最高 {2}\(o\) 不改/);
    press('down', ' ');            /* 静音：取消 */
    view = screen();
    assert.match(view, /\[ \] 静音/);
    assert.match(view, /取消静音后视频会外放声音/);
});

test('终端版：三个平台同时跑，切换、状态、出错标记、按平台分开的日志', async (t) => {
    const { app, screen, press, started, children, calls, advance, settings } = await setup(t);
    press('enter');                /* 学习通 */
    await started(1);
    assert.match(screen(), /\[ 停止：学习通 \]/);
    assert.match(screen(), /这次的设置/);

    children.xuexitong.stdout.emit('data', '[12:00:01] 课程共 6 章 42 节\n[12:00:02] 正在播放：1.3 函数的极限\n');
    advance(65_000);
    let view = screen();
    assert.match(view, /已运行 1:05/);
    assert.match(view, /正在播放：1\.3 函数的极限/, '状态取最新一行');
    assert.match(view, /12:00:01 {2}课程共 6 章 42 节/);

    press('tab', 'enter');         /* 长江雨课堂 */
    await started(2);
    press('tab', 'enter');         /* 智慧树 */
    await started(3);
    assert.deepEqual(calls[2].args, ['--config', 'config.linux.ini', '--wait-course']);
    assert.equal(settings.read().picked, 'autovisor', '切平台记下来，两个入口共用');

    /* 雨课堂在后面出错退出：没切过去看的，平台名旁边标「停了」 */
    children.yuketang.stderr.emit('data', '课程目录加载超时\n');
    children.yuketang.emit('close', 1, null);
    view = screen().split('\n')[0];
    assert.match(view, /学习通 {2}>1:05/);
    assert.match(view, /长江雨课堂 {2}停了/);
    assert.doesNotMatch(screen(), /课程共 6 章/, '日志按平台分开');

    press('backtab');              /* 切到雨课堂：看过了，标记消失 */
    view = screen();
    assert.match(view, /长江雨课堂 中途停了，退出码 1/);
    assert.match(view, /课程目录加载超时/);
    assert.doesNotMatch(view.split('\n')[0], /停了/);
    assert.equal(app.runs('xuexitong').run !== null, true);
});

test('终端版：有平台在跑时退出要确认；确认后停掉全部、等收尾', async (t) => {
    const { app, screen, press, tick, started, children, runner } = await setup(t);
    press('enter');
    await started(1);
    press('q');
    assert.match(screen(), /还有 1 个平台在跑，退出会把它们都停掉。按 y 退出/);
    press('n');
    assert.doesNotMatch(screen(), /按 y 退出/, '其它键取消');
    press('q', 'y');
    await tick();
    assert.equal(children.xuexitong.stdinEnded, true, '关 stdin 让它自己收尾');
    let finished = false;
    app.done.then(() => { finished = true; });
    await tick();
    assert.equal(finished, false, '还在收尾，不能先走');
    assert.match(screen(), /正在停止 1 个在跑的平台/);
    children.xuexitong.emit('close', 0, null);
    await app.done;
    assert.deepEqual(runner.running(), []);
});

test('终端版：没在跑时 q 直接退出；输入框里的 q 是字', async (t) => {
    const { app, press, screen } = await setup(t);
    press('tab', 'tab');           /* 智慧树：最后两项是手机号、密码 */
    for (let i = 0; i < 5; i += 1) press('down');   /* Linux 上没有「把浏览器窗口移出屏幕」 */
    press('q');
    assert.match(screen(), /\[q_/, '手机号输入框里收到 q');
    press('down', 'x', 'y');
    assert.match(screen(), /\[\*\*_/, '密码显示成星号');
    press('down', 'q');            /* 焦点在「开始」上 */
    await app.done;
});

test('终端版：窗口太小时说清楚', async (t) => {
    const { app } = await setup(t);
    assert.match(app.view(50, 10)[0][0].text, /终端窗口太小了/);
});
