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

test('终端版：设置默认收起成一行；M 切静音，C 展开，Esc 收起；数字填错开始时拦下', async (t) => {
    const { screen, press, calls } = await setup(t);
    let view = screen();
    assert.match(view, /网课助手 {6}1 {2}学习通 /);
    assert.match(view, / {10}设置 {2}倍速 最高，浏览器 自动/, '页边 14 列右对齐');
    assert.match(view, /\[x\] 静音/);
    assert.match(view, / Enter 开始：学习通 /);
    assert.match(view, /1 2 3 切换平台 {4}Enter 开始 {4}M 静音开关 {4}C 改设置 {4}Q 退出/);

    press('m');
    view = screen();
    assert.match(view, /\[ \] 静音 {3}取消静音后视频会外放声音/);
    press('m');

    press('c');
    view = screen();
    assert.match(view, /全部设置/);
    assert.match(view, /最多播几节 {2}> ______ {3}留空 = 不限/);
    assert.match(view, /Tab \/ 上下 换一项 {4}空格 勾选、切换 {4}Esc 收起 {4}Enter 开始/);
    press('3', '.', '5');          /* 展开时输入框里的数字是字，不是切平台 */
    assert.match(screen(), /> 3\.5_/);
    press('enter');
    assert.match(screen(), /最多播几节 要填整数/);
    assert.equal(calls.length, 0, '填错了不启动');
    press('backspace');
    assert.doesNotMatch(screen(), /要填整数/, '改了填错的那一项，红字就消失');
    press('backspace');
    press('tab', 'right');         /* 倍速：最高 → 不改 */
    assert.match(screen(), /倍速 {2}> \( \) 最高 {2}\(o\) 不改/);
    press('escape');
    assert.match(screen(), /设置 {2}最多播几节 3，倍速 不改，浏览器 自动/);
});

test('终端版：三个平台同时跑，1 2 3 切换、S 停止、装依赖的提醒、出错标记、按平台分开的记录', async (t) => {
    const { app, screen, press, started, children, calls, advance, settings } = await setup(t);
    assert.equal(app.title(), '网课助手');
    press('enter');                /* 学习通 */
    await started(1);
    assert.equal(app.title(), '▶ 学习通 0:00', '终端标题和窗口版标题栏一样');
    let view = screen();
    assert.match(view, /这次的设置 {2}倍速 最高，静音，浏览器 自动/);
    assert.match(view, /1 2 3 切换平台 {4}S 停止：学习通/);

    children.xuexitong.stdout.emit('data', '[12:00:00] 正在安装依赖（npm install，只装 playwright-core，不下载浏览器）...\n');
    assert.match(screen(), /第一次运行要先装依赖，一般一两分钟/);
    children.xuexitong.stdout.emit('data', '[12:00:01] 启动专用 Chrome（独立 profile）\n[12:00:02] 正在播放：1.3 函数的极限\n');
    children.xuexitong.stderr.emit('data', '1.2 习题课 只剩测验，跳过\n');
    advance(65_000);
    view = screen();
    assert.match(view, /播放视频的那个浏览器窗口别最小化/, '装完依赖换回平时的提醒');
    assert.match(view, /^ {3}已运行 1:05 {3}1\.2 习题课/m, '页边右对齐；状态取最新一行');
    assert.match(view, / {10}记录 {2}最新一行 1 分钟前/);
    assert.match(view, / {6}12:00:02 {2}正在播放：1\.3 函数的极限/);
    assert.match(view, /! 1\.2 习题课 只剩测验，跳过/, 'stderr 是注意');

    press('2', 'enter');           /* 长江雨课堂 */
    await started(2);
    press('3', 'enter');           /* 智慧树 */
    await started(3);
    assert.deepEqual(calls[2].args, ['--config', 'config.linux.ini', '--wait-course']);
    assert.equal(app.title(), '▶ 学习通、长江雨课堂、智慧树');
    assert.equal(settings.read().picked, 'autovisor', '切平台记下来，两个入口共用');

    /* 雨课堂在后面出错退出：没切过去看的，平台名旁边标「停了」 */
    children.yuketang.stdout.emit('data', '[ERROR] 课程目录加载超时\n');
    children.yuketang.emit('close', 1, null);
    view = screen().split('\n')[0];
    assert.match(view, /学习通 >1:05/);
    assert.match(view, /长江雨课堂 停了/);
    assert.equal(app.title(), '✕ 长江雨课堂 停了（还有 2 个在跑）');
    assert.doesNotMatch(screen(), /函数的极限/, '记录按平台分开');

    press('2');                    /* 切到雨课堂：看过了，标记消失 */
    view = screen();
    assert.match(view, /停在 \d\d:\d\d:\d\d {2}长江雨课堂 中途停了，退出码 1/);
    assert.match(view, /x 课程目录加载超时/);
    assert.match(view, /记录 {2}共 1 行/);
    assert.match(view, / Enter 再开始：长江雨课堂 /);
    assert.doesNotMatch(view.split('\n')[0], /停了/);

    press('1', 's');               /* 停学习通 */
    assert.equal(children.xuexitong.stdinEnded, true);
    assert.match(screen(), /正在停止\.\.\.一般几秒，最多 8 秒/);
    assert.equal(app.runs('autovisor').run !== null, true, '别的平台不受影响');
    children.xuexitong.emit('close', 0, null);
    assert.match(screen(), /^ 结束 \d\d:\d\d:\d\d {2}学习通 已停止/m, '页边放得下，不越过 14 列');
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

test('终端版：输入框里的 q 是字；没在跑时 q 直接退出', async (t) => {
    const { app, press, screen } = await setup(t);
    press('3', 'c');               /* 智慧树展开：倍速、每门课、浏览器、滑块、手机号、密码、静音 */
    press('tab', 'tab', 'tab', 'tab');
    press('q');
    assert.match(screen(), /手机号 {2}> q_/, '手机号输入框里收到 q');
    press('tab', 'x', 'y');
    assert.match(screen(), /密码 {2}> \*\*_/, '密码显示成星号');
    press('escape', 'q');
    await app.done;
});

test('终端版：窗口太小时说清楚', async (t) => {
    const { app } = await setup(t);
    assert.match(app.view(50, 10)[0][0].text, /终端窗口太小了/);
});
