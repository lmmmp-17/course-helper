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
import { createRunner } from '../src/runner.mjs';

const xxt = byId('xuexitong');
const zhs = byId('autovisor');

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
    assert.deepEqual(missingRequired(zhs, {}), ['课程地址']);
    assert.deepEqual(missingRequired(zhs, { 'course-url.URL1': '  ' }), ['课程地址'], '只填空格也算没填');
    assert.deepEqual(missingRequired(zhs, { 'course-url.URL1': 'https://x' }), []);
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
    const out = applyConfig(INI, zhs, {
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
    const out = applyConfig(lower, zhs, { 'script-option.enableHideWindow': true, 'course-url.URL1': 'https://new' });
    assert.match(out, /^enablehidewindow = True$/m);
    assert.match(out, /^url1 = https:\/\/new$/m);
    assert.equal(out.match(/hidewindow/gi).length, 1, '不该再追加一行');
    assert.equal(out.match(/url1/gi).length, 1);
});

test('读配置：预填表单用，读出开关和文字，不读密码', () => {
    const saved = INI.replace('password =', 'password = secret').replace('URL1 =', 'URL1 = https://x').replace('soundOff = True', 'soundoff = false');
    const current = readConfig(saved, zhs);
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
    const out = applyConfig(text, zhs, { 'course-url.URL1': 'https://new' });
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
    assert.equal(children[0].signal, 'SIGINT');
    assert.equal(children[1].killed, false);
    children[0].emit('close', null, 'SIGINT');
    assert.equal(runner.toolState('xuexitong').running, false);
    assert.equal(runner.toolState('yuketang').running, true);
    assert.deepEqual(Object.keys(runner.state().runs), ['xuexitong', 'yuketang']);

    /* 不指定就全停（退出启动器时） */
    assert.equal(runner.stop(), true);
    assert.equal(children[1].signal, 'SIGINT');
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
    assert.equal(child.signal, 'SIGINT', '先温和地停');
    child.emit('close', null, 'SIGINT');
    assert.equal(runner.toolState('xuexitong').exit.stopped, true);
});

test('跑进程：SIGINT 之后 8 秒还没退出就强制结束', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = Object.assign(fakeChild(), { exitCode: null, signalCode: null });
    const sent = [];
    child.kill = (signal) => { sent.push(signal); child.killed = true; };
    const runner = createRunner({ root: '/tmp', platform: 'linux', spawnProcess: () => child });
    await runner.start({ ...xxt, dir: '/', entry: { posix: '.', win32: '.' } }, {});
    runner.stop('xuexitong');
    t.mock.timers.tick(7999);
    assert.deepEqual(sent, ['SIGINT']);
    t.mock.timers.tick(1);
    assert.deepEqual(sent, ['SIGINT', 'SIGKILL'], 'killed 发完 SIGINT 就是 true，不能拿它判断进程退没退');

    /* 已经自己退出了的，就不再补一刀 */
    const quiet = Object.assign(fakeChild(), { exitCode: null, signalCode: null });
    const quietSent = [];
    quiet.kill = (signal) => { quietSent.push(signal); quiet.killed = true; };
    const other = createRunner({ root: '/tmp', platform: 'linux', spawnProcess: () => quiet });
    await other.start({ ...xxt, dir: '/', entry: { posix: '.', win32: '.' } }, {});
    other.stop('xuexitong');
    quiet.exitCode = 0;
    t.mock.timers.tick(8000);
    assert.deepEqual(quietSent, ['SIGINT']);
});

test('跑进程：Windows 上按进程树结束，不然 node / python 会留在后台接着播', async () => {
    const calls = [];
    const child = Object.assign(fakeChild(), { pid: 4242 });
    const runner = createRunner({
        root: '/tmp', platform: 'win32',
        spawnProcess: (command, args) => { calls.push([command, args]); return calls.length === 1 ? child : fakeChild(); },
    });
    await runner.start({ ...xxt, dir: '/', entry: { posix: '.', win32: '.' } }, {});
    runner.stop('xuexitong');
    assert.deepEqual(calls[1], ['taskkill', ['/pid', '4242', '/T', '/F']]);
    assert.equal(child.killed, false, '不该只结束 cmd.exe');
});

test('跑进程：界面能看到这次用了什么设置，但看不到密码', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'launcher-'));
    try {
        await writeFile(join(dir, 'config.linux.ini'), INI, 'utf8');
        await writeFile(join(dir, 'run.sh'), '#!/bin/sh\n', 'utf8');
        const runner = createRunner({ root: dir, platform: 'linux', spawnProcess: () => fakeChild() });
        await runner.start({ ...zhs, dir: '.' }, { 'course-url.URL1': 'https://x', 'user-account.password': 'secret' });
        assert.equal(runner.toolState('autovisor').values['course-url.URL1'], 'https://x');
        assert.equal(JSON.stringify(runner.state()).includes('secret'), false);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('跑进程：必填项没填就不启动', async () => {
    let spawned = false;
    const runner = createRunner({ root: '/tmp', platform: 'linux', spawnProcess: () => { spawned = true; return fakeChild(); } });
    await assert.rejects(runner.start({ ...zhs, dir: '/', entry: { posix: '.', win32: '.' } }, {}), /课程地址/);
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
        await runner.start({ ...zhs, dir: '.' }, {
            'course-url.URL1': 'https://studyvideoh5.zhihuishu.com/x',
            'course-option.limitSpeed': 'max',
        });
        assert.deepEqual(call.args, ['--config', 'config.linux.ini']);
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
