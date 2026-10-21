/* 不需要浏览器的部分：参数拼装、配置文件合并、打开浏览器的命令、跑进程的状态机 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { buildArgs, applyConfig, readConfig, missingRequired } from '../src/args.mjs';
import { openCommand } from '../src/open.mjs';
import { byId, entryFor, describe } from '../src/tools.mjs';
import { createRunner, windowsCommand } from '../src/runner.mjs';
import { phaseAfter } from '../src/present.mjs';

const xxt = byId('xuexitong');
const zhs = byId('autovisor');
/* 配置合并的测试要一个带必填文字项的 config 类工具。智慧树在控制台里已经不填
 * 课程地址了（等你在浏览器里点开课程），这里把那一项加回来当样例 */
const zhsUrl = { ...zhs, options: [{ key: ['course-url', 'URL1'], label: '课程地址', type: 'text', required: true }, ...zhs.options] };

test('参数拼装：只传用户真正设过的选项', () => {
    assert.deepEqual(buildArgs(xxt, {}), [], '什么都没填就不该有参数');
    assert.deepEqual(buildArgs(xxt, { '--max-sections': '3' }), ['--max-sections', '3']);
    /* 和默认值一样就不必出现在命令行里 */
    assert.deepEqual(buildArgs(xxt, { '--playback-rate': 'max' }), []);
    assert.deepEqual(buildArgs(xxt, { '--playback-rate': '1' }), ['--playback-rate', '1']);
});

test('参数拼装：开关没勾就不传，勾了才传', () => {
    const stop = '--no-auto-advance-no-video';
    assert.deepEqual(buildArgs(xxt, { [stop]: false }), [], '没勾不该冒出一个反向参数');
    assert.deepEqual(buildArgs(xxt, { [stop]: true }), [stop]);
});

test('参数拼装：界面上是「静音」、参数是 --no-mute，明确取消勾选才传', () => {
    assert.deepEqual(buildArgs(xxt, { '--no-mute': true }), [], '勾着静音不该传 --no-mute');
    assert.deepEqual(buildArgs(xxt, {}), [], '没传值就是默认（静音）');
    assert.deepEqual(buildArgs(xxt, { '--no-mute': false }), ['--no-mute']);
});

test('静音：三个工具界面上的说法一致，默认都勾上', () => {
    for (const tool of [xxt, byId('yuketang'), zhs]) {
        const mute = tool.options.find((option) => option.role === 'mute');
        assert.ok(mute, `${tool.name} 要有静音选项`);
        assert.equal(mute.label, '静音');
        assert.equal(mute.default, true, `${tool.name} 默认要静音`);
    }
});

test('参数拼装：数字框留空不要传空参数', () => {
    for (const empty of ['', '   ', undefined, null]) {
        assert.deepEqual(buildArgs(xxt, { '--max-sections': empty }), [], `留空(${JSON.stringify(empty)})不该传`);
    }
});

test('必填项：缺了就报出来，报的是界面上的说法', () => {
    assert.deepEqual(missingRequired(zhsUrl, {}), ['课程地址']);
    assert.deepEqual(missingRequired(zhsUrl, { 'course-url.URL1': '  ' }), ['课程地址'], '只填空格也算没填');
    assert.deepEqual(missingRequired(zhsUrl, { 'course-url.URL1': 'https://x' }), []);
});

const INI = `[user-account]
;配置账号密码
username =
password =

[course-option]
;播放倍速
limitSpeed = 0
soundOff = True

[course-url]
URL1 =
URL2 =
`;

test('配置合并：改掉填了的项，注释和没动过的项原样保留', () => {
    const out = applyConfig(INI, zhsUrl, {
        'course-url.URL1': 'https://studyvideoh5.zhihuishu.com/stuStudy?x=1',
        'course-option.limitSpeed': 'max',
    });
    assert.match(out, /^URL1 = https:\/\/studyvideoh5\.zhihuishu\.com\/stuStudy\?x=1$/m);
    assert.match(out, /^limitSpeed = max$/m);
    assert.match(out, /^;播放倍速$/m, '注释要留着');
    assert.match(out, /^URL2 =$/m, '没动过的项不要被抹掉');
    assert.match(out, /^soundOff = True$/m);
});

test('配置合并：开关写成 True / False', () => {
    assert.match(applyConfig(INI, zhs, { 'course-option.soundOff': true }), /^soundOff = True$/m);
    assert.match(applyConfig(INI, zhs, { 'course-option.soundOff': false }), /^soundOff = False$/m);
});

test('配置合并：留空的项保持原样，不会把存着的密码清掉', () => {
    const saved = INI.replace('password =', 'password = secret');
    const out = applyConfig(saved, zhs, { 'user-account.password': '', 'user-account.username': '  ' });
    assert.match(out, /^password = secret$/m);
    assert.match(out, /^username =$/m);
});

test('配置合并：键名不分大小写，GUI.py 存过的小写配置不会多出重复键', () => {
    /* configparser 写回时会把键全转小写；追加一行同名键它就读不了了 */
    const lower = `[script-option]\nenablehidewindow = False\n\n[course-url]\nurl1 = old\n`;
    const out = applyConfig(lower, zhsUrl, { 'script-option.enableHideWindow': true, 'course-url.URL1': 'https://new' });
    assert.match(out, /^enablehidewindow = True$/m);
    assert.match(out, /^url1 = https:\/\/new$/m);
    assert.equal(out.match(/hidewindow/gi).length, 1, '不该再追加一行');
    assert.equal(out.match(/url1/gi).length, 1);
});

test('读配置：预填表单用，读出开关和文字，不读密码', () => {
    const saved = INI.replace('password =', 'password = secret').replace('URL1 =', 'URL1 = https://x').replace('soundOff = True', 'soundoff = false');
    const current = readConfig(saved, zhsUrl);
    assert.equal(current['course-url.URL1'], 'https://x');
    assert.equal(current['course-option.limitSpeed'], '0');
    assert.equal(current['course-option.soundOff'], false, '小写键、小写 false 都要认');
    assert.equal('user-account.password' in current, false, '密码不往页面上送');
    assert.equal('user-account.username' in current, false, '空值不算');
});

test('只在 Windows 上有用的选项，别的平台上不显示', () => {
    const hide = (platform) => describe('/nonexistent', platform)
        .find((tool) => tool.id === 'autovisor').options
        .some((option) => option.key?.[1] === 'enableHideWindow');
    assert.equal(hide('win32'), true);
    assert.equal(hide('linux'), false);
    assert.equal(hide('darwin'), false);
});

test('配置合并：同名键只改对应段落里的那个', () => {
    const text = `[a]\nURL1 = old\n\n[course-url]\nURL1 = old\n`;
    const out = applyConfig(text, zhsUrl, { 'course-url.URL1': 'https://new' });
    assert.match(out, /\[a\]\nURL1 = old/, '别的段落里的同名键不该被改');
    assert.match(out, /\[course-url\]\nURL1 = https:\/\/new/);
});

test('打开浏览器：三平台各自的命令，Windows 上要先给一个空标题', () => {
    const win = openCommand('http://127.0.0.1:1/?token=a', 'win32');
    assert.deepEqual(win.args.slice(0, 3), ['/c', 'start', ''], 'start 的第一个引号参数会被当成窗口标题');
    assert.equal(openCommand('u', 'darwin').command, 'open');
    assert.equal(openCommand('u', 'linux').command, 'xdg-open');
});

test('入口脚本按平台取', () => {
    assert.equal(entryFor(xxt, 'win32'), 'start.cmd');
    assert.equal(entryFor(xxt, 'linux'), './start.sh');
    assert.equal(entryFor(zhs, 'win32'), 'run.cmd');
});

/* 假子进程：只实现 runner 用到的那几样 */
function fakeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = (signal) => { child.killed = true; child.signal = signal; };
    child.stdinEnded = false;
    child.stdin = { end() { child.stdinEnded = true; } };
    return child;
}

test('跑进程：同一个平台只能开一个，不同平台可以同时跑', async () => {
    const children = [];
    const runner = createRunner({ root: '/tmp', platform: 'linux', spawnProcess: () => { children.push(fakeChild()); return children.at(-1); } });
    /* locate 会检查目录存在, 这里直接用一个存在的目录 */
    const here = { dir: '/', entry: { posix: '.', win32: '.' } };
    const a = { ...xxt, ...here };
    const b = { ...byId('yuketang'), ...here };
    await runner.start(a, {});
    await assert.rejects(runner.start(a, {}), /已经在跑了/);
    await runner.start(b, {});
    assert.deepEqual(runner.running(), ['xuexitong', 'yuketang']);

    /* 各管各的：停一个不影响另一个 */
    assert.equal(runner.stop('xuexitong'), true);
    assert.equal(children[0].stdinEnded, true, '关掉 stdin 就是让它停');
    assert.equal(children[1].stdinEnded, false);
    children[0].emit('close', null, 'SIGINT');
    assert.equal(runner.toolState('xuexitong').running, false);
    assert.equal(runner.toolState('yuketang').running, true);
    assert.deepEqual(Object.keys(runner.state().runs), ['xuexitong', 'yuketang']);

    /* 不指定就全停（退出启动器时） */
    assert.equal(runner.stop(), true);
    assert.equal(children[1].stdinEnded, true);
});

test('跑进程：连点两下开始，只起一个', async () => {
    let spawned = 0;
    const runner = createRunner({ root: '/tmp', platform: 'linux', spawnProcess: () => { spawned += 1; return fakeChild(); } });
    const tool = { ...xxt, dir: '/', entry: { posix: '.', win32: '.' } };
    const results = await Promise.allSettled([runner.start(tool, {}), runner.start(tool, {})]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(spawned, 1);
});

test('跑进程：每一条事件都带着是哪个平台', async () => {
    const children = [];
    const runner = createRunner({ root: '/tmp', platform: 'linux', spawnProcess: () => { children.push(fakeChild()); return children.at(-1); } });
    const seen = [];
    runner.onEvent((event) => seen.push(event));
    const here = { dir: '/', entry: { posix: '.', win32: '.' } };
    await runner.start({ ...xxt, ...here }, {});
    await runner.start({ ...byId('yuketang'), ...here }, {});
    children[1].stdout.emit('data', '雨课堂的一行\n[[status]] 学到第 2 项\n');
    children[0].stdout.emit('data', '学习通的一行\n');
    children[0].emit('close', 0, null);
    assert.deepEqual(seen.map((e) => [e.type, e.tool]), [
        ['started', 'xuexitong'], ['started', 'yuketang'],
        ['line', 'yuketang'], ['status', 'yuketang'],
        ['line', 'xuexitong'], ['exit', 'xuexitong'],
    ]);
    assert.equal(runner.toolState('yuketang').status, '学到第 2 项');
    assert.equal(runner.toolState('xuexitong').status, '', '状态不串到别的平台');
});

test('跑进程：输出按行切，[[status]] 单独走状态而不混进日志', async () => {
    const child = fakeChild();
    const runner = createRunner({ root: '/tmp', platform: 'linux', spawnProcess: () => child });
    const tool = { ...xxt, dir: '/', entry: { posix: '.', win32: '.' } };
    const seen = [];
    runner.onEvent((event) => seen.push(event));
    await runner.start(tool, {});
    /* 故意切在半行上：子进程的输出是按块来的 */
    child.stdout.emit('data', '第一行\n第二');
    child.stdout.emit('data', '行\n[[status]] 正在播放 1/3\n');
    const lines = seen.filter((e) => e.type === 'line').map((e) => e.line);
    assert.deepEqual(lines, ['第一行', '第二行']);
    assert.equal(seen.filter((e) => e.type === 'status').at(-1).status, '正在播放 1/3');
    assert.equal(runner.toolState('xuexitong').status, '正在播放 1/3');
    assert.equal(runner.toolState('xuexitong').lines.some((e) => e.line.includes('[[status]]')), false, '状态不该混进日志');
    assert.equal(typeof runner.toolState('xuexitong').lines[0].at, 'number', 'Autovisor 的行里没时间，要自己记');
});

test('跑进程：stderr 的行标出来，退出后日志还留着', async () => {
    const child = fakeChild();
    const runner = createRunner({ root: '/tmp', platform: 'linux', spawnProcess: () => child });
    await runner.start({ ...xxt, dir: '/', entry: { posix: '.', win32: '.' } }, {});
    child.stdout.emit('data', '普通\n');
    child.stderr.emit('data', '出错了\n');
    child.emit('close', 1, null);
    const after = runner.toolState('xuexitong');
    assert.equal(after.running, false);
    assert.deepEqual(after.lines.map((e) => [e.line, e.err]), [['普通', false], ['出错了', true]]);
    assert.equal(after.exit.code, 1);
    assert.equal(after.exit.stopped, false, '不是用户点的停止');
});

test('跑进程：点停止之后退出，要能看出是手动停的', async () => {
    const child = fakeChild();
    const runner = createRunner({ root: '/tmp', platform: 'linux', spawnProcess: () => child });
    await runner.start({ ...xxt, dir: '/', entry: { posix: '.', win32: '.' } }, {});
    assert.equal(runner.stop('xuexitong'), true);
    assert.equal(child.stdinEnded, true, '先温和地停：关 stdin，工具当成 Ctrl+C 自己收尾');
    assert.equal(child.killed, false, '不再发 SIGINT：和 stdin 一起到的话 Autovisor 会被中断两次');
    child.emit('close', null, 'SIGINT');
    assert.equal(runner.toolState('xuexitong').exit.stopped, true);
});

test('跑进程：关 stdin 8 秒后还没退出，就按进程组强制结束', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = Object.assign(fakeChild(), { pid: 321, exitCode: null, signalCode: null });
    const killed = [];
    let options = null;
    const runner = createRunner({
        root: '/tmp', platform: 'linux',
        spawnProcess: (command, args, opts) => { options = opts; return child; },
        killProcess: (pid, signal) => killed.push([pid, signal]),
    });
    await runner.start({ ...xxt, dir: '/', entry: { posix: '.', win32: '.' } }, {});
    assert.equal(options.detached, true, '工具在自己的进程组里，才能按组结束');
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(options.env.PYTHONUTF8, '1', '中文 Windows 上 Python 往管道写默认是 cp936');
    assert.equal(options.env.PYTHONIOENCODING, 'utf-8');
    runner.stop('xuexitong');
    t.mock.timers.tick(7999);
    assert.deepEqual(killed, []);
    t.mock.timers.tick(1);
    assert.deepEqual(killed, [[-321, 'SIGKILL']], 'uv、python、浏览器一个不落');

    /* 自己按时退出了就不补刀 */
    const quiet = Object.assign(fakeChild(), { pid: 9, exitCode: null, signalCode: null });
    const quietKilled = [];
    const other = createRunner({ root: '/tmp', platform: 'linux', spawnProcess: () => quiet, killProcess: (...a) => quietKilled.push(a) });
    await other.start({ ...xxt, dir: '/', entry: { posix: '.', win32: '.' } }, {});
    other.stop('xuexitong');
    quiet.exitCode = 0;
    t.mock.timers.tick(8000);
    assert.deepEqual(quietKilled, []);
});

test('跑进程：退出启动器时等在跑的工具收完尾', async () => {
    const children = [];
    const runner = createRunner({ root: '/tmp', platform: 'linux', spawnProcess: () => { children.push(fakeChild()); return children.at(-1); } });
    const here = { dir: '/', entry: { posix: '.', win32: '.' } };
    assert.equal(await runner.whenIdle(10), true, '没在跑的直接返回');
    await runner.start({ ...xxt, ...here }, {});
    await runner.start({ ...byId('yuketang'), ...here }, {});
    runner.stop();
    const idle = runner.whenIdle(1000);
    children[0].emit('close', 0, null);
    setTimeout(() => children[1].emit('close', 0, null), 20);
    assert.equal(await idle, true);
    assert.deepEqual(runner.running(), []);
    await runner.start({ ...xxt, ...here }, {});
    assert.equal(await runner.whenIdle(30), false, '超时了就不等了');
});

test('跑进程：Windows 上关 stdin，8 秒后还在才强制结束整棵进程树', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const calls = [];
    const child = Object.assign(fakeChild(), { pid: 4242, exitCode: null, signalCode: null });
    const runner = createRunner({
        root: '/tmp', platform: 'win32',
        spawnProcess: (command, args, options) => { calls.push([command, args, options]); return calls.length === 1 ? child : fakeChild(); },
    });
    /* locate 要求入口脚本真的存在 */
    const dir = await mkdtemp(join(tmpdir(), 'launcher-win-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, 'start.cmd'), '@echo off\r\n', 'utf8');
    await runner.start({ ...xxt, dir, entry: { posix: '.', win32: 'start.cmd' } }, { '--max-sections': '2' });

    /* 启动：自己拼 cmd.exe 的命令行，不用 shell: true + 参数数组（DEP0190） */
    const [command, args, options] = calls[0];
    assert.equal(command, 'cmd.exe');
    assert.deepEqual(args.slice(0, 3), ['/d', '/s', '/c']);
    assert.match(args[3], /^""[^"]*start\.cmd" "--max-sections" "2""$/);
    assert.equal(options.windowsVerbatimArguments, true);
    assert.equal(options.shell, undefined);
    assert.equal(options.env.COURSE_UI, '1', '.cmd 入口据此不在结尾 pause');

    assert.equal(options.env.PYTHONUTF8, '1');
    runner.stop('xuexitong');
    /* 不再先发不带 /F 的 taskkill /T：Edge 没窗口的子进程只能强杀，整条链都被拒（pc 实测） */
    assert.equal(child.stdinEnded, true);
    assert.equal(calls.length, 1);
    t.mock.timers.tick(7999);
    assert.equal(calls.length, 1);
    t.mock.timers.tick(1);
    assert.deepEqual(calls[1].slice(0, 2), ['taskkill', ['/pid', '4242', '/T', '/F']], '收不了尾的再强制结束整棵树');
    assert.equal(child.killed, false, '不该只结束 cmd.exe');
});

test('跑进程：Windows 上已经自己退出了，就不再强制结束', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const calls = [];
    const child = Object.assign(fakeChild(), { pid: 7, exitCode: null, signalCode: null });
    const runner = createRunner({
        root: '/tmp', platform: 'win32',
        spawnProcess: (command, args) => { calls.push([command, args]); return calls.length === 1 ? child : fakeChild(); },
    });
    const dir = await mkdtemp(join(tmpdir(), 'launcher-win-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, 'start.cmd'), '@echo off\r\n', 'utf8');
    await runner.start({ ...xxt, dir, entry: { posix: '.', win32: 'start.cmd' } }, {});
    runner.stop('xuexitong');
    child.exitCode = 0;
    t.mock.timers.tick(8000);
    assert.equal(calls.length, 1, '自己收完尾退出了，就不用 taskkill');
});

test('Windows 命令行：带 cmd 特殊字符的参数一律拒绝', () => {
    assert.throws(() => windowsCommand('C:\\a\\start.cmd', ['--x', 'a&calc']), /不能用的字符/);
    assert.throws(() => windowsCommand('C:\\a\\start.cmd', ['%PATH%']), /不能用的字符/);
    assert.deepEqual(windowsCommand('C:\\a b\\run.cmd', ['--config', 'config.ini', '--wait-course']),
        ['cmd.exe', ['/d', '/s', '/c', '""C:\\a b\\run.cmd" "--config" "config.ini" "--wait-course""']]);
});

test('智慧树：控制台里不填课程地址，启动时固定带 --wait-course', () => {
    assert.equal(zhs.options.some((option) => option.key?.[0] === 'course-url'), false);
    assert.deepEqual(zhs.fixedArgs, ['--wait-course']);
    assert.match(zhs.hint, /点开要学的课程/);
});

test('跑进程：界面能看到这次用了什么设置，但看不到密码', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'launcher-'));
    try {
        await writeFile(join(dir, 'config.linux.ini'), INI, 'utf8');
        await writeFile(join(dir, 'run.sh'), '#!/bin/sh\n', 'utf8');
        const runner = createRunner({ root: dir, platform: 'linux', spawnProcess: () => fakeChild() });
        await runner.start({ ...zhsUrl, dir: '.' }, { 'course-url.URL1': 'https://x', 'user-account.password': 'secret' });
        assert.equal(runner.toolState('autovisor').values['course-url.URL1'], 'https://x');
        assert.equal(JSON.stringify(runner.state()).includes('secret'), false);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('跑进程：必填项没填就不启动', async () => {
    let spawned = false;
    const runner = createRunner({ root: '/tmp', platform: 'linux', spawnProcess: () => { spawned = true; return fakeChild(); } });
    await assert.rejects(runner.start({ ...zhsUrl, dir: '/', entry: { posix: '.', win32: '.' } }, {}), /课程地址/);
    assert.equal(spawned, false);
});

test('跑进程：目录不在就说清楚是哪个路径', async () => {
    const runner = createRunner({ root: '/tmp', platform: 'linux', spawnProcess: () => fakeChild() });
    await assert.rejects(
        runner.start({ ...xxt, dir: './不存在的目录' }, {}),
        /找不到.*不存在的目录/,
    );
});

test('配置类工具：把值写进它自己的配置文件，并带上 --config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'launcher-'));
    try {
        await writeFile(join(dir, 'config.linux.ini'), INI, 'utf8');
        await writeFile(join(dir, 'run.sh'), '#!/bin/sh\n', 'utf8');
        let call = null;
        const runner = createRunner({
            root: dir, platform: 'linux',
            spawnProcess: (command, args, options) => { call = { command, args, options }; return fakeChild(); },
        });
        await runner.start({ ...zhsUrl, dir: '.' }, {
            'course-url.URL1': 'https://studyvideoh5.zhihuishu.com/x',
            'course-option.limitSpeed': 'max',
        });
        assert.deepEqual(call.args, ['--config', 'config.linux.ini', '--wait-course']);
        assert.equal(call.options.env.COURSE_UI, '1', '要让工具知道输出是给界面看的');
        const written = await readFile(join(dir, 'config.linux.ini'), 'utf8');
        assert.match(written, /^URL1 = https:\/\/studyvideoh5\.zhihuishu\.com\/x$/m);
        assert.match(written, /^limitSpeed = max$/m);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('浏览器：学习通、雨课堂选「自动」不传参数，选了哪个才传 --browser', () => {
    for (const tool of [xxt, byId('yuketang')]) {
        assert.deepEqual(buildArgs(tool, { '--browser': 'auto' }), [], tool.id);
        assert.deepEqual(buildArgs(tool, { '--browser': 'edge' }), ['--browser', 'edge'], tool.id);
        assert.deepEqual(buildArgs(tool, { '--browser': 'chrome' }), ['--browser', 'chrome'], tool.id);
    }
});

test('浏览器：智慧树写进 [browser-option] driver，默认值跟着平台走', () => {
    const driverOf = (platform) => describe('/nonexistent', platform)
        .find((tool) => tool.id === 'autovisor').options
        .find((option) => option.key?.[1] === 'driver');
    assert.equal(driverOf('win32').default, 'Edge', 'Windows 自带 Edge，和 Autovisor 自己的默认一致');
    assert.equal(driverOf('linux').default, 'Chrome');
    assert.equal(driverOf('darwin').default, 'Chrome');
    assert.deepEqual(driverOf('win32').choices.map((c) => c.value), ['Edge', 'Chrome'], 'Chromium 只在 Linux 上由 run.sh 下载');
    assert.ok(driverOf('linux').choices.some((c) => c.value === 'Chromium'));

    const out = applyConfig(INI, zhs, { 'browser-option.driver': 'Edge' });
    assert.match(out, /\[browser-option\]\ndriver = Edge/, '模板里没有这一段就补上');
    const kept = applyConfig('[browser-option]\n;可选 Edge 或 Chrome\ndriver = Chrome\nEXE_PATH =\n', zhs, { 'browser-option.driver': 'Edge' });
    assert.equal(kept, '[browser-option]\n;可选 Edge 或 Chrome\ndriver = Edge\nEXE_PATH =\n');
    /* GUI.py 存过的是小写 edge；界面上的单选值是 Edge，要对得上才会选中 */
    assert.equal(readConfig('[browser-option]\ndriver = edge\n', zhs)['browser-option.driver'], 'Edge');
});

test('Windows 入口：仓库里所有 .cmd 只有 ASCII；根目录 start.cmd 用到的提示都在 start-messages.txt 里', async () => {
    const { readFileSync } = await import('node:fs');
    const repo = new URL('../../', import.meta.url);
    /* 控制台是 UTF-8 时，cmd 会读错含多字节字符的批处理：按行的位置把中文行截断，
     * 后半截当成命令执行（pc 在 Windows 11 上实测，窗口版的记录里也看得到） */
    for (const file of ['start.cmd', 'xuexitong/start.cmd', 'yuketang/start.cmd', 'autovisor/run.cmd']) {
        assert.ok(/^[\x00-\x7f]*$/.test(readFileSync(new URL(file, repo), 'utf8')), `${file} 里不能有非 ASCII 字符`);
    }
    const cmd = readFileSync(new URL('start.cmd', repo), 'utf8');
    const raw = readFileSync(new URL('launcher/start-messages.txt', repo));
    assert.notDeepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], '不能带 BOM，不然第一行的键认不出来');
    const keys = new Set(raw.toString('utf8').split(/\r?\n/).filter((line) => /^[\w-]+=/.test(line)).map((line) => line.split('=')[0]));
    const used = [...cmd.matchAll(/call :say ([\w-]+)/g)].map((match) => match[1]);
    assert.ok(used.length >= 5);
    for (const key of used) assert.ok(keys.has(key), `start-messages.txt 里缺 ${key}`);
});

test('跑进程：智慧树入口里 uv 的进度走 stderr，但不算警告；别的 stderr 照样标出来', async () => {
    const child = fakeChild();
    const runner = createRunner({ root: '/tmp', platform: 'linux', spawnProcess: () => child });
    const tool = { ...byId('autovisor'), dir: '/', entry: { posix: '.', win32: '.' }, kind: 'flags' };
    await runner.start(tool, {});
    child.stderr.emit('data', 'Resolved 23 packages in 5ms\nChecked 18 packages in 1ms\n + numpy==2.3.4\nTraceback (most recent call last):\n');
    const err = Object.fromEntries(runner.toolState('autovisor').lines.map((e) => [e.line, e.err]));
    assert.equal(err['Resolved 23 packages in 5ms'], false);
    assert.equal(err['Checked 18 packages in 1ms'], false);
    assert.equal(err[' + numpy==2.3.4'], false);
    assert.equal(err['Traceback (most recent call last):'], true);
});

test('第一次装依赖的提醒：智慧树在网课助手里自动装 uv 时也算', () => {
    assert.equal(phaseAfter('', '正在用 winget 安装 uv，第一次要等一两分钟...'), 'prepare');
    assert.equal(phaseAfter('prepare', '程序启动中...'), '');
});
