/* ------------------------------------------------------------------
 * 行为伪装的运行时冒烟测试
 * 用一套极简 DOM 桩在 vm 里真正跑一遍脚本，断言那几条“降低自动化特征”
 * 的改动确实生效：没有固定全局名、点击是完整的指针序列、等待时长会抖动、
 * 默认不去写 playbackRate。
 * 桩的 querySelectorAll 按确切的选择器字符串查表，够这几条路径用。
 * ------------------------------------------------------------------ */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(root, 'v3_optimized.js'), 'utf8');

class El {
    constructor(tag, options = {}) {
        this.tagName = tag.toUpperCase();
        this.id = options.id || '';
        this.classes = new Set(options.classes || []);
        this.children = options.children || [];
        this.attrs = options.attrs || {};
        this.queries = options.queries || {};
        this.events = [];
        this.focused = 0;
        this.isConnected = true;
        this.textContent = options.text || '';
        this.offsetWidth = 120;
        this.offsetHeight = 24;
        this.rect = options.rect || { left: 320, top: 180, width: 140, height: 28 };
    }

    get classList() {
        return { contains: (name) => this.classes.has(name) };
    }

    matches(selector) {
        if (selector.startsWith('.')) return this.classes.has(selector.slice(1));
        if (selector.startsWith('#')) return this.id === selector.slice(1);
        return this.tagName === selector.toUpperCase();
    }

    querySelectorAll(css) {
        return this.queries[css] || [];
    }

    getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    }

    getBoundingClientRect() {
        return this.rect;
    }

    getClientRects() {
        return [{}];
    }

    compareDocumentPosition() {
        return 0;
    }

    closest() {
        return null;
    }

    contains() {
        return true;
    }

    focus() {
        this.focused += 1;
    }

    addEventListener() {}

    removeEventListener() {}

    dispatchEvent(event) {
        event.at = Date.now();
        this.events.push(event);
        return true;
    }
}

const span = new El('span', { classes: ['posCatalog_name'], attrs: { title: '第二节 测试' } });
const firstSpan = new El('span', {
    classes: ['posCatalog_name'],
    attrs: { title: '第一节' },
    rect: { left: 90, top: 420, width: 140, height: 28 },
});
const section2 = new El('li', {
    classes: ['posCatalog_select'],
    queries: { '.posCatalog_name': [span] },
});
const section1 = new El('li', {
    classes: ['posCatalog_select', 'posCatalog_active'],
    queries: { '.posCatalog_name': [firstSpan] },
});
const chapter = new El('li', {
    queries: { '.posCatalog_select:not(.firstLayer)': [section1, section2] },
});
const list = new El('ul', { children: [chapter] });
const tree = new El('div', { id: 'coursetree', children: [list] });

class FakeEvent {
    constructor(type, init = {}) {
        Object.assign(this, init);
        this.type = type;
        /* 照真实浏览器来：isTrusted 是事件实例自身的 accessor，并且
         * configurable 为 false（WebIDL 的 [LegacyUnforgeable]），
         * Event.prototype 上没有这一项。桩必须一致，否则会得出
         * “可以在实例上遮蔽 isTrusted”的错误结论。 */
        Object.defineProperty(this, 'isTrusted', {
            value: false,
            enumerable: true,
            configurable: false,
        });
    }
}

/* sourceCapabilities 则相反：在 UIEvent.prototype 上且可配置，可以被遮蔽 */
Object.defineProperty(FakeEvent.prototype, 'sourceCapabilities', { get: () => null, configurable: true });

class FakeInputDeviceCapabilities {
    constructor(init = {}) {
        this.firesTouchEvents = Boolean(init.firesTouchEvents);
    }
}

const body = new El('body');
const sandbox = {
    console: { log() {}, warn() {}, error() {}, debug() {} },
    location: { hostname: 'mooc1.chaoxing.com' },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    MouseEvent: FakeEvent,
    PointerEvent: FakeEvent,
    InputDeviceCapabilities: FakeInputDeviceCapabilities,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 },
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener() {},
    removeEventListener() {},
    document: {
        body,
        hidden: false,
        querySelectorAll: (css) => (css === '#coursetree' ? [tree] : []),
        getElementsByClassName: () => [],
        elementFromPoint: () => null,
        addEventListener() {},
        removeEventListener() {},
        contains: () => true,
    },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'v3_optimized.js' });

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/* 启动前有一段随机反应时间（最长 5.5 秒），之后才去找课程目录 */
await sleep(7000);

const ownNames = Object.getOwnPropertyNames(sandbox);
assert.equal(ownNames.includes('app'), false, 'window.app 不应被占用');
assert.equal(ownNames.includes('__xuexitongPlayerV3'), false, '不应再使用固定的全局名');

const handles = ownNames.filter((name) => name.startsWith('__') && sandbox[name] && sandbox[name].app);
assert.equal(handles.length, 1, `应当恰好有一个随机句柄，实际: ${handles.join(', ')}`);
assert.match(handles[0], /^__[a-z0-9]{9}$/, '句柄名应为随机串');

const app = sandbox[handles[0]].app;
assert.equal(app.configs.playbackRate, 1, '默认倍速应为 1');

/* 默认配置下一次都不写 playbackRate */
let rateWrites = 0;
const fakeVideo = {
    _rate: 1,
    get playbackRate() { return this._rate; },
    set playbackRate(value) { rateWrites += 1; this._rate = value; },
};
app._applyPlaybackRate(fakeVideo);
assert.equal(rateWrites, 0, '默认配置不应写入 playbackRate');
app.configs.playbackRate = 1.5;
app.configs.playbackRateJitter = 0.08;
const jittered = new Set();
for (let i = 0; i < 12; i += 1) jittered.add(app._applyPlaybackRate(fakeVideo));
assert.ok(jittered.size > 1, '开启抖动后倍速不应是一个死值');
assert.ok([...jittered].every((rate) => rate > 1.4 && rate < 1.6), `倍速应落在区间内: ${[...jittered]}`);
app.configs.playbackRate = 1;
app.configs.playbackRateJitter = 0;

/* 等待时长抖动 */
const waits = new Set();
for (let i = 0; i < 24; i += 1) waits.add(app._ms(1000));
assert.ok(waits.size > 8, `等待时长应当分散，实际只有 ${waits.size} 种`);
assert.equal([...waits].every((ms) => ms === 1000), false, '等待时长不应恒定');
app.configs.humanize = false;
assert.equal(app._ms(1000), 1000, 'humanize 关闭后应回到确定值');
app.configs.humanize = true;

/* 点击必须是完整的指针序列。先点第一节，让指针有一个“上一刻的位置”，
 * 再点第二节——这样才能验证进入元素时的位移与 relatedTarget。 */
app.playCurrentIndex(section1);
await sleep(600);
app.playCurrentIndex(section2);
await sleep(600);
const types = span.events.map((event) => event.type);
for (const expected of ['pointerover', 'pointermove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    assert.ok(types.includes(expected), `点击序列缺少 ${expected}，实际: ${types.join(' > ')}`);
}
assert.ok(types.indexOf('mousedown') < types.indexOf('mouseup'), 'mousedown 应早于 mouseup');
assert.ok(types.indexOf('mouseup') < types.indexOf('click'), 'mouseup 应早于 click');
assert.equal(span.focused > 0, true, '按下时应当聚焦目标');

const click = span.events.find((event) => event.type === 'click');
const mousedown = span.events.find((event) => event.type === 'mousedown');
assert.ok(click.clientX > 0 && click.clientY > 0, 'click 不应携带 0,0 坐标');
assert.ok(click.screenX !== click.clientX || click.screenY !== click.clientY, 'screen 坐标应与 client 坐标有偏移');
assert.equal(click.detail, 1, 'click 的 detail 应为 1');
assert.equal(mousedown.buttons, 1, 'mousedown 的 buttons 应为 1');
assert.ok(click.at - mousedown.at >= 40, `按下到点击之间应有人手量级的间隔，实际 ${click.at - mousedown.at}ms`);

/* 合成事件与真实事件之间的差异点：哪些补上了，哪些补不了 */
for (const event of span.events) {
    /* isTrusted 在浏览器里不可伪造（configurable: false），这里确认脚本既没有
     * 伪造成功的假象，也没有因为尝试写它而抛出未捕获异常 */
    assert.equal(event.isTrusted, false, 'isTrusted 不可伪造，应当如实为 false');
    assert.ok(
        event.sourceCapabilities instanceof FakeInputDeviceCapabilities,
        `${event.type} 应带 sourceCapabilities`
    );
}
assert.equal(span.events.find((event) => event.type === 'pointerdown').pointerId, 1, '鼠标的 pointerId 应为 1');
assert.ok(span.events.length > 0, '第二个节点应当收到事件');
const mouseover = span.events.find((event) => event.type === 'mouseover');
assert.equal(mouseover.relatedTarget, firstSpan, 'mouseover 的 relatedTarget 应是上一刻悬停的元素');
assert.ok(
    mouseover.movementX !== 0 || mouseover.movementY !== 0,
    '从别处移入时应当带指针位移'
);
/* pointermove 与 mousemove 对应同一次底层移动，位移值必须相同 */
const pointerMove = span.events.find((event) => event.type === 'pointermove');
const mouseMove = span.events.find((event) => event.type === 'mousemove');
assert.equal(pointerMove.movementX, mouseMove.movementX, 'pointermove 与 mousemove 的位移应一致');
assert.equal(pointerMove.movementY, mouseMove.movementY, 'pointermove 与 mousemove 的位移应一致');
/* 按下、抬起、点击发生在指针停住的同一点上，坐标必须一致且不再带位移 */
const mouseup = span.events.find((event) => event.type === 'mouseup');
assert.equal(mousedown.clientX, click.clientX, 'mousedown 与 click 坐标应一致');
assert.equal(mouseup.clientX, click.clientX, 'mouseup 与 click 坐标应一致');
assert.equal(click.movementX, 0, 'click 不应带指针位移');
assert.equal(click.movementY, 0, 'click 不应带指针位移');

/* 默认静音, 且不会在静音起播后自己退出静音 */
assert.equal(app.configs.mute, true, '默认应当静音');
let unmuteScheduled = false;
const realDelay = app._delay;
app._delay = (...args) => { unmuteScheduled = true; return realDelay.apply(app, args); };
app._scheduleUnmute();
app._delay = realDelay;
assert.equal(unmuteScheduled, false, '默认静音时不应安排退出静音');
const loudVideo = { muted: false };
app._muteIfNeeded(loudVideo);
assert.equal(loudVideo.muted, true, '起播前应当静音');
app.configs.mute = false;
const wantedSound = { muted: false };
app._muteIfNeeded(wantedSound);
assert.equal(wantedSound.muted, false, 'mute 关掉后不应动静音状态');
app.configs.mute = true;

/* 切节: 目录上有任务点标记时跳到下一个有待完成任务点的小节(和 Playwright 版同一套规则) */
const marks = (list) => list.map(([pending, active = false]) => ({ pending, active }));
let next = app._pickNextSection(marks([[0, true], [0], [0], [1], [0]]));
assert.deepEqual([next.index, next.skipped], [3, 2], '应当越过 0 个任务点的小节');
next = app._pickNextSection(marks([[1, true], [0], [0]]));
assert.deepEqual([next.index, next.marked], [-1, true], '后面都没有待完成的应当收尾');
next = app._pickNextSection(marks([[0, true], [0], [null], [1]]));
assert.equal(next.index, 2, '读不出标记的小节要进去看看');
next = app._pickNextSection(marks([[null, true], [null], [null]]));
assert.deepEqual([next.index, next.marked], [1, false], '旧布局没有标记时按顺序');
next = app._pickNextSection(marks([[null], [null, true]]));
assert.equal(next.index, -1, '最后一节之后没有下一节');

/* destroy() 之后不应再留下全局名和待执行的回调 */
app.destroy();
await sleep(200);
const afterDestroy = span.events.length;
await sleep(400);
assert.equal(span.events.length, afterDestroy, 'destroy() 后不应再派发事件');

console.log('行为伪装冒烟测试通过：随机句柄、完整点击序列、抖动等待、默认不改倍速、默认静音、按任务点切节。');
