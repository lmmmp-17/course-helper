(function () {
    'use strict';

    /* 下面三个固定名字只保留给“从 3.4 及更早版本升级”时清理僵尸实例用。
     * 本实例自己不再占用任何可预测的全局名：固定的 window.app /
     * window.__xuexitongPlayerV3 是页面侧一行代码就能查到的脚本指纹。 */
    const LEGACY_RUNTIME_KEY = '__xuexitongPlayerV3';
    const LEGACY_BOOT_TIMER_KEY = '__xuexitongPlayerV3BootTimer';
    const LEGACY_APP_BRAND = '__isXuexitongPlayerV3';
    /* 本实例的标记挂在 Symbol 上，页面枚举属性时看不到 */
    const RUNTIME_BRAND = Symbol.for('xuexitong.player.runtime');
    const ALLOWED_HOSTS = ['chaoxing.com'];

    /* ------------------------------------------------------------------
     * 域名校验
     * 控制台版本靠人工粘贴运行，粘到错误的标签页（或外观相似的钓鱼页面）时，
     * 脚本会在未知 DOM 上盲点元素。这里先确认当前确实在学习通域名下。
     * ------------------------------------------------------------------ */
    function isAllowedHost() {
        const host = (location.hostname || '').toLowerCase();
        return ALLOWED_HOSTS.some((base) => host === base || host.endsWith(`.${base}`));
    }

    if (!isAllowedHost()) {
        console.error(
            '%c当前页面不属于学习通（chaoxing.com）域名，脚本已停止，以免在非预期页面上执行点击。',
            'color:#F44336;font-weight:bold'
        );
        return;
    }

    /* ------------------------------------------------------------------
     * 原生 console 引用
     * 页面侧可以包装 console 的方法来采集日志，所以启动时先把引用取下来，
     * 之后一律走这里输出。配合默认的最低日志档（configs.logLevel），
     * 控制台不再出现成片的彩色横幅。
     * ------------------------------------------------------------------ */
    const log = (() => {
        const bind = (name) => {
            const fn = console && typeof console[name] === 'function' ? console[name] : null;
            return fn ? fn.bind(console) : () => {};
        };
        return { info: bind('log'), warn: bind('warn'), error: bind('error'), debug: bind('debug') };
    })();

    /* ------------------------------------------------------------------
     * 随机化原语
     * 页面能看出“这不是人在操作”，多数时候只靠三件事：
     *   1. 整数对齐、永远等长的定时器
     *   2. clientX/clientY 全为 0、没有按下抬起过程的孤立 click
     *   3. 从头到尾一个值的参数（倍速、间隔、冷却）
     * 所以脚本里不再写死毫秒数，所有等待与点击都从这里取值。
     * ------------------------------------------------------------------ */
    const human = (() => {
        const source = (() => {
            const cryptoApi = window.crypto || window.msCrypto;
            if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
                const buffer = new Uint32Array(1);
                return () => {
                    cryptoApi.getRandomValues(buffer);
                    return buffer[0] / 4294967296;
                };
            }
            return () => Math.random();
        })();

        const float = (min, max) => min + source() * (max - min);
        const int = (min, max) => Math.floor(float(min, max + 1));
        const chance = (probability) => source() < probability;

        return {
            float,
            int,
            chance,
            pick: (list) => list[int(0, list.length - 1)],
            /* 以 base 为中心抖动，并留一条长尾：真人的间隔不会整齐地落在同一个区间里 */
            spread(base, ratio) {
                const value = base * float(1 - ratio, 1 + ratio);
                return chance(0.08) ? value * float(1.3, 2.1) : value;
            },
            token(length) {
                const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
                let out = '';
                for (let i = 0; i < length; i += 1) {
                    out += alphabet[int(0, alphabet.length - 1)];
                }
                return out;
            },
        };
    })();

    /* ------------------------------------------------------------------
     * 运行时接管：清理上一个实例
     * 旧版把启动定时器和实例分别挂在两个固定全局变量上，且 destroy() 并不会
     * 取消已经排队的 setTimeout，于是重复粘贴会留下“僵尸实例”继续点击页面。
     * 现在实例挂在随机名下，所以改为扫描 window 上的 __ 前缀自有属性，
     * 按 Symbol 标记（或旧版的固定名）认领后再停掉。
     * ------------------------------------------------------------------ */
    function destroyRuntimeLike(value) {
        /* 定时器 id 在浏览器里是同一个空间，clearInterval 也能清掉 setTimeout */
        try {
            if (value.bootTimer) {
                clearInterval(value.bootTimer);
            }
        } catch (e) {
            /* 忽略：旧实例的形态可能不同 */
        }
        /* value.destroy 是 3.3 及更早版本的形态：实例直接挂在命名空间上 */
        const staleApp = value.app || (typeof value.destroy === 'function' ? value : null);
        if (staleApp && typeof staleApp.destroy === 'function') {
            try {
                staleApp.destroy();
            } catch (e) {
                log.warn('清理旧实例时出错，已忽略:', e);
            }
        }
    }

    (function cleanupStaleRuntimes() {
        let names;
        try {
            names = Object.getOwnPropertyNames(window);
        } catch (e) {
            names = [LEGACY_RUNTIME_KEY, LEGACY_BOOT_TIMER_KEY];
        }
        for (const name of names) {
            /* 只看 __ 前缀的属性：既覆盖旧版固定名也覆盖本版随机名，
             * 同时避免去读 window 上那些带副作用的宿主 getter */
            if (name.length < 3 || name[0] !== '_' || name[1] !== '_') continue;
            let value;
            try {
                value = window[name];
            } catch (e) {
                continue;
            }
            if (name === LEGACY_BOOT_TIMER_KEY && typeof value === 'number') {
                clearInterval(value);
                try {
                    window[LEGACY_BOOT_TIMER_KEY] = null;
                } catch (e) {
                    /* 忽略 */
                }
                continue;
            }
            if (!value || typeof value !== 'object') continue;
            if (value[RUNTIME_BRAND] !== true && name !== LEGACY_RUNTIME_KEY) continue;
            destroyRuntimeLike(value);
            try {
                delete window[name];
            } catch (e) {
                /* 忽略：旧版是直接赋值，删不掉也不影响接管 */
            }
        }
        /* 3.4 会把实例挂到 window.app 上，按 brand 认领后一并撤掉 */
        try {
            const legacyApp = window.app;
            if (legacyApp && legacyApp[LEGACY_APP_BRAND]) {
                if (typeof legacyApp.destroy === 'function') {
                    legacyApp.destroy();
                }
                delete window.app;
            }
        } catch (e) {
            /* 忽略 */
        }
    })();

    const runtime = { bootTimer: null, app: null, [RUNTIME_BRAND]: true };
    /* 每次运行都是新的随机句柄名，并且不可枚举 */
    const RUNTIME_KEY = `__${human.token(9)}`;
    try {
        Object.defineProperty(window, RUNTIME_KEY, {
            value: runtime,
            writable: true,
            configurable: true,
            enumerable: false,
        });
    } catch (e) {
        window[RUNTIME_KEY] = runtime;
    }

    /* ------------------------------------------------------------------
     * 内置极简 DOM 工具
     * 替代原先从 code.jquery.com 动态注入的 jQuery。去掉远程依赖后：
     *   - 不再向已登录的课程页注入任何第三方代码
     *   - 不会把带课程/班级 ID 的页面地址通过 Referer 泄露给第三方 CDN
     *   - 不受页面 CSP 限制，也不依赖页面自带的 window.jQuery 是否可信
     * 只实现本脚本实际用到的那几个方法。
     * ------------------------------------------------------------------ */
    const dom = (() => {
        const VISIBLE_PSEUDO = ':visible';

        const isVisible = (el) => !!(
            el && (
                el.offsetWidth > 0 ||
                el.offsetHeight > 0 ||
                (typeof el.getClientRects === 'function' && el.getClientRects().length > 0)
            )
        );

        function splitSelectorList(selector) {
            const parts = [];
            let depth = 0;
            let current = '';
            for (const ch of selector) {
                if (ch === '(' || ch === '[') {
                    depth += 1;
                } else if (ch === ')' || ch === ']') {
                    depth -= 1;
                }
                if (ch === ',' && depth === 0) {
                    parts.push(current);
                    current = '';
                    continue;
                }
                current += ch;
            }
            parts.push(current);
            return parts.map((part) => part.trim()).filter((part) => part.length > 0);
        }

        function inDocumentOrder(nodes) {
            const unique = [];
            for (const node of nodes) {
                if (node && !unique.includes(node)) {
                    unique.push(node);
                }
            }
            return unique.sort((a, b) => {
                if (a === b) return 0;
                const relation = a.compareDocumentPosition(b);
                if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
                if (relation & Node.DOCUMENT_POSITION_PRECEDING) return 1;
                return 0;
            });
        }

        function runQuery(root, css) {
            try {
                return Array.from(root.querySelectorAll(css));
            } catch (e) {
                log.debug('选择器无法解析，已跳过:', css);
                return [];
            }
        }

        function queryAll(root, selector) {
            if (!root || typeof root.querySelectorAll !== 'function') return [];
            const parts = splitSelectorList(selector);
            if (parts.length === 1 && !parts[0].includes(VISIBLE_PSEUDO)) {
                return runQuery(root, parts[0]);
            }

            const matched = [];
            for (const part of parts) {
                const needsVisible = part.includes(VISIBLE_PSEUDO);
                const css = needsVisible ? part.split(VISIBLE_PSEUDO).join('').trim() : part;
                if (!css) continue;
                const found = runQuery(root, css);
                matched.push(...(needsVisible ? found.filter(isVisible) : found));
            }
            return inDocumentOrder(matched);
        }

        class Nodes {
            constructor(elements) {
                this.elements = elements;
                this.length = elements.length;
            }

            get(index) {
                return this.elements[index];
            }

            toArray() {
                return this.elements.slice();
            }

            each(callback) {
                this.elements.forEach((el, index) => callback(index, el));
                return this;
            }

            filter(predicate) {
                return new Nodes(this.elements.filter((el, index) => predicate(index, el)));
            }

            first() {
                return new Nodes(this.elements.slice(0, 1));
            }

            find(selector) {
                if (this.elements.length === 1) {
                    return new Nodes(queryAll(this.elements[0], selector));
                }
                const matched = [];
                for (const el of this.elements) {
                    matched.push(...queryAll(el, selector));
                }
                return new Nodes(inDocumentOrder(matched));
            }

            children(selector) {
                const matched = [];
                for (const el of this.elements) {
                    for (const child of Array.from(el.children || [])) {
                        if (!selector || (typeof child.matches === 'function' && child.matches(selector))) {
                            matched.push(child);
                        }
                    }
                }
                return new Nodes(matched);
            }

            hasClass(name) {
                return this.elements.some((el) => el.classList && el.classList.contains(name));
            }

            attr(name) {
                const el = this.elements[0];
                return el && typeof el.getAttribute === 'function' ? el.getAttribute(name) : null;
            }

            text() {
                return this.elements.map((el) => el.textContent || '').join('');
            }
        }

        const select = (target) => {
            if (target instanceof Nodes) return target;
            if (typeof target === 'string') return new Nodes(queryAll(document, target));
            if (!target) return new Nodes([]);
            if (Array.isArray(target)) return new Nodes(target.filter(Boolean));
            return new Nodes([target]);
        };

        /* 事件委托：登记所有监听器，destroy() 时逐一摘除，不留残留 */
        const listeners = [];

        function on(root, type, selector, handler) {
            const listener = (event) => {
                const start = event.target;
                if (!start || typeof start.closest !== 'function') return;
                const matched = start.closest(selector);
                if (!matched || !root.contains(matched)) return;
                handler(matched, event);
            };
            root.addEventListener(type, listener, false);
            listeners.push({ root, type, listener });
        }

        /* ------------------------------------------------------------------
         * 人类化指针事件
         * 页面上一次真实点击会依次产生 pointerover / pointermove / pointerdown /
         * mousedown / focus / pointerup / mouseup / click，每个事件都带着真实坐标、
         * button / buttons / detail，彼此之间还隔着几十毫秒。旧实现只派发一个
         * clientX=clientY=0、detail=0 的孤立 click——这是整个脚本里最容易被单独
         * 识别出来的特征，所以这里把序列补齐。
         * （isTrusted 由浏览器决定，脚本无法伪造；能对齐的部分先对齐。）
         * ------------------------------------------------------------------ */
        const POINTER_TYPES = new Set(['pointerover', 'pointerenter', 'pointermove', 'pointerdown', 'pointerup']);
        /* 窗口在屏幕上的位置：screen 坐标与 client 坐标之间应当差一个固定偏移，
         * 而不是两者完全相等 */
        const screenOffset = { x: human.int(0, 48), y: human.int(74, 136) };
        /* Chrome 给鼠标的 pointerId 固定是 1，随机值反而不对 */
        const MOUSE_POINTER_ID = 1;
        const pending = new Set();
        let lastPoint = null;
        let lastHover = null;

        /* movementX/Y 来自底层那一次输入事件：同一次移动派发出的 pointermove 与
         * mousemove 共享同一个位移值，而按下 / 抬起 / 点击自身不含位移（指针已经
         * 停住了）。所以位移由调用处显式给出，不从坐标差去猜。 */
        function movementInit(point) {
            const movement = lastPoint
                ? { x: point.x - lastPoint.x, y: point.y - lastPoint.y }
                : { x: 0, y: 0 };
            lastPoint = point;
            return { movementX: movement.x, movementY: movement.y };
        }

        /* 合成事件与真实事件之间还剩几处可读的差异。先说清楚哪一处补不了：
         *
         * isTrusted 补不了。它在 WebIDL 里标了 [LegacyUnforgeable]，浏览器把它装成
         * 事件实例自身的 accessor，而且 configurable 为 false——Event.prototype 上
         * 根本没有这个属性。于是两条路都是死的：
         *   - Object.defineProperty(event, 'isTrusted', ...) 直接抛 TypeError
         *   - 改 Event.prototype 也没用，那上面没这一项，而且实例属性本就优先
         * 所以页面只要写 if (!e.isTrusted) return，浏览器内的脚本就一定过不去。
         * 需要可信输入只能走浏览器层面的注入，见仓库里的 playwright/ 目录。
         *
         * 能补的是这些：
         *   - sourceCapabilities：真实 UIEvent 带 InputDeviceCapabilities，合成事件
         *     默认是 null。它在 UIEvent.prototype 上且可配置，在实例上定义一个同名
         *     属性就能遮蔽掉。
         *   - movementX/Y、clientX/Y、detail、buttons、pointerId、pressure：
         *     MouseEventInit / PointerEventInit 直接支持，照真实语义填即可。 */
        const inputCapabilities = (() => {
            try {
                return typeof window.InputDeviceCapabilities === 'function'
                    ? new window.InputDeviceCapabilities({ firesTouchEvents: false })
                    : null;
            } catch (e) {
                return null;
            }
        })();

        function addUserEventTraits(event) {
            if (!inputCapabilities) return event;
            try {
                Object.defineProperty(event, 'sourceCapabilities', {
                    value: inputCapabilities,
                    configurable: true,
                });
            } catch (e) {
                /* 忽略：拿不到就保持 null，不影响派发 */
            }
            return event;
        }

        function schedule(fn, delay) {
            const id = setTimeout(() => {
                pending.delete(id);
                fn();
            }, delay);
            pending.add(id);
            return id;
        }

        function cancelPending() {
            for (const id of pending) {
                clearTimeout(id);
            }
            pending.clear();
        }

        function pointIn(el) {
            const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
            if (!rect || (rect.width <= 0 && rect.height <= 0)) {
                return {
                    x: human.int(60, Math.max(140, (window.innerWidth || 1280) - 60)),
                    y: human.int(80, Math.max(180, (window.innerHeight || 720) - 80)),
                };
            }
            /* 落点避开边缘，也不是每次都精准命中正中心 */
            return {
                x: Math.round(rect.left + rect.width * human.float(0.25, 0.75)),
                y: Math.round(rect.top + rect.height * human.float(0.3, 0.7)),
            };
        }

        function jitterPoint(point, radius) {
            return {
                x: point.x + human.int(-radius, radius),
                y: point.y + human.int(-radius, radius),
            };
        }

        function fire(el, type, point, extra) {
            if (!el || el.isConnected === false) return;
            const isPointer = POINTER_TYPES.has(type);
            if (isPointer && typeof window.PointerEvent !== 'function') return;
            const init = Object.assign({
                bubbles: true,
                cancelable: true,
                composed: true,
                view: window,
                clientX: point.x,
                clientY: point.y,
                screenX: point.x + screenOffset.x,
                screenY: point.y + screenOffset.y,
                movementX: 0,
                movementY: 0,
                button: 0,
                buttons: 0,
                detail: 0,
            }, extra);
            try {
                const event = isPointer
                    ? new PointerEvent(type, Object.assign({
                        pointerId: MOUSE_POINTER_ID,
                        pointerType: 'mouse',
                        isPrimary: true,
                        width: 1,
                        height: 1,
                        pressure: init.buttons ? 0.5 : 0,
                    }, init))
                    : new MouseEvent(type, init);
                el.dispatchEvent(addUserEventTraits(event));
            } catch (e) {
                log.debug('派发事件失败，已跳过:', type, e);
            }
        }

        function offAll() {
            cancelPending();
            while (listeners.length > 0) {
                const { root, type, listener } = listeners.pop();
                root.removeEventListener(type, listener, false);
            }
        }

        function dispatchClick(el) {
            if (!el) return false;
            const point = pointIn(el);
            /* 真实的 mouseover 带着指针上一刻所在的元素；恒定的 null 相当于
             * 每次都“从窗口外面飘进来”。 */
            const relatedTarget = lastHover && lastHover !== el ? lastHover : null;
            lastHover = el;

            /* 指针先移过去：进入元素这一下同样是一次移动，带着位移 */
            const entering = Object.assign({ relatedTarget }, movementInit(point));
            fire(el, 'pointerover', point, entering);
            fire(el, 'pointerenter', point, Object.assign({ bubbles: false }, entering));
            fire(el, 'mouseover', point, entering);
            fire(el, 'mouseenter', point, Object.assign({ bubbles: false }, entering));

            let at = human.int(12, 40);
            const moves = human.int(1, 3);
            for (let i = 0; i < moves; i += 1) {
                /* 最后一次移动落在真正的落点上：人是先把指针停住，再按下去的，
                 * 所以 down / up / click 不应该再带位移 */
                const movePoint = i === moves - 1 ? point : jitterPoint(point, 3);
                schedule(() => {
                    const moving = movementInit(movePoint);
                    fire(el, 'pointermove', movePoint, moving);
                    fire(el, 'mousemove', movePoint, moving);
                }, at);
                at += human.int(14, 48);
            }

            schedule(() => {
                fire(el, 'pointerdown', point, { buttons: 1 });
                fire(el, 'mousedown', point, { buttons: 1, detail: 1 });
                if (typeof el.focus === 'function') {
                    try {
                        el.focus({ preventScroll: true });
                    } catch (e) {
                        /* 忽略：部分节点不可聚焦 */
                    }
                }
            }, at);

            /* 按下到抬起的间隔是人手的特征：几十到一百多毫秒 */
            at += human.int(48, 132);
            schedule(() => {
                fire(el, 'pointerup', point, {});
                fire(el, 'mouseup', point, { detail: 1 });
                fire(el, 'click', point, { detail: 1 });
            }, at);

            return true;
        }

        /* 播放期间的低频指针微动：一个真人盯着视频，也不会整小时一个输入事件都不产生 */
        function driftPointer() {
            const base = {
                x: Math.round(human.float(0.15, 0.85) * (window.innerWidth || 1280)),
                y: Math.round(human.float(0.2, 0.8) * (window.innerHeight || 720)),
            };
            let target = null;
            try {
                target = document.elementFromPoint(base.x, base.y);
            } catch (e) {
                target = null;
            }
            target = target || document.body;
            if (!target) return;
            lastHover = target;

            let at = 0;
            const steps = human.int(2, 5);
            for (let i = 0; i < steps; i += 1) {
                const point = jitterPoint(base, 11);
                at += human.int(16, 70);
                schedule(() => {
                    const moving = movementInit(point);
                    fire(target, 'pointermove', point, moving);
                    fire(target, 'mousemove', point, moving);
                }, at);
            }
        }

        return { select, on, offAll, dispatchClick, driftPointer, isVisible };
    })();

    waitForCoursePage();

    /* 启动不再是“页面就绪的同一毫秒立刻动手”，而是先等一段随机的反应时间，
     * 轮询间隔也逐次抖动，避免在服务端日志里留下整秒对齐的节拍。 */
    function waitForCoursePage() {
        const deadline = Date.now() + 30000;
        const tick = () => {
            runtime.bootTimer = null;
            if (dom.select('#coursetree').length > 0) {
                initializePlayer();
                return;
            }
            if (Date.now() >= deadline) {
                log.error('%c脚本启动超时：未检测到课程目录（#coursetree）。请确认当前处于课程播放页。', 'color:#F44336;font-weight:bold');
                return;
            }
            runtime.bootTimer = setTimeout(tick, Math.round(human.spread(1100, 0.45)));
        };
        runtime.bootTimer = setTimeout(tick, Math.round(human.float(1200, 5500)));
    }

    function initializePlayer() {
        const app = {
            [RUNTIME_BRAND]: true,
            configs: {
                /* 倍速默认回到 1：播放心跳会把倍速一起上报，一门课从头到尾恒定
                 * 1.5 倍是最显眼的单项特征。确实需要提速时再自己调高，
                 * 并配合 playbackRateJitter 让它不是一个死值。 */
                playbackRate: 1,
                playbackRateJitter: 0,
                autoplay: true,
                /* 起播前静音, 一点声音都不出。要外放就在控制台把它改成 false */
                mute: true,
                retryInterval: 2000,
                maxRetries: 10,
                videoCheckInterval: 1000,
                guardNoProgressMs: 7000,
                guardResumeCooldownMs: 1500,
                autoAdvanceNoVideo: false,

                /* ---- 以下用于压低自动化特征，全部可在控制台改 ---- */
                humanize: true,                         /* 关掉则所有等待回到固定值 */
                timingSpread: 0.35,                     /* 单次等待的抖动幅度 */
                sectionPauseMs: [2600, 9000],           /* 一节放完到切下一节之间的停顿 */
                longBreakChance: 0.12,                  /* 偶尔“离开一会儿”的概率 */
                longBreakMs: [20000, 70000],
                idleActivity: true,                     /* 播放期间的低频指针微动 */
                idleActivityMs: [18000, 55000],
                backgroundResumeDelayMs: [1200, 4200],  /* 失焦/切回后的恢复延迟 */
                blockWindowLeavePause: false,           /* 不再拦截页面自身的鼠标事件 */
                unmuteAfterStart: true,                 /* 静音起播后退出静音并压到极低音量(只在 mute 为 false 时生效) */
                quietVolume: 0.04,
                resumeWhileHidden: true,                /* 关掉后页面在后台就不碰播放状态 */
                /* silent 连状态行都不打印（warn / error 仍保留，排障用） */
                logLevel: 'quiet',                      /* silent | quiet | normal | verbose */
            },
            _videoEl: null,
            _treeContainerEl: null,
            _isPlaying: false,
            _currentRetryCount: 0,
            _checkInterval: null,
            _eventVideoEl: null,
            _boundVideoHandlers: null,
            _nextUnitPending: false,
            _chapterAdvanceTimes: 0,
            _destroyed: false,
            _timers: new Set(),
            _cellData: {
                cells: 0,
                nCells: 0,
                currentCellIndex: 0,
                currentNCellIndex: 0,
                currentVideoTitle: "",
            },
            get cellData() {
                return this._cellData;
            },
            /* 所有延时任务集中登记，destroy() 后不会再有回调触发页面点击 */
            _later(fn, delay) {
                if (this._destroyed) return null;
                const id = setTimeout(() => {
                    this._timers.delete(id);
                    if (this._destroyed) return;
                    fn();
                }, delay);
                this._timers.add(id);
                return id;
            },
            _cancel(id) {
                if (id === null || id === undefined) return;
                clearTimeout(id);
                this._timers.delete(id);
            },
            /* 把“等多久”统一收口：spec 可以是毫秒数，也可以是 [min, max] 区间。
             * humanize 关闭时退回确定值，方便排查问题。 */
            _ms(spec, spread) {
                if (Array.isArray(spec)) {
                    const [min, max] = spec;
                    return Math.round(this.configs.humanize ? human.float(min, max) : (min + max) / 2);
                }
                const base = Number(spec) || 0;
                if (!this.configs.humanize) return Math.round(base);
                const ratio = typeof spread === 'number' ? spread : this.configs.timingSpread;
                return Math.round(human.spread(base, ratio));
            },
            _delay(fn, spec, spread) {
                return this._later(fn, this._ms(spec, spread));
            },
            /* 日志分三档：关键状态变更始终可见，细节和调试信息默认不输出。
             * 满屏彩色横幅本身也是一种痕迹——页面可以包装 console 把它收走。 */
            _say(...args) {
                if (this.configs.logLevel === 'silent') return;
                log.info(...args);
            },
            _note(...args) {
                if (this.configs.logLevel !== 'quiet') log.info(...args);
            },
            _trace(...args) {
                if (this.configs.logLevel === 'verbose') log.debug(...args);
            },
            _clearTimers() {
                for (const id of this._timers) {
                    clearTimeout(id);
                }
                this._timers.clear();
            },
            run() {
                if (this._destroyed) return;
                this._say('%c已接管当前课程页', 'color:#4CAF50');
                this._nextUnitPending = false;
                this._chapterAdvanceTimes = 0;
                this._getTreeContainer();
                this._initCellData();
                this._videoEl = null;
                this._getVideoEl();
                this._clearCheckInterval();
                this._bindStepNavigation();
                this.play();
            },
            nextUnit() {
                if (this._destroyed) return;
                this._cancel(this._nextUnitTimer);
                this._nextUnitTimer = null;
                if (this._nextUnitPending) {
                    this._note('%c已有小节切换正在进行，忽略重复请求', 'color:#FF9800');
                    return;
                }
                this._nextUnitPending = true;
                this._clearCheckInterval();
                this._note('%c准备切换到下一小节', 'color:#2196F3');
                try {
                    const el = this._getTreeContainer();
                    const sections = [];
                    el.children("ul").children("li").each((i, cell) => {
                        dom.select(cell).find('.posCatalog_select:not(.firstLayer)').each((j, section) => {
                            sections.push({
                                el: section,
                                cell: i,
                                n: j,
                                active: dom.select(section).hasClass('posCatalog_active'),
                                pending: this._sectionPending(section),
                            });
                        });
                    });
                    /* 目录上没有激活项时退回上次记下的位置 */
                    if (!sections.some((section) => section.active)) {
                        for (const section of sections) {
                            section.active = section.cell === this._cellData.currentCellIndex
                                && section.n === this._cellData.currentNCellIndex;
                        }
                    }

                    const { index, skipped, marked } = this._pickNextSection(sections);
                    if (index < 0) {
                        this._nextUnitPending = false;
                        this._say(marked ? '%c后面没有待完成任务点的小节了，课程完成' : '%c本课程已全部播放完成', 'color:#4CAF50;font-weight:bold');
                        return;
                    }
                    const target = sections[index];
                    if (skipped) {
                        this._note(`%c跳过中间 ${skipped} 个没有待完成任务点的小节`, 'color:#FF9800');
                    }
                    this._cellData.currentCellIndex = target.cell;
                    this._cellData.currentNCellIndex = target.n;
                    this.playCurrentIndex(target.el);
                } catch (error) {
                    this._nextUnitPending = false;
                    log.error('切换下一小节失败:', error);
                }
            },
            /* 从当前小节往后找下一节要去的, 返回它在 sections 里的下标(没有为 -1)。
             * 和 Playwright 版 pickNextSection 是同一套规则:
             * 目录上有任务点标记时(mooc2)直接跳到下一个还有待完成任务点的小节——不算
             * 任务点的视频不播, 已完成的也不重放, 一节节点过去只是在目录上连点几十下
             * (实测一门课里 1.3 到 8.1 之间 36 节全是 0 个任务点)。标记读不出来的
             * 小节当作"要进去看看"; 整个目录都没有标记(旧布局)时按顺序取下一节。
             * sections: [{ active, pending }], pending 为 null 表示没有标记。 */
            _pickNextSection(sections) {
                const at = sections.findIndex((section) => section.active);
                const rest = sections.slice(at + 1);
                const marked = sections.some((section) => section.pending !== null && section.pending !== undefined);
                if (!marked) return { index: rest.length ? at + 1 : -1, skipped: 0, marked };
                const offset = rest.findIndex((section) => section.pending === null || section.pending === undefined || section.pending > 0);
                return { index: offset >= 0 ? at + 1 + offset : -1, skipped: offset >= 0 ? offset : rest.length, marked };
            },
            /* 目录上标的待完成任务点数(实测 mooc2): 待完成的带
             * <input type="hidden" class="jobUnfinishCount" value="N">, 完成的带 .icon_Completed,
             * 没有任务点的只有 .catalog_points_yi 里一个 <span class="orangeNew">0</span>。
             * 读不出来返回 null */
            _sectionPending(section) {
                if (!section || typeof section.querySelector !== 'function') return null;
                const unfinished = section.querySelector('.jobUnfinishCount');
                if (unfinished) {
                    const count = parseInt(unfinished.value || unfinished.getAttribute('value'), 10);
                    if (Number.isFinite(count)) return count;
                }
                if (section.querySelector('.icon_Completed')) return 0;
                const points = section.querySelector('.catalog_points_yi .orangeNew');
                if (points) {
                    const count = parseInt(points.textContent, 10);
                    if (Number.isFinite(count)) return count;
                }
                return null;
            },
            _clearCheckInterval() {
                if (this._checkInterval) {
                    this._cancel(this._checkInterval);
                    this._checkInterval = null;
                }
            },
            /* 状态巡检改为自调度：固定 1000ms 的 setInterval 会形成一条非常规整的
             * 节拍，而每一轮都不等长的轮询看起来就只是普通的播放器心跳。 */
            _startVideoMonitoring() {
                this._clearCheckInterval();
                if (this._destroyed) return;
                this._guardLastTime = 0;
                this._guardLastWallTs = 0;
                this._guardLastResumeTs = 0;
                const tick = () => {
                    this._checkInterval = null;
                    if (this._destroyed) return;
                    this._checkVideoStatus();
                    queue();
                };
                const queue = () => {
                    if (this._destroyed || !this._isPlaying) {
                        this._checkInterval = null;
                        return;
                    }
                    this._checkInterval = this._delay(tick, this.configs.videoCheckInterval, 0.3);
                };
                queue();
            },
            /* 一节放完之后不立刻点下一节：真人有几秒反应时间，偶尔还会离开一会儿 */
            _scheduleNextUnit() {
                if (this._destroyed) return;
                /* 等待时长随机之后，重复排程会抽到两个不同的时刻，可能把一节直接跳过。
                 * 这里保证同一时间只有一个待切换的排程。 */
                if (this._nextUnitTimer) return;
                let wait = this._ms(this.configs.sectionPauseMs);
                if (this.configs.humanize && human.chance(this.configs.longBreakChance)) {
                    wait = this._ms(this.configs.longBreakMs);
                    this._say(`%c本节结束，停 ${Math.round(wait / 1000)} 秒后继续`, 'color:#607D8B');
                } else {
                    this._note(`%c本节结束，${(wait / 1000).toFixed(1)} 秒后切换`, 'color:#607D8B');
                }
                this._nextUnitTimer = this._later(() => {
                    this._nextUnitTimer = null;
                    this.nextUnit();
                }, wait);
            },
            /* 倍速会随播放心跳一起上报。默认 base=1 且 jitter=0 时干脆一次都不写这个
             * 属性；需要提速时也在区间里取值，而不是整门课固定同一个数。 */
            _applyPlaybackRate(el) {
                const base = Number(this.configs.playbackRate) || 1;
                const jitter = Math.max(0, Number(this.configs.playbackRateJitter) || 0);
                if (base === 1 && jitter === 0) {
                    return Number(el.playbackRate) || 1;
                }
                const rate = jitter > 0
                    ? Number(human.float(Math.max(0.0625, base - jitter), base + jitter).toFixed(3))
                    : base;
                try {
                    el.playbackRate = rate;
                } catch (e) {
                    this._trace('设置倍速失败:', e);
                }
                return Number(el.playbackRate) || rate;
            },
            /* 长时间挂着 muted 也是容易被单独筛出来的状态。静音起播成功后退出静音、
             * 改用极低音量——听感上仍然约等于静音，但 muted 标记不再立着。
             * 若退出静音导致播放被打断，再回退到静音继续。 */
            /* 默认静音: 每次要调 play() 之前都过一遍 */
            _muteIfNeeded(video) {
                if (!this.configs.mute || !video || video.muted) return;
                video.muted = true;
                this._note('%c已静音', 'color:#607D8B');
            },
            _scheduleUnmute() {
                /* 默认静音时绝不自己退出静音: 0.04 的音量在安静的教室里也听得见 */
                if (this.configs.mute || !this.configs.unmuteAfterStart) return;
                this._delay(() => {
                    const video = this._getVideoEl();
                    if (!video || !this._isPlaying || video.paused || !video.muted) return;
                    try {
                        video.volume = Math.min(1, Math.max(0, Number(this.configs.quietVolume) || 0));
                        video.muted = false;
                    } catch (e) {
                        this._trace('退出静音失败，保持静音:', e);
                        return;
                    }
                    this._delay(() => {
                        const current = this._getVideoEl();
                        if (!current || !this._isPlaying) return;
                        if (current.paused && !current.muted) {
                            this._trace('退出静音后播放被打断，回退静音');
                            current.muted = true;
                            current.play().catch(() => {});
                        }
                    }, [900, 1800]);
                }, [1500, 4200]);
            },
            /* 一整节课连一个输入事件都没有，本身就是信号。播放期间低频地产生
             * 几次指针微动，不改变页面状态，也不碰滚动位置。 */
            _startIdleActivity() {
                if (!this.configs.humanize || !this.configs.idleActivity) return;
                if (this._idleTimer) return;
                const tick = () => {
                    this._idleTimer = null;
                    if (this._destroyed) return;
                    if (!document.hidden && this._isPlaying) {
                        dom.driftPointer();
                    }
                    queue();
                };
                const queue = () => {
                    if (this._destroyed) return;
                    this._idleTimer = this._delay(tick, this.configs.idleActivityMs);
                };
                queue();
            },
            _tryResumePlayback(reason) {
                if (this._destroyed) return;
                const now = Date.now();
                if (now - this._guardLastResumeTs < this._ms(this.configs.guardResumeCooldownMs, 0.3)) {
                    return;
                }
                this._guardLastResumeTs = now;

                const video = this._getVideoEl();
                if (!video || !this._isPlaying) return;
                /* 真人切到别的标签页就是没在看。默认仍然保活，但留一个开关：
                 * 关掉之后页面在后台期间脚本完全不动播放状态。 */
                if (document.hidden && !this.configs.resumeWhileHidden) {
                    this._trace('页面在后台，按配置不恢复播放');
                    return;
                }

                this._note(`%c触发视频保活恢复(${reason})`, 'color:#607D8B');
                /* 平台中途重建过 video 元素时, 新元素不带静音, 直接 play() 会外放 */
                this._muteIfNeeded(video);
                video.play().catch((e) => {
                    log.warn('直接恢复播放失败，尝试静音恢复:', e);
                    video.muted = true;
                    video.play().then(() => {
                        this._scheduleUnmute();
                    }).catch((err) => {
                        log.error('静音恢复播放失败:', err);
                    });
                });
            },
            _checkVideoStatus() {
                try {
                    const video = this._getVideoEl();
                    if (!video) return;

                    if (video.paused && this._isPlaying) {
                        this._note('%c检测到视频暂停，尝试恢复播放...', 'color:#FF5722');
                        this._tryResumePlayback("paused");
                    } else if (this._isPlaying && !video.ended) {
                        const now = Date.now();
                        const current = Number(video.currentTime || 0);
                        if (this._guardLastWallTs === 0) {
                            this._guardLastWallTs = now;
                            this._guardLastTime = current;
                        } else {
                            const stalled = Math.abs(current - this._guardLastTime) < 0.01;
                            const stalledMs = now - this._guardLastWallTs;
                            if (stalled && stalledMs >= this._ms(this.configs.guardNoProgressMs, 0.25)) {
                                this._tryResumePlayback("no-progress");
                                this._guardLastWallTs = now;
                                this._guardLastTime = Number(video.currentTime || 0);
                            } else if (!stalled) {
                                this._guardLastWallTs = now;
                                this._guardLastTime = current;
                            }
                        }
                    }

                    if (video.ended && this._isPlaying) {
                        this._note('%c检测到视频结束，准备切换下一个...', 'color:#9C27B0');
                        this._isPlaying = false;
                        this._scheduleNextUnit();
                    }
                } catch (e) {
                    log.error('视频状态检查失败:', e);
                }
            },
            _tryTimes: 0,
            _stepAdvanceTimes: 0,
            _stepSwitchAt: 0,
            _stepSwitchPending: false,
            _stepNavigationBound: false,
            _pageGuards: null,
            _delayedNextUnitTimer: null,
            _idleTimer: null,
            _resumeGuardTimer: null,
            _nextUnitTimer: null,
            _guardLastTime: 0,
            _guardLastWallTs: 0,
            _guardLastResumeTs: 0,
            async play() {
                if (this._destroyed) return;
                try {
                    /* .prev_title 在旧布局里是步骤名("视频"/"章节测验"), 但实测 mooc2
                     * 布局里它是小节标题, 靠它判断会全部落空。先看卡片里的任务点。 */
                    const jobs = this._readJobs();
                    if (jobs === undefined) {
                        throw new Error('卡片还没加载到当前小节');
                    }
                    const pendingVideo = jobs ? jobs.some((job) => job.kind === 'video' && !job.finished) : false;
                    /* 视频不是任务点(卡片上没有 .ans-job-icon, 实测 mArg 里也没有 job 字段)
                     * 时 jobs 是空数组, 同样不播: 不计入完成度的视频按约定跳过 */
                    if (jobs && !pendingVideo) {
                        this._handleNoPendingVideo(jobs);
                        return;
                    }

                    const el = this._getVideoEl();
                    /* 对已经播完的视频调 play() 会从头重播——已完成的任务点不该再放一遍 */
                    if (el != null && (el.ended || this._videoJobFinished(el) === true)) {
                        this._note('%c本节视频任务点已经完成, 不再重放', 'color:#607D8B');
                        this._handleNoPendingVideo(jobs);
                        return;
                    }
                    if (el == null) {
                        if (pendingVideo || this._currentStepTitle() === '视频') {
                            throw new Error('视频组件尚未加载完成');
                        }
                        if (this._advanceLearningStep()) {
                            this._note('%c当前不在视频页，已尝试切到下一学习步骤，稍后重试', 'color:#607D8B');
                            this._delay(() => {
                                this.play();
                            }, [1800, 3400]);
                            return;
                        }
                        if (this._isChapterTest()) {
                            this._advanceChapterTest();
                            return;
                        }
                        this._isPlaying = false;
                        this._clearCheckInterval();
                        if (this.configs.autoAdvanceNoVideo) {
                            log.warn('%c当前小节未发现视频，按配置切换到下一小节', 'color:#FF9800');
                            this.nextUnit();
                        } else {
                            log.warn('%c当前小节未发现视频或可识别的学习步骤，已安全停止。确认无需完成课件后，可执行 nextUnit()。', 'color:#FF9800');
                        }
                        return;
                    }

                    this._isPlaying = true;
                    this._videoEventHandle();
                    /* 必须在 play() 之前, 否则会先外放一两秒 */
                    this._muteIfNeeded(el);
                    const rate = this._applyPlaybackRate(el);

                    try {
                        await el.play();
                        if (this._destroyed) return;
                        this._tryTimes = 0;
                        this._note(`%c视频开始播放，倍速: ${rate}x`, 'color:#4CAF50');
                        this._startVideoMonitoring();
                        this._startIdleActivity();
                    } catch (playError) {
                        if (this._destroyed) return;
                        log.error('视频播放失败:', playError);
                        this._handlePlayError(playError);
                    }
                } catch (e) {
                    if (this._destroyed) return;
                    if (this._tryTimes >= this.configs.maxRetries) {
                        log.error('%c视频播放失败，已达到最大重试次数', 'color:#F44336;font-weight:bold', e);
                        this._clearCheckInterval();
                        return;
                    }
                    this._tryTimes++;
                    const retryIn = this._ms(this.configs.retryInterval);
                    this._note(`%c播放失败，${(retryIn / 1000).toFixed(1)}秒后重试 (${this._tryTimes}/${this.configs.maxRetries})`, 'color:#FF9800');
                    this._later(() => {
                        this.play();
                    }, retryIn);
                }
            },
            _advanceLearningStep() {
                if (this._stepSwitchPending && Date.now() - this._stepSwitchAt < 4000) {
                    return true;
                }

                const currentStepTitle = this._currentStepTitle();

                if (currentStepTitle === "章节测验" || currentStepTitle === "视频") {
                    return false;
                }

                const clickElement = (el, label) => {
                    if (!el) return false;
                    this._stepSwitchPending = true;
                    this._stepSwitchAt = Date.now();
                    this._note(`%c尝试点击${label}`, 'color:#2196F3');
                    dom.dispatchClick(el);
                    return true;
                };

                const videoTab = dom.select(".prev_white:visible").filter((_, el) => {
                    const text = (el.textContent || "").replace(/\s+/g, "");
                    return text === "2视频" || text === "视频";
                }).get(0);
                if (clickElement(videoTab, "“视频”页签")) {
                    return true;
                }

                return false;
            },
            _currentStepTitle() {
                const prevTitle = document.getElementsByClassName('prev_title')[0];
                return prevTitle ? (prevTitle.title || prevTitle.textContent || '').trim() : '';
            },
            _isChapterTest() {
                return this._currentStepTitle() === '章节测验';
            },
            _advanceChapterTest() {
                if (this._chapterAdvanceTimes >= 3) {
                    log.error('%c章节测验页面连续跳转失败，已停止以避免页面循环。请手动处理后执行 run()。', 'color:#F44336;font-weight:bold');
                    return;
                }

                const nextButton = dom.select('#prevNextFocusNext:visible, #right1:visible, .nextChapter:visible').first().get(0);
                if (!nextButton) {
                    log.warn('%c未找到章节测验的下一步按钮，已停止。', 'color:#FF9800');
                    return;
                }

                this._chapterAdvanceTimes++;
                this._note('%c检测到章节测验，尝试进入下一学习步骤', 'color:#607D8B');
                /* 测验页上先“看一眼”再点下一步，不要在渲染完成的同一刻就跳走 */
                this._delay(() => {
                    dom.dispatchClick(nextButton);
                    this._delay(() => this.play(), [1900, 3200]);
                }, [1400, 4200]);
            },
            _bindStepNavigation() {
                if (this._stepNavigationBound) {
                    return;
                }
                this._stepNavigationBound = true;

                const reenterVideoMode = () => {
                    this._videoEl = null;
                    this._isPlaying = false;
                    this._stepSwitchPending = true;
                    this._stepSwitchAt = Date.now();
                    this._delay(() => {
                        try {
                            this._initCellData();
                        } catch (e) {
                            log.warn('重新读取课程目录失败:', e);
                        }
                        this.play();
                    }, [1500, 2800]);
                };

                dom.on(document, 'click', '.prev_white', (matched) => {
                    const text = (matched.textContent || "").replace(/\s+/g, "");
                    if (text.includes("视频")) {
                        this._note(`%c检测到步骤切换点击：${text}，准备重新接管视频页`, 'color:#607D8B');
                        reenterVideoMode();
                    }
                });
            },
            _handlePlayError(error) {
                this._trace('播放错误详情:', error);
                const video = this._getVideoEl();
                if (video) {
                    video.muted = true;
                    video.play().then(() => {
                        if (this._destroyed) return;
                        this._note('%c静音播放成功', 'color:#4CAF50');
                        this._tryTimes = 0;
                        this._startVideoMonitoring();
                        this._startIdleActivity();
                        this._scheduleUnmute();
                        this._cancel(this._delayedNextUnitTimer);
                        this._delayedNextUnitTimer = null;
                    }).catch(e => {
                        if (this._destroyed) return;
                        log.error('静音播放也失败:', e);
                        this._cancel(this._delayedNextUnitTimer);
                        this._delayedNextUnitTimer = null;
                        this._isPlaying = false;
                        if (this._tryTimes >= this.configs.maxRetries) {
                            log.error('%c静音播放失败，已达到最大重试次数', 'color:#F44336;font-weight:bold', e);
                            return;
                        }
                        this._tryTimes++;
                        this._delayedNextUnitTimer = this._delay(() => {
                            this._delayedNextUnitTimer = null;
                            this.play();
                        }, this.configs.retryInterval);
                    });
                }
            },
            playCurrentIndex(nCell) {
                this._nextUnitPending = false;
                if (this._destroyed) return;
                if (!nCell) {
                    const el = this._getTreeContainer();
                    const cells = el.children("ul").children("li");
                    const nCells = dom.select(cells.get(this._cellData.currentCellIndex)).find('.posCatalog_select:not(.firstLayer)');
                    nCell = nCells.get(this._cellData.currentNCellIndex);
                }

                const clickableSpan = dom.select(nCell).find(".posCatalog_name").get(0);
                if (!clickableSpan) {
                    log.error('%c找不到可点击的课程节点，切换下一个视频失败', 'color:#F44336');
                    return;
                }

                this._say('%c切换到: %s', 'color:#2196F3', clickableSpan.getAttribute('title') || '未知标题');
                dom.dispatchClick(clickableSpan);
                this._videoEl = null;
                this._isPlaying = false;

                this._note('%c等待视频加载...', 'color:#FF9800');
                this._delay(() => {
                    this._initCellData();
                    if (this.configs.autoplay) {
                        this.play();
                    }
                }, [2600, 4800]);
            },
            _initCellData() {
                const el = this._getTreeContainer();
                const cells = el.children("ul").children("li");
                this._cellData.cells = cells.length;
                let nCellCounts = 0;
                let foundCurrent = false;

                cells.each((i, v) => {
                    const nCells = dom.select(v).find('.posCatalog_select:not(.firstLayer)');
                    nCellCounts += nCells.length;
                    nCells.each((j, e) => {
                        const _el = dom.select(e);
                        if (_el.hasClass("posCatalog_active")) {
                            this._cellData.currentCellIndex = i;
                            this._cellData.currentNCellIndex = j;
                            foundCurrent = true;
                            const titleSpan = _el.find('.posCatalog_name').get(0);
                            if (titleSpan) {
                                this._cellData.currentVideoTitle = titleSpan.getAttribute('title') || '';
                            }
                        }
                    });
                });

                this._cellData.nCells = nCellCounts;

                if (!foundCurrent && nCellCounts > 0) {
                    log.warn('%c未找到当前激活的视频节点，可能需要手动选择', 'color:#FF9800');
                }

                this._note(`%c课程信息: ${this._cellData.cells}章, ${this._cellData.nCells}节, 当前: 第${this._cellData.currentCellIndex + 1}章第${this._cellData.currentNCellIndex + 1}节`, 'color:#607D8B');
            },
            _getTreeContainer() {
                if (!this._treeContainerEl) {
                    const el = dom.select('#coursetree');
                    if (el.length <= 0) {
                        throw new Error("找不到视频列表");
                    }
                    this._treeContainerEl = el;
                }
                return this._treeContainerEl;
            },
            /* 跨域 iframe 无法读取是同源策略的正常结果，不是脚本错误。
             * 旧版只在最外层包了一个 try/catch：遇到第一个跨域 iframe 就整体中断搜索，
             * 并且每秒往控制台抛一次异常。这里改成逐帧判定、静默跳过。 */
            _frameDocument(frame) {
                try {
                    const doc = frame.contentDocument || (frame.contentWindow ? frame.contentWindow.document : null);
                    if (!doc) return null;
                    void doc.nodeType;
                    return doc;
                } catch (e) {
                    return null;
                }
            },
            /* 读当前小节卡片里的任务点(实测 mooc2 布局):
             *   .ans-attach-ct.videoContainer[.ans-job-finished] > iframe /ananas/modules/video/
             *   .ans-attach-ct[.ans-job-finished]                > iframe /ananas/modules/work/
             * 目录上的"1个待完成任务点"可能是章节测验而不是视频, 只有看这里才知道
             * 视频要不要放。找不到卡片文档(旧布局)时返回 null。 */
            _readJobs() {
                /* 切节之后卡片文档可能还是上一节的。目录激活项的 id 是 cur{知识点id},
                 * 卡片文档的地址带 knowledgeid={知识点id}(实测), 对不上就返回 undefined
                 * 表示"还没加载过来", 由调用方稍后重试——读了旧内容会拿上一节的
                 * "视频已完成"把这一节没看的视频跳过去。 */
                const active = document.querySelector('.posCatalog_active');
                const activeId = active && active.id ? active.id.replace(/^cur/, '') : '';
                let stale = false;
                for (const frame of dom.select('iframe').toArray()) {
                    const doc = this._frameDocument(frame);
                    if (!doc || typeof doc.querySelectorAll !== 'function') continue;
                    const containers = Array.from(doc.querySelectorAll('.ans-attach-ct'));
                    if (!containers.length) continue;
                    if (activeId) {
                        let knowledgeId = null;
                        try {
                            knowledgeId = new URL(doc.location.href).searchParams.get('knowledgeid');
                        } catch (e) {
                            knowledgeId = null;
                        }
                        if (knowledgeId && knowledgeId !== activeId) {
                            stale = true;
                            continue;
                        }
                    }
                    return containers
                        .filter((ct) => ct.querySelector('.ans-job-icon'))
                        .map((ct) => {
                            const inner = ct.querySelector('iframe');
                            const src = inner ? (inner.getAttribute('src') || '') : '';
                            const kind = /modules\/video/.test(src) ? 'video' : (/modules\/work/.test(src) ? 'work' : 'other');
                            return { kind, finished: ct.classList.contains('ans-job-finished') };
                        });
                }
                return stale ? undefined : null;
            },
            /* 这个 video 所在的任务点是否已完成(看外层 .ans-attach-ct) */
            _videoJobFinished(video) {
                try {
                    const frameEl = video.ownerDocument.defaultView.frameElement;
                    const ct = frameEl && typeof frameEl.closest === 'function' ? frameEl.closest('.ans-attach-ct') : null;
                    return ct ? ct.classList.contains('ans-job-finished') : null;
                } catch (e) {
                    return null;
                }
            },
            /* 本节没有待播的视频: 视频要么没有、要么已完成、要么不是任务点 */
            _handleNoPendingVideo(jobs) {
                this._isPlaying = false;
                this._clearCheckInterval();
                const pendingOther = jobs ? jobs.filter((job) => job.kind !== 'video' && !job.finished).length : 0;
                const rest = pendingOther
                    ? `还剩 ${pendingOther} 个非视频任务点(章节测验等)需要你自己完成`
                    : (jobs && !jobs.length ? '本节没有任务点' : '本节任务点已全部完成');
                if (this.configs.autoAdvanceNoVideo || !pendingOther) {
                    this._say(`%c本节没有待播的视频, ${rest}, 切到下一节`, 'color:#607D8B');
                    this.nextUnit();
                    return;
                }
                log.warn(`%c本节没有待播的视频, ${rest}。已停下; 确认后可执行 configs.autoAdvanceNoVideo = true 再 run()。`, 'color:#FF9800');
            },
            _getVideoEl() {
                if (this._videoEl) return this._videoEl;

                let blockedFrames = 0;
                const findVideo = (frame, depth) => {
                    if (depth > 2) return null;
                    const frameDocument = this._frameDocument(frame);
                    if (!frameDocument) {
                        blockedFrames++;
                        return null;
                    }
                    const $frameDocument = dom.select(frameDocument);
                    const directVideo = $frameDocument.find('video#video_html5_api, video[id*="video_html5"]').get(0);
                    if (directVideo) return directVideo;

                    const nestedFrames = $frameDocument.find('iframe.ans-insertvideo-online, iframe[src*="video"]');
                    for (const nestedFrame of nestedFrames.toArray()) {
                        const nestedVideo = findVideo(nestedFrame, depth + 1);
                        if (nestedVideo) return nestedVideo;
                    }
                    return null;
                };

                let finishedFallback = null;
                for (const frame of dom.select('iframe').toArray()) {
                    const video = findVideo(frame, 0);
                    if (!video) continue;
                    if (this._videoJobFinished(video) === true) {
                        finishedFallback = finishedFallback || video;
                        continue;
                    }
                    this._videoEl = video;
                    break;
                }
                if (!this._videoEl && finishedFallback) {
                    this._videoEl = finishedFallback;
                }

                if (!this._videoEl && blockedFrames > 0) {
                    this._trace(`%c已跳过 ${blockedFrames} 个跨域 iframe（同源策略限制，属正常现象）`, 'color:#9E9E9E');
                }
                return this._videoEl || null;
            },
            _videoEventHandle() {
                const el = this._videoEl;
                if (!el) {
                    this._trace('视频元素尚未加载');
                    return;
                }

                if (this._eventVideoEl === el) return;
                this._detachVideoEvents();
                this._eventVideoEl = el;
                this._boundVideoHandlers = {
                    ended: this._handleVideoEnded.bind(this),
                    loadedmetadata: this._handleVideoLoaded.bind(this),
                    play: this._handleVideoPlay.bind(this),
                    pause: this._handleVideoPause.bind(this),
                };

                el.addEventListener('ended', this._boundVideoHandlers.ended);
                el.addEventListener('loadedmetadata', this._boundVideoHandlers.loadedmetadata);
                el.addEventListener('play', this._boundVideoHandlers.play);
                el.addEventListener('pause', this._boundVideoHandlers.pause);
            },
            _detachVideoEvents() {
                if (!this._eventVideoEl || !this._boundVideoHandlers) return;
                this._eventVideoEl.removeEventListener('ended', this._boundVideoHandlers.ended);
                this._eventVideoEl.removeEventListener('loadedmetadata', this._boundVideoHandlers.loadedmetadata);
                this._eventVideoEl.removeEventListener('play', this._boundVideoHandlers.play);
                this._eventVideoEl.removeEventListener('pause', this._boundVideoHandlers.pause);
                this._eventVideoEl = null;
                this._boundVideoHandlers = null;
            },
            _handleVideoEnded(e) {
                this._say("%c'%s' 播放完成", 'color:#4CAF50;font-weight:bold', this._cellData.currentVideoTitle);
                this._isPlaying = false;
                this._clearCheckInterval();
                this._scheduleNextUnit();
            },
            _handleVideoLoaded(e) {
                this._note('%c视频加载完成', 'color:#2196F3');
                if (this.configs.autoplay && !this._isPlaying) {
                    this.play();
                }
            },
            _handleVideoPlay(e) {
                this._note("%c'%s' 开始播放", 'color:#4CAF50', this._cellData.currentVideoTitle);
                this._isPlaying = true;
                this._stepSwitchPending = false;
                const video = this._getVideoEl();
                this._guardLastTime = Number((video && video.currentTime) || 0);
                this._guardLastWallTs = Date.now();
                this._cancel(this._delayedNextUnitTimer);
                this._delayedNextUnitTimer = null;
            },
            _handleVideoPause(e) {
                this._trace('视频暂停');
            },
            _bindPageGuards() {
                if (this._pageGuards) return;
                const guards = {};

                /* 拦截 mouseout / mouseleave 现在默认关闭。
                 * 在捕获阶段对页面自己的事件调用 stopPropagation() 是个很反常的
                 * 行为：学习通的菜单与悬浮提示会跟着失效，而“指针移出窗口后视频
                 * 一次都不暂停”本身也是可被观察到的异常。需要时再打开。 */
                if (this.configs.blockWindowLeavePause) {
                    guards.preventWindowLeavePause = (event) => {
                        if (event.relatedTarget) return;
                        event.stopPropagation();
                    };
                    document.addEventListener('mouseout', guards.preventWindowLeavePause, true);
                    document.addEventListener('mouseleave', guards.preventWindowLeavePause, true);
                }

                /* 失焦或切回标签页后的恢复带一段随机延迟。页面在同一毫秒里先收到
                 * visibilitychange、紧接着看到视频被按回播放，是最好认的一处。 */
                guards.resumePlaybackSoon = () => {
                    if (this._destroyed) return;
                    this._cancel(this._resumeGuardTimer);
                    this._resumeGuardTimer = this._delay(() => {
                        this._resumeGuardTimer = null;
                        this._tryResumePlayback('page-event');
                    }, this.configs.backgroundResumeDelayMs);
                };

                this._pageGuards = guards;
                window.addEventListener('blur', guards.resumePlaybackSoon);
                document.addEventListener('visibilitychange', guards.resumePlaybackSoon);
            },
            _unbindPageGuards() {
                if (!this._pageGuards) return;
                const { preventWindowLeavePause, resumePlaybackSoon } = this._pageGuards;
                if (preventWindowLeavePause) {
                    document.removeEventListener('mouseout', preventWindowLeavePause, true);
                    document.removeEventListener('mouseleave', preventWindowLeavePause, true);
                }
                window.removeEventListener('blur', resumePlaybackSoon);
                document.removeEventListener('visibilitychange', resumePlaybackSoon);
                this._cancel(this._resumeGuardTimer);
                this._resumeGuardTimer = null;
                this._pageGuards = null;
            },
            /* 实例默认只挂在随机名下。确实需要 window.app（例如要沿用旧教程里的
             * 命令）时再手动开启，并且知道这会重新留下一个固定的全局名。 */
            expose(name) {
                const key = name || 'app';
                const existing = window[key];
                if (existing && existing !== this) {
                    log.warn(`window.${key} 已被占用，未覆盖。`);
                    return false;
                }
                try {
                    Object.defineProperty(window, key, {
                        value: this,
                        writable: true,
                        configurable: true,
                        enumerable: false,
                    });
                } catch (e) {
                    window[key] = this;
                }
                this._exposedKeys.push(key);
                return true;
            },
            _exposedKeys: [],
            destroy() {
                this._destroyed = true;
                this._isPlaying = false;
                this._clearCheckInterval();
                this._clearTimers();
                this._delayedNextUnitTimer = null;
                this._idleTimer = null;
                this._resumeGuardTimer = null;
                this._nextUnitTimer = null;
                this._detachVideoEvents();
                this._stepNavigationBound = false;
                dom.offAll();
                this._unbindPageGuards();
                /* 主动暴露过的全局名在停止时一并撤掉，不留痕 */
                while (this._exposedKeys.length > 0) {
                    const key = this._exposedKeys.pop();
                    try {
                        if (window[key] === this) delete window[key];
                    } catch (e) {
                        /* 忽略 */
                    }
                }
                if (runtime.app === this) {
                    runtime.app = null;
                }
            },
        };

        runtime.app = app;

        try {
            app.run();
            app._bindPageGuards();
            /* 旧版把实例固定挂在 window.app 上，那是这个脚本最好查的指纹：
             * 页面读一次 window.app 就知道有外部脚本在跑。现在只挂在本次运行
             * 随机生成的、不可枚举的名字下，用下面提示的名字调用即可。 */
            app._say(
                `%c控制台句柄 window.${RUNTIME_KEY}.app，例如 window.${RUNTIME_KEY}.app.nextUnit()；想沿用 window.app 就执行 window.${RUNTIME_KEY}.app.expose()。`,
                'color:#607D8B'
            );
        } catch (error) {
            log.error('%c脚本运行失败: ', 'color:#F44336;font-weight:bold', error.message);
            log.error('请检查是否在正确的课程播放页面，或者页面结构是否再次发生改变。');
        }
    }
})();
