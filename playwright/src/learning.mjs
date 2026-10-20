/* ------------------------------------------------------------------
 * 学习流程
 *
 * 分工：
 *   - 凡是“操作”（点目录、展开知识点、点播放、滚动）都走真实输入，由 pointer 完成
 *   - 凡是“读取”（目录、播放进度）都用 evaluate 只读 DOM，不派发任何事件
 *
 * 观看记录由平台自己的播放器上报。这里不调用任何接口，只做人会做的事：
 * 点开一项、放完、换下一项。
 * ------------------------------------------------------------------ */
import { SEL, KIND } from './selectors.mjs';
import { human, sleep, sleepFor } from './human.mjs';
import { bar, clip, formatDuration, formatTime } from './display.mjs';

/* 目录按页面顺序读成一串条目：学习项，以及折叠着的知识点节点。
 *
 * 实测折叠节点下的学习项根本不渲染（一门课 111 项里有 24 个视频藏在折叠节点下），
 * 所以“下一项”可能是一个要先展开的节点。key 用类型 + 标题 + 同名序号，展开节点
 * 会在中间插入新条目，按位置算的下标会变，key 不会。 */
export function keyEntries(entries) {
    const seen = new Map();
    return entries.map((entry) => {
        const base = entry.type === 'node' ? `node|${entry.title}` : `${entry.kind}|${entry.title}`;
        const n = seen.get(base) || 0;
        seen.set(base, n + 1);
        return { ...entry, key: `${base}|${n}` };
    });
}

/* 从当前项往后找下一件要做的事：第一个没完成的视频（开着图文时也包括图文），
 * 或者第一个还没展开过的折叠节点。后面都没有了就从头找一遍——用户可能是从
 * 中间某一项开始的。这一轮里开过的项、展开过的节点不再碰，避免在一个怎么也
 * 完成不了的项上来回打转。 */
export function pickNext(entries, { articles = true, attempted = new Set(), expanded = new Set() } = {}) {
    const at = entries.findIndex((entry) => entry.type === 'leaf' && entry.active);
    const wanted = (entry) => {
        if (entry.type === 'node') return !expanded.has(entry.key);
        if (entry.active || entry.done || attempted.has(entry.key)) return false;
        return entry.kind === KIND.video || (articles && entry.kind === KIND.article);
    };
    const after = entries.slice(at + 1).find(wanted);
    if (after) return { target: after, wrapped: false };
    const before = entries.slice(0, Math.max(0, at)).find(wanted);
    return { target: before || null, wrapped: Boolean(before) };
}

export class LearningRunner {
    constructor({ page, pointer, config, log }) {
        this.page = page;
        this.pointer = pointer;
        this.config = config;
        this.log = log;
        this.stopped = false;
        this.itemsDone = 0;
        this.attempted = new Set();
        this.expanded = new Set();
        this.lostTries = 0;
        this.justOpened = null;
        this.startedAt = Date.now();
        this.currentTitle = '';
        this.lastDriftAt = Date.now();
        this.nextDriftAt = null;
    }

    stop(reason) {
        if (this.stopped) return;
        this.stopped = true;
        this.log.say(`停止：${reason}`);
    }

    /* ---------------- 读取 ---------------- */

    async readCatalog() {
        const raw = await this.page.evaluate((sel) => {
            const list = document.querySelector(sel.navList);
            if (!list) return null;
            const text = (el) => (el ? el.textContent : '').trim();
            const entries = [];
            let leafIndex = 0;
            let iconIndex = 0;
            for (const el of list.querySelectorAll('.leaf-item, .expand-icon')) {
                if (el.classList.contains('leaf-item')) {
                    entries.push({
                        type: 'leaf',
                        index: leafIndex,
                        kind: text(el.querySelector(sel.leafTag)),
                        title: text(el.querySelector(sel.leafTitle)),
                        done: Boolean(el.querySelector(sel.leafDone)),
                        active: el.classList.contains('is-active'),
                    });
                    leafIndex += 1;
                    continue;
                }
                const index = iconIndex;
                iconIndex += 1;
                if (el.classList.contains('is-expanded')) continue;
                const node = el.closest('.nav-item-node');
                entries.push({ type: 'node', index, title: text(node && node.querySelector('.nav-item-title')) });
            }
            return entries;
        }, SEL).catch((e) => {
            this.log.trace('读目录失败:', e.message.split('\n')[0]);
            return null;
        });
        return raw && raw.length ? keyEntries(raw) : null;
    }

    /* 实测: 视频完成后平台刷新进度会重新渲染目录, 有一小段时间读不到。
     * 读不到就等一会儿再读, 不要一次失败就停。 */
    async readCatalogSettled(waitMs = 10000) {
        const deadline = Date.now() + waitMs;
        for (;;) {
            const entries = await this.readCatalog();
            if (entries || this.stopped || Date.now() >= deadline) return entries;
            await sleepFor([400, 900]);
        }
    }

    async videoState() {
        try {
            return await this.page.locator(SEL.video).first().evaluate((el) => ({
                currentTime: Number(el.currentTime) || 0,
                duration: Number.isFinite(el.duration) ? el.duration : 0,
                paused: el.paused,
                ended: el.ended,
                muted: el.muted,
                volume: el.volume,
                /* 两套播放器的静音方式不同：一套设 muted，另一套把 volume 归零 */
                silent: el.muted || el.volume === 0,
                readyState: el.readyState,
                seeking: el.seeking,
                rate: el.playbackRate,
            }), undefined, { timeout: 3000 });
        } catch (e) {
            return null;
        }
    }

    /* 页面上可见的弹窗文字。视频被暂停又恢复不了时用来说明原因 */
    async visibleDialogText() {
        return this.page.evaluate((selector) => {
            const shown = Array.from(document.querySelectorAll(selector)).filter((el) => {
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            });
            return shown.map((el) => el.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ').slice(0, 200);
        }, SEL.dialog).catch(() => '');
    }

    /* ---------------- 主循环 ---------------- */

    /* 刚接管页面时先真实地动一下：移动指针、小幅滚一下再滚回来。
     *
     * 两个理由：
     * 1. 人打开一个页面本来就会先动一动、滚一下看看，不会盯着不动好几秒。
     * 2. 本地靶场实测：被调试端口接管的浏览器里（Playwright 自己启动和接管已有
     *    Chrome 都一样），navigator.userActivation.hasBeenActive 会在页面加载约
     *    1.5 秒后自行变成 true，而普通 Chrome 要等真实交互。于是出现一个自相
     *    矛盾的状态——「浏览器说用户激活过，页面却一个可信输入事件都没收到」。
     *    以前的启动延迟反而让这个状态一直挂着：越是加「像人的延迟」，窗口开得越久。
     *    先做一次真实输入就把它合上了。
     *
     * 用滚轮而不是点击：滚轮同样是可信输入，但不会触发页面上任何东西。 */
    async settleIn() {
        try {
            /* 接管之后先有个反应时间，不要在同一毫秒就动 */
            await sleepFor([250, 900]);
            const size = this.page.viewportSize() || await this.page.evaluate(
                () => ({ width: window.innerWidth, height: window.innerHeight }),
            );
            await this.pointer.moveTo({
                x: size.width * human.float(0.3, 0.7),
                y: size.height * human.float(0.3, 0.6),
            });
            const delta = human.int(90, 260);
            await this.page.mouse.wheel(0, delta);
            await sleepFor([400, 1200]);
            /* 滚回原处，不改变页面位置 */
            await this.page.mouse.wheel(0, -delta);
            this.log.trace('已做一次真实滚动');
        } catch (e) {
            this.log.trace('开场滚动失败，跳过:', e.message.split('\n')[0]);
        }
    }

    async run() {
        await this.settleIn();
        await sleepFor(this.config.startupDelayMs);
        await this.page.waitForSelector(SEL.leaf, { timeout: this.config.catalogTimeoutMs });
        const entries = await this.readCatalog();
        const leaves = entries.filter((entry) => entry.type === 'leaf');
        const count = (kind) => leaves.filter((entry) => entry.kind === kind);
        const summary = [KIND.video, KIND.article, KIND.classroom]
            .map((kind) => `${kind} ${count(kind).filter((entry) => entry.done).length}/${count(kind).length}`)
            .join('，');
        const current = leaves.find((entry) => entry.active);
        const folded = entries.filter((entry) => entry.type === 'node').length;
        this.log.say(`目录：${summary}（已完成/总数）${folded ? `，另有 ${folded} 个折叠的知识点` : ''}`);
        this.currentTitle = current ? current.title : '';
        this.log.say(`当前：${current ? `${current.kind}「${current.title}」` : '未定位'}`);
        this.log.say('开始了。可以把浏览器窗口放到后面去，但别最小化。按 Ctrl+C 停止。');

        while (!this.stopped) {
            const now = (await this.readCatalogSettled() || []).find((entry) => entry.type === 'leaf' && entry.active);
            if (now) {
                this.attempted.add(now.key);
                const wanted = now.kind === KIND.video || (this.config.articles && now.kind === KIND.article);
                /* 刚点开的这一项以选中它时的状态为准: 图文可能一打开就被记成完成,
                 * 照目录上的勾判断会点开就走, 停留两三秒——人不会这样看东西。 */
                const fresh = now.key === this.justOpened;
                this.justOpened = null;
                if ((!now.done || fresh) && wanted) {
                    const result = now.kind === KIND.video ? await this.studyVideo() : await this.readArticle();
                    if (result === 'stopped' || this.stopped) return;
                    if (result === 'lost') {
                        /* 视频元素没了(页面还在)不等于放完: 回到开头重新判断。
                         * 连续两次这样就停下, 不原地打转。 */
                        this.lostTries += 1;
                        if (this.lostTries >= 2) {
                            this.log.warn('视频连续两次在播放中消失，已停下，请看一眼浏览器');
                            return;
                        }
                        this.attempted.delete(now.key);
                        continue;
                    }
                    this.lostTries = 0;
                    this.itemsDone += 1;
                    await this.reportItem(now);
                    if (this.config.maxItems > 0 && this.itemsDone >= this.config.maxItems) {
                        this.log.say(`已学完 ${this.itemsDone} 项，达到 --max-items 上限`);
                        return;
                    }
                    await this.itemPause();
                    if (this.stopped) return;
                } else {
                    const why = now.done ? '已经完成' : `是${now.kind || '未知类型'}，不在学习范围内`;
                    this.log.note(`当前项「${now.title}」${why}，不再重复`);
                }
            }
            if (!await this.advance()) return;
        }
    }

    /* 学完之后看一眼目录上的勾。平台可能晚几秒才更新，只记日志，不据此重来 */
    async reportItem(item) {
        await sleepFor([1500, 3500]);
        const after = (await this.readCatalogSettled() || []).find((entry) => entry.key === item.key);
        const rate = await this.page.locator(SEL.unitRate).first().textContent({ timeout: 2000 }).catch(() => '');
        if (after && after.done) {
            this.log.say(`「${item.title}」已完成`);
        } else {
            this.log.say(`「${item.title}」学完了，目录上暂时还没打勾${rate ? `（${rate.trim()}）` : ''}`);
        }
    }

    async itemPause() {
        let wait = human.ms(this.config.itemPauseMs);
        if (human.chance(this.config.longBreakChance)) {
            wait = human.ms(this.config.longBreakMs);
            this.log.say(`这一项结束，离开 ${Math.round(wait / 1000)} 秒再继续`);
        } else {
            this.log.note(`这一项结束，${(wait / 1000).toFixed(1)} 秒后切换`);
        }
        const until = Date.now() + wait;
        while (!this.stopped && Date.now() < until) {
            const left = Math.ceil((until - Date.now()) / 1000);
            this.log.status(`⏸ 这一项结束，${left} 秒后换下一项 · 本次已学完 ${this.itemsDone} 项`);
            await sleep(Math.min(1000, until - Date.now()));
        }
        this.log.clearStatus();
    }

    /* ---------------- 换下一项 ---------------- */

    async advance() {
        /* 每展开一个节点就重新读一次目录；上限防止目录结构异常时一直展开下去 */
        for (let round = 0; round < 80 && !this.stopped; round += 1) {
            const entries = await this.readCatalogSettled();
            if (!entries) {
                this.log.warn('读不到目录了，已停下');
                return false;
            }
            const { target, wrapped } = pickNext(entries, {
                articles: this.config.articles,
                attempted: this.attempted,
                expanded: this.expanded,
            });
            if (!target) {
                this.log.say('目录里没有还没完成的视频' + (this.config.articles ? '和图文' : '') + '了');
                return false;
            }
            if (target.type === 'node') {
                await this.expandNode(target);
                continue;
            }
            if (wrapped) this.log.say('后面都学完了，回到前面还没完成的');
            return this.openItem(target);
        }
        return false;
    }

    async expandNode(target) {
        /* 不管成没成功都记下, 同一个节点这一轮不再点第二次 */
        this.expanded.add(target.key);
        this.log.note(`展开知识点「${target.title}」`);
        const icon = this.page.locator(SEL.expandIcon).nth(target.index);
        try {
            await this.pointer.click(icon, { scrollAnchor: this.page.locator(SEL.navList) });
        } catch (e) {
            this.log.warn(`展开「${target.title}」失败: ${e.message.split('\n')[0]}`);
            return false;
        }
        await sleepFor(this.config.expandWaitMs);
        const open = await icon.evaluate((el) => el.classList.contains('is-expanded')).catch(() => false);
        if (!open) this.log.note(`「${target.title}」点了没有展开`);
        return open;
    }

    async activeTitle() {
        return this.page.evaluate(() => {
            const el = document.querySelector('.leaf-item.is-active .leaf-item-title');
            return el ? el.textContent.trim() : '';
        }).catch(() => '');
    }

    async openItem(target) {
        this.currentTitle = target.title;
        this.log.say(`切换到：${target.kind}「${target.title}」`);
        const locator = this.page.locator(SEL.leaf).nth(target.index);
        const fromUrl = this.page.url();
        /* 以当前项标题变成目标为准。只有前后两项同名时才额外要求地址变化——
         * 切换时地址会不会变，还没在真实页面上确认过，不拿它当主要依据。 */
        const sameTitle = await this.activeTitle() === target.title;
        let moved = false;
        for (let attempt = 1; attempt <= 2 && !moved && !this.stopped; attempt += 1) {
            try {
                await this.pointer.click(locator, { scrollAnchor: this.page.locator(SEL.navList) });
            } catch (e) {
                this.log.warn(`点目录里的「${target.title}」失败: ${e.message.split('\n')[0]}`);
            }
            const deadline = Date.now() + this.config.itemSwitchWaitMs;
            while (!moved && Date.now() < deadline && !this.stopped) {
                await sleep(human.int(250, 500));
                moved = await this.activeTitle() === target.title && (!sameTitle || this.page.url() !== fromUrl);
            }
            if (!moved && attempt === 1) this.log.warn('点完目录没有切过去，再试一次');
        }
        if (!moved) {
            this.log.error(`点了「${target.title}」但页面没有切过去，已停下。可能是平台弹了提示框，请看一眼浏览器。`);
            this.stop('切换失败');
            return false;
        }
        await sleepFor(this.config.itemLoadMs);
        this.justOpened = target.key;
        return true;
    }

    /* ---------------- 视频 ---------------- */

    /* 等当前项的播放器装好: 有时长, 并且标题栏已经换成当前项(切换时旧播放器会短暂留着) */
    async waitForVideo(waitMs) {
        const deadline = Date.now() + waitMs;
        while (!this.stopped) {
            const ready = await this.page.evaluate((sel) => {
                const video = document.querySelector(sel.video);
                const unit = document.querySelector(sel.unitTitle);
                const active = document.querySelector('.leaf-item.is-active .leaf-item-title');
                return Boolean(video && video.readyState > 0 && video.duration > 0
                    && unit && active && unit.textContent.trim() === active.textContent.trim());
            }, SEL).catch(() => false);
            if (ready) return true;
            if (Date.now() >= deadline) return false;
            await sleepFor([300, 700]);
        }
        return false;
    }

    /* 起播前静音，必须在任何一次起播点击之前做，否则会先外放一两秒。
     *
     * 两套播放器要用不同的办法：
     *   数字人播放器   设 el.muted = true 就行，页面只收到一个普通的 volumechange
     *   xtplayer      它有看门狗，会在一两秒内把 muted 改回 false（实测），
     *                 只能点它自己的音量按钮——点一下 volume 归零，而且保持得住
     * 所以先试便宜的那种，被撤销了再去点控件。 */
    async ensureMuted() {
        if (!this.config.mute) return;
        const state = await this.videoState();
        if (state && state.silent) return;

        await this.page.locator(SEL.video).first()
            .evaluate((el) => { el.muted = true; }, undefined, { timeout: 3000 })
            .catch(() => {});
        await sleepFor([900, 1600]);
        if ((await this.videoState() || {}).silent) {
            this.log.note('已静音');
            return;
        }

        /* 被播放器改回去了：点它自己的音量按钮 */
        try {
            await this.revealControls();
            await this.pointer.click(this.page.locator(SEL.volumeButton).first(), { timeoutMs: 4000 });
            await sleepFor([400, 900]);
        } catch (e) {
            this.log.trace(`点音量按钮没成功: ${e.message.split('\n')[0]}`);
        }
        const after = await this.videoState();
        if (after && after.silent) {
            this.log.note('已静音（点的播放器音量键）');
        } else {
            this.log.warn('没能让播放器静音，声音可能会外放。启动 Chrome 时加 --mute-audio 可以兜底。');
        }
    }

    /* 控制栏平时 display:none, 指针进到播放器里才出来。
     *
     * 实测(学习通那边同样的播放器行为)：控制栏再出现时带一段动画，只等一个
     * 固定时长的话坐标可能读在动画中间，点下去就偏到隔壁控件上。所以等它
     * 真的有了稳定的尺寸再返回。 */
    async revealControls() {
        const box = await this.page.locator(SEL.player).first().boundingBox().catch(() => null);
        if (!box) return false;
        await this.pointer.moveTo({
            x: box.x + box.width * human.float(0.3, 0.7),
            y: box.y + box.height * human.float(0.55, 0.85),
        });
        const bar = this.page.locator(SEL.controlBox).first();
        let last = null;
        for (let i = 0; i < 12; i += 1) {
            await sleepFor([120, 260]);
            const now = await bar.boundingBox().catch(() => null);
            /* 连着两次读到同样的位置和高度，才算稳定下来 */
            if (now && now.height > 0 && last
                && Math.abs(now.y - last.y) < 1 && Math.abs(now.height - last.height) < 1) {
                return true;
            }
            last = now;
        }
        return Boolean(last && last.height > 0);
    }

    /* 读播放器倍速菜单里有哪些档位。没有这个控件就返回 null（平台不让改倍速） */
    async readRates() {
        const items = this.page.locator(SEL.rateMenuItem);
        if (await items.count() === 0) return null;
        return items.evaluateAll((nodes) => nodes
            .map((node, index) => ({ index, rate: parseFloat(node.textContent.trim()) }))
            .filter((item) => Number.isFinite(item.rate) && item.rate > 0));
    }

    /* 倍速切到播放器自己允许的最高档。
     *
     * 走播放器的菜单，不写 video.playbackRate：菜单里列出来的才是平台允许的档位，
     * 倍速标签也由播放器自己更新。没有这个控件就不动。
     * --playback-rate 1 等于维持原样；给具体数字则取不超过它的最高档。 */
    async applyPlaybackRate() {
        const wanted = this.config.playbackRate;
        if (wanted !== 'max' && !(Number(wanted) > 1)) return null;

        const current = await this.videoState();
        const rates = await this.readRates();
        if (!rates || !rates.length) {
            this.log.note('这个播放器没有倍速菜单，保持原速');
            return null;
        }
        const allowed = wanted === 'max' ? rates : rates.filter((item) => item.rate <= Number(wanted));
        if (!allowed.length) {
            this.log.note(`倍速菜单里没有不超过 ${wanted}x 的档位，保持原速`);
            return null;
        }
        const target = allowed.reduce((best, item) => (item.rate > best.rate ? item : best));
        if (current && Math.abs(current.rate - target.rate) < 0.01) {
            this.log.note(`倍速已经是 ${target.rate}x`);
            return target.rate;
        }

        /* 点偏了就再来一次：控制栏刚弹出来那一下坐标容易读早 */
        for (let attempt = 1; attempt <= 2 && !this.stopped; attempt += 1) {
            try {
                await this.revealControls();
                const item = this.page.locator(SEL.rateMenuItem).nth(target.index);
                /* 先把指针移到倍速按钮上：这类菜单多半悬停就展开，没展开再点一下 */
                const button = this.page.locator(SEL.rateButton).first();
                const box = await button.boundingBox();
                if (box) await this.pointer.moveTo({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
                await sleepFor([250, 700]);
                if (!await item.isVisible().catch(() => false)) {
                    await this.pointer.click(button, { timeoutMs: 4000 });
                    await sleepFor([250, 700]);
                }
                await this.pointer.click(item, { timeoutMs: 4000 });
                await sleepFor([300, 800]);
            } catch (e) {
                this.log.trace(`点倍速菜单第 ${attempt} 次没成功: ${e.message.split('\n')[0]}`);
            }

            /* 不管有没有抛错都按实际倍速判断：点偏到别的档位时也会抛超时，
             * 那时倍速其实已经变了，不能照着"没动过"去报。 */
            const after = await this.videoState();
            if (after && Math.abs(after.rate - target.rate) < 0.01) {
                this.log.say(`倍速切到 ${target.rate}x（菜单里最高的一档）`);
                return target.rate;
            }
            if (attempt < 2) continue;
            /* 平台可能锁了倍速。不去写 playbackRate 硬改——那等于绕过它自己的控件 */
            this.log.note(`倍速没能切到 ${target.rate}x（当前 ${after ? after.rate : '未知'}x），按这个速度播`);
            return after ? after.rate : null;
        }
        return null;
    }

    async startPlayback() {
        await this.ensureMuted();
        const atEnd = (state) => state && (state.ended || (state.duration > 0 && state.currentTime >= state.duration - 0.5));
        const before = await this.videoState();
        if (before && !before.paused && before.currentTime > 0) return true;
        if (atEnd(before)) return true;
        /* 判断起没起来看进度走没走，不能只看 paused */
        const started = (after) => after && (!after.paused || after.currentTime > (before ? before.currentTime : 0) + 0.05);

        const attempts = [
            ['大播放按钮', async () => this.page.locator(SEL.bigPlayButton).first()],
            ['控制栏播放键', async () => {
                await this.revealControls();
                return this.page.locator(SEL.playButton).first();
            }],
        ];
        for (const [name, target] of attempts) {
            try {
                const now = await this.videoState();
                if (started(now) || atEnd(now)) return true;
                const button = await target();
                if (await button.count() === 0 || !await button.isVisible()) continue;
                this.log.note(`点击${name}起播`);
                await this.pointer.click(button);
                await sleepFor([800, 1700]);
                if (started(await this.videoState())) return true;
            } catch (e) {
                this.log.trace(`点${name}没成功:`, e.message);
            }
        }

        const last = await this.videoState();
        if (started(last) || atEnd(last)) return true;
        if (this.config.allowScriptedPlay) {
            this.log.warn('真实点击未能起播，改用 video.play()（这一步是脚本调用，不是真实点击）');
            const ok = await this.page.locator(SEL.video).first()
                .evaluate((el) => el.play().then(() => true).catch(() => false), undefined, { timeout: 5000 })
                .catch(() => false);
            if (ok) return true;
        }
        return false;
    }

    async studyVideo() {
        if (!await this.waitForVideo(this.config.videoWaitMs)) {
            const dialog = await this.visibleDialogText();
            this.log.warn(`没等到视频加载出来${dialog ? `，页面上有弹窗：${dialog}` : ''}，已停下`);
            this.stop('视频没有加载');
            return 'stopped';
        }
        const first = await this.videoState();
        if (first && (first.ended || (first.duration > 0 && first.currentTime >= first.duration - 0.5))) {
            /* 放完的视频再点播放会从头重放 */
            this.log.note('视频已经在结尾，不重放');
            return 'ended';
        }
        if (!await this.startPlayback()) {
            this.log.warn('这一项起播失败，已停下');
            this.stop('起播失败');
            return 'stopped';
        }
        /* 倍速要等起播之后再调：起播前 .status-box 那层遮罩盖住整个播放器
         * (真实页面实测它和播放区一样大)，控制栏上的按钮点不到。 */
        await this.applyPlaybackRate();
        this.log.say(`开始播放（${formatTime(first ? first.currentTime : 0)} / ${formatTime(first ? first.duration : 0)}）`);
        return this.watchUntilEnd();
    }

    /* 轮询进度。间隔每轮重抽，不去踩整秒 */
    async watchUntilEnd() {
        let lastTime = -1;
        let lastProgressAt = Date.now();
        let lastResumeAt = 0;
        let failedResumes = 0;

        for (;;) {
            if (this.stopped) return 'stopped';
            await sleepFor(this.config.pollIntervalMs, 0.3);

            const state = await this.videoState();
            if (!state) {
                if (this.page.isClosed()) {
                    this.log.warn('学习空间页面被关闭了，已停下。这一项没有算作完成；重新打开后再运行即可。');
                    this.stop('页面已关闭');
                    return 'stopped';
                }
                this.log.warn('视频元素消失，回到当前项重新判断');
                return 'lost';
            }

            const nearEnd = state.duration > 0 && state.currentTime >= state.duration - 0.5;
            if (state.ended || nearEnd) {
                this.log.clearStatus();
                this.log.say(`✓ 看完「${this.currentTitle || '本项'}」（${formatTime(state.duration)}）`);
                return 'ended';
            }

            if (state.currentTime > lastTime + 0.01) {
                lastTime = state.currentTime;
                lastProgressAt = Date.now();
                failedResumes = 0;
                this.log.trace(`进度 ${formatTime(state.currentTime)} / ${formatTime(state.duration)}`);
            }
            this.showPlaying(state);

            const stalledMs = Date.now() - lastProgressAt;
            /* 实测: 切到一个 31 分钟的视频后, 播放器已处于播放状态, 但 CDN 迟迟不给数据
             * (readyState 1、seeking、缓冲区为空), 约 50 秒后自己好了。这时去“恢复”
             * 没有意义, 点那个播放/暂停二合一的按钮反而会把它暂停。人会等着。 */
            const buffering = !state.paused && (state.readyState < 3 || state.seeking);
            if (buffering) {
                if (stalledMs >= this.config.bufferingTimeoutMs) {
                    this.log.warn(`视频缓冲了 ${Math.round(stalledMs / 1000)} 秒还没动，已停下，请看一眼网络或浏览器`);
                    this.stop('缓冲超时');
                    return 'stopped';
                }
                this.log.trace(`缓冲中 ${Math.round(stalledMs / 1000)} 秒`);
                await this.maybeDrift();
                continue;
            }
            const needResume = state.paused || stalledMs >= human.ms(this.config.guardNoProgressMs, 0.25);
            if (needResume && Date.now() - lastResumeAt >= human.ms(this.config.resumeCooldownMs, 0.3)) {
                lastResumeAt = Date.now();
                const dialog = await this.visibleDialogText();
                if (dialog) {
                    /* 平台弹出来的东西(提示、题目)交给人处理, 不替人点 */
                    this.log.warn(`播放被弹窗打断：${dialog}。已停下，请看一眼浏览器。`);
                    this.stop('播放被弹窗打断');
                    return 'stopped';
                }
                if (await this.page.evaluate(() => document.hidden).catch(() => false) && !this.config.resumeWhileHidden) {
                    this.log.trace('页面在后台，按配置不去动播放状态');
                } else {
                    this.log.note(state.paused ? '视频被暂停，尝试恢复' : `进度停滞 ${Math.round(stalledMs / 1000)} 秒，尝试恢复`);
                    if (!await this.startPlayback()) failedResumes += 1;
                    lastProgressAt = Date.now();
                    if (failedResumes >= this.config.maxResumeTries) {
                        this.log.warn(`连续 ${failedResumes} 次没能恢复播放，已停下，请看一眼浏览器`);
                        this.stop('恢复播放失败');
                        return 'stopped';
                    }
                }
            }

            await this.maybeDrift();
        }
    }

    async maybeDrift() {
        if (!this.config.idleActivity) return;
        /* 下一次的时间点只在上一次之后抽一次。每轮轮询都重抽阈值的话, 等于在几十次
         * 抽签里取最先满足的那个, 学习通那边实测间隔全挤在 22–26 秒, 成了固定节拍。 */
        if (this.nextDriftAt === null) this.nextDriftAt = this.lastDriftAt + human.ms(this.config.idleActivityMs);
        if (Date.now() < this.nextDriftAt) return;
        this.lastDriftAt = Date.now();
        this.nextDriftAt = this.lastDriftAt + human.ms(this.config.idleActivityMs);
        try {
            await this.pointer.drift();
            this.log.trace('指针微动');
        } catch (e) {
            this.log.trace('指针微动失败:', e.message);
        }
    }

    /* ---------------- 图文 ---------------- */

    /* 停留一段时间, 期间用真实滚轮往下翻。实测页面一打开图文就自己记为已读
     * (内容是 Office Online 嵌入的课件), 停留只是为了不“点开就走”。 */
    async readArticle() {
        const total = human.ms(this.config.articleReadMs);
        this.log.say(`阅读图文，约 ${Math.round(total / 1000)} 秒`);
        const until = Date.now() + total;
        while (!this.stopped && Date.now() < until) {
            const left = Math.ceil((until - Date.now()) / 1000);
            this.log.status(`📖 ${clip(this.currentTitle || '图文')} · 还剩 ${left} 秒`);
            await sleep(Math.min(human.ms(this.config.articleScrollMs), Math.max(0, until - Date.now())));
            if (this.stopped || Date.now() >= until) break;
            const box = await this.page.locator('.detail-container').first().boundingBox().catch(() => null);
            if (!box) continue;
            await this.pointer.moveTo({
                x: box.x + box.width * human.float(0.25, 0.75),
                y: box.y + box.height * human.float(0.3, 0.7),
            });
            await this.page.mouse.wheel(0, human.int(140, 520));
        }
        this.log.clearStatus();
        return this.stopped ? 'stopped' : 'read';
    }

    /* 播放中的状态行：正在看什么、看到哪、本次已学完多少 */
    showPlaying(state) {
        const ratio = state.duration > 0 ? state.currentTime / state.duration : 0;
        const done = this.itemsDone ? ` · 本次已学完 ${this.itemsDone} 项` : '';
        this.log.status(
            `▶ ${clip(this.currentTitle || '视频')}  ${bar(ratio)} ${String(Math.round(ratio * 100)).padStart(3)}%`
            + `  ${formatTime(state.currentTime)}/${formatTime(state.duration)}${done}`,
        );
    }

    /* 收尾时说一句人话：这次跑了多久、学完几项 */
    reportRun(reason) {
        this.log.clearStatus();
        this.log.say(`—— ${reason}：本次学完 ${this.itemsDone} 项，用时 ${formatDuration(Date.now() - this.startedAt)} ——`);
    }
}
