/* 两个入口共用的那一层：设置、锁、握手 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSettings, settingsDir } from '../src/settings.mjs';
import { acquireLock, readLock, describeHolder } from '../src/lock.mjs';
import { describe, byId } from '../src/tools.mjs';

const RUN = fileURLToPath(new URL('../run.mjs', import.meta.url));

test('设置放在系统的用户配置目录', () => {
    assert.equal(settingsDir('win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'C:\\Users\\u'),
        'C:\\Users\\u\\AppData\\Roaming\\course-helper');
    assert.equal(settingsDir('linux', {}, '/home/u'), '/home/u/.config/course-helper');
    assert.equal(settingsDir('linux', { XDG_CONFIG_HOME: '/x' }, '/home/u'), '/x/course-helper');
    assert.equal(settingsDir('darwin', {}, '/Users/u'), '/Users/u/Library/Application Support/course-helper');
});

test('设置：记住上次选的平台和填过的值，密码不存，坏文件当作没有', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'settings-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const settings = createSettings({ dir });
    assert.deepEqual(settings.read(), { picked: null, values: {} });

    const zhs = byId('autovisor');
    settings.remember(zhs, { 'course-option.limitMaxTime': '45', 'user-account.username': '138', 'user-account.password': 'secret' });
    assert.equal(settings.read().picked, 'autovisor');
    assert.deepEqual(settings.valuesFor('autovisor'), { 'course-option.limitMaxTime': '45', 'user-account.username': '138' });
    assert.equal((await readFile(settings.file, 'utf8')).includes('secret'), false, '密码不落盘');

    settings.pick('yuketang');
    assert.equal(settings.read().picked, 'yuketang');
    assert.equal(settings.valuesFor('autovisor')['course-option.limitMaxTime'], '45', '换平台不丢别的');

    await writeFile(settings.file, '{坏了', 'utf8');
    assert.deepEqual(settings.read(), { picked: null, values: {} });
});

test('预填：工具自己的配置 > 上次填的 > 默认值；密码不预填', () => {
    const tools = describe('/nonexistent', 'linux', {
        remembered: { xuexitong: { '--playback-rate': '1', '--max-sections': '3' }, autovisor: { 'user-account.password': 'x' } },
    });
    const xxt = tools.find((tool) => tool.id === 'xuexitong');
    const option = (key) => xxt.options.find((o) => o.flag === key);
    assert.equal(option('--playback-rate').remembered, '1');
    assert.equal(option('--max-sections').remembered, '3');
    assert.equal(option('--browser').remembered, undefined);
    const zhs = tools.find((tool) => tool.id === 'autovisor');
    assert.equal(zhs.options.find((o) => o.type === 'password').remembered, undefined);
});

test('锁：同一时间只能一个后端；占锁的进程不在了就接手；只释放自己的', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'lock-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const alive = new Set([100]);
    const isAlive = (pid) => alive.has(pid);

    const first = acquireLock({ dir, kind: 'tui', pid: 100, isAlive });
    assert.equal(first.ok, true);
    const second = acquireLock({ dir, kind: 'gui', pid: 200, isAlive });
    assert.equal(second.ok, false);
    assert.equal(second.holder.kind, 'tui');
    assert.match(describeHolder(second.holder, second.file), /终端版的网课助手正在运行/);

    /* 第一个崩了没来得及删锁 */
    alive.delete(100);
    const third = acquireLock({ dir, kind: 'gui', pid: 200, isAlive });
    assert.equal(third.ok, true, '失效的锁直接接手');
    first.release();
    assert.equal(readLock(dir).pid, 200, '不能把别人的锁删掉');
    third.release();
    assert.equal(readLock(dir), null);

    await writeFile(join(dir, 'launcher.lock'), '坏文件', 'utf8');
    assert.equal(acquireLock({ dir, kind: 'web', pid: 300, isAlive }).ok, true, '读不出来的锁当作失效');
});

/* 起一个真实的后端：按窗口版外壳的方式用 --handshake */
function startBackend(env) {
    const child = spawn(process.execPath, [RUN, '--handshake'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const firstLine = new Promise((resolve, reject) => {
        let out = '';
        child.stdout.on('data', (chunk) => {
            out += chunk;
            const end = out.indexOf('\n');
            if (end >= 0) resolve(JSON.parse(out.slice(0, end)));
        });
        child.on('error', reject);
    });
    const closed = new Promise((resolve) => child.on('close', (code) => resolve(code)));
    return { child, firstLine, closed };
}

test('握手：窗口版外壳拿到地址；第二个被锁挡住；关掉 stdin 就退出并释放锁', async (t) => {
    const config = await mkdtemp(join(tmpdir(), 'handshake-'));
    t.after(() => rm(config, { recursive: true, force: true }));
    const env = { XDG_CONFIG_HOME: config, APPDATA: config };

    const one = startBackend(env);
    const ready = await one.firstLine;
    assert.equal(ready.ready, true);
    assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+$/);
    const tools = await (await fetch(ready.url.replace('/?', '/api/tools?'))).json();
    assert.equal(tools.tools.length, 3);
    assert.ok('picked' in tools, '上次选的平台由后端给');

    const two = startBackend(env);
    const refused = await two.firstLine;
    assert.equal(refused.ready, false);
    assert.equal(refused.error, 'locked');
    assert.equal(refused.holder.kind, 'gui');
    assert.equal(await two.closed, 3);

    one.child.stdin.end();
    assert.equal(await one.closed, 0, '窗口关了：收尾后正常退出');
    const three = startBackend(env);
    assert.equal((await three.firstLine).ready, true, '锁已经释放');
    three.child.stdin.end();
    await three.closed;
});
