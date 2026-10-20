/* 不需要浏览器的部分：参数拼装、配置文件合并、打开浏览器的命令、跑进程的状态机 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { buildArgs, applyConfig, missingRequired } from '../src/args.mjs';
import { openCommand } from '../src/open.mjs';
import { byId, entryFor } from '../src/tools.mjs';
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
    assert.deepEqual(buildArgs(xxt, { '--no-mute': false }), [], '没勾不该冒出一个反向参数');
    assert.deepEqual(buildArgs(xxt, { '--no-mute': true }), ['--no-mute']);
    /* 开关不该被当成带值的参数 */
    assert.equal(buildArgs(xxt, { '--no-mute': true }).length, 1);
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

test('跑进程：同一时间只允许一个', async () => {
    const child = fakeChild();
    const runner = createRunner({ root: '/tmp', platform: 'linux', spawnProcess: () => child });
    const tool = { ...xxt, dir: '.' };
    /* locate 会检查目录存在, 这里直接用一个存在的目录 */
    const ok = { ...tool, dir: '/' , entry: { posix: '.', win32: '.' } };
    await runner.start(ok, {});
    await assert.rejects(runner.start(ok, {}), /还在跑/);
    child.emit('close', 0, null);
    assert.equal(runner.state().running, false);
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
    assert.equal(runner.state().status, '正在播放 1/3');
    assert.equal(runner.state().lines.includes('[[status]] 正在播放 1/3'), false, '状态不该混进日志');
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
