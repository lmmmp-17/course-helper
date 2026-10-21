/* ------------------------------------------------------------------
 * 课程播放流程
 *
 * 分工：
 *   - 凡是“操作”（点目录、点页签、点播放、滚动）都走真实输入，由 pointer 完成
 *   - 凡是“读取”（目录结构、播放进度）都用 evaluate 只读 DOM，不派发任何事件
 *
 * 比浏览器内版本强的两点：
 *   1. 点击是浏览器自己构造的事件，isTrusted 为 true
 *   2. 跨域 iframe 里的视频也能直接读到——油猴版受同源策略限制，只能跳过
 * ------------------------------------------------------------------ */
import { SEL } from './selectors.mjs';
import { human, sleep, sleepFor } from './human.mjs';
import { bar, clip, formatDuration, formatTime } from './display.mjs';
import { keyHint } from './stop-signal.mjs';

/* 从当前小节往后找下一节要去的。
 *
 * 目录上有任务点标记时(mooc2)直接跳到下一个还有待完成任务点的小节: 不算任务点的
 * 视频不播, 已完成的也不重放, 一节节点过去只是在目录上连点几十下(实测一门课里
 * 1.3 到 8.1 之间 36 节全是 0 个任务点)。标记读不出来的小节当作"要进去看看"。
 * 整个目录都没有标记(旧布局)时按顺序取下一节。 */
export function pickNextSection(tree) {
    const flat = tree.chapters.flatMap((chapter) => chapter.sections);
    const at = flat.findIndex((section) => section.chapterIndex === tree.current.chapterIndex
        && section.sectionIndex === tree.current.sectionIndex);
    const rest = flat.slice(at + 1);
    const marked = flat.some((section) => section.pending !== null && section.pending !== undefined);
    if (!marked) return { target: rest[0] || null, skipped: 0, marked };
    const index = rest.findIndex((section) => section.pending === null || section.pending === undefined || section.pending > 0);
    return { target: index >= 0 ? rest[index] : null, skipped: index >= 0 ? index : rest.length, marked };
}

export class CourseRunner {
    constructor({ page, pointer, config, log }) {
        this.page = page;
        this.pointer = pointer;
        this.config = config;
        this.log = log;
        this.stopped = false;
        this.lastDriftAt = Date.now();
        this.nextDriftAt = null;
        this.chapterTestTries = 0;
        this.stepSwitchTries = 0;
        this.sectionsDone = 0;
        this.lostTries = 0;
        this.startedAt = Date.now();
        this.currentTitle = '';
    }

    stop(reason) {
        if (this.stopped) return;
        this.stopped = true;
        this.log.say(`停止：${reason}`);
    }

    async waitForTree() {
        /* 真人打开页面不会在同一毫秒开始操作 */
        await sleepFor(this.config.startupDelayMs);
        await this.page.waitForSelector(SEL.tree, { timeout: this.config.treeTimeoutMs });
        this.log.say('已找到课程目录');
    }

    /* 目录结构一次读出来，纯只读。pending 是目录上标的待完成任务点数，
     * 没有标记(旧布局)时为 null */
    async readTree() {
        return this.page.evaluate((sel) => {
            const pendingOf = (section) => {
                const unfinished = section.querySelector(sel.sectionUnfinished);
                if (unfinished) {
                    const count = parseInt(unfinished.value || unfinished.getAttribute('value'), 10);
                    if (Number.isFinite(count)) return count;
                }
                if (section.querySelector(sel.sectionCompleted)) return 0;
                const points = section.querySelector(sel.sectionPoints);
                if (points) {
                    const count = parseInt(points.textContent, 10);
                    if (Number.isFinite(count)) return count;
                }
                return null;
            };
            const chapters = Array.from(document.querySelectorAll(sel.chapter)).map((chapter, chapterIndex) => {
                const sections = Array.from(chapter.querySelectorAll(sel.section)).map((section, sectionIndex) => {
                    const name = section.querySelector(sel.sectionName);
                    return {
                        chapterIndex,
                        sectionIndex,
                        title: ((name && name.getAttribute('title')) || (name && name.textContent) || '').trim(),
                        active: section.classList.contains('posCatalog_active'),
                        pending: pendingOf(section),
                    };
                });
                return { chapterIndex, sections };
            });
            const flat = chapters.flatMap((chapter) => chapter.sections);
            return { chapters, current: flat.find((section) => section.active) || null, total: flat.length };
        }, SEL);
    }

    sectionLocator(position) {
        return this.page
            .locator(SEL.chapter)
            .nth(position.chapterIndex)
            .locator(SEL.section)
            .nth(position.sectionIndex)
            .locator(SEL.sectionName)
            .first();
    }

    async currentStepTitle() {
        return this.page.evaluate((selector) => {
            const el = document.querySelector(selector);
            if (!el) return '';
            return (el.getAttribute('title') || el.textContent || '').trim();
        }, SEL.stepTitle);
    }

    /* 遍历所有 frame 找视频。Playwright 能进跨域 frame，这里不需要像油猴版那样
     * 逐帧 try/catch 再放弃。 */
    async findVideo() {
        /* 切节时新旧 iframe 可能短暂并存，所以先挑“装好了的”那个：
         * readyState > 0 说明已经拿到媒体信息。都没装好就退回第一个候选，
         * 由调用方继续等。 */
        let fallback = null;
        for (const frame of this.page.frames()) {
            if (frame.isDetached()) continue;
            try {
                const locator = frame.locator(SEL.video).first();
                if (await locator.count() === 0) continue;
                const info = await locator.evaluate((el) => ({
                    media: el instanceof HTMLMediaElement,
                    readyState: el.readyState,
                })).catch(() => null);
                if (!info || !info.media) continue;
                const finished = await this.videoJobFinished(frame);
                /* 已完成任务点的视频只作兜底: 同一节里可能还有没放完的 */
                if (info.readyState > 0 && finished !== true) return { frame, locator, finished };
                fallback = fallback || { frame, locator, finished };
            } catch (e) {
                this.log.trace('读取 frame 失败，跳过:', e.message);
            }
        }
        return fallback;
    }

    /* 读当前小节卡片里的任务点。
     *
     * 真实页面(mooc2 布局)上一个小节的卡片里可能同时有视频和章节测验，各自是一个
     * .ans-attach-ct，完成的带 ans-job-finished：
     *   .ans-attach-ct.videoContainer.ans-job-finished  > iframe /ananas/modules/video/
     *   .ans-attach-ct                                  > iframe /ananas/modules/work/
     * 目录上的"1个待完成任务点"可能是测验而不是视频，所以得看这里才知道视频要不要放。
     * 没有卡片 frame(旧布局)时返回 null。 */
    async readJobs(timeoutMs = this.config.jobsWaitMs ?? 6000) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            /* 切节之后卡片 frame 可能还是上一节的。目录激活项的 id 是 cur{知识点id},
             * 卡片 frame 的 URL 带 knowledgeid={知识点id}(实测), 对不上就是旧内容——
             * 读了会拿上一节的"视频已完成"把这一节没看的视频跳过去。 */
            const activeId = await this.page.evaluate(
                () => ((document.querySelector('.posCatalog_active') || {}).id || '').replace(/^cur/, ''),
            ).catch(() => '');
            const cards = this.page.frames().find((f) => {
                if (f.isDetached() || !f.url().includes('/knowledge/cards')) return false;
                if (!activeId) return true;
                return new URL(f.url()).searchParams.get('knowledgeid') === activeId;
            });
            if (cards) {
                const jobs = await cards.evaluate(() => Array.from(document.querySelectorAll('.ans-attach-ct')).map((ct) => {
                    const src = (ct.querySelector('iframe') || {}).getAttribute
                        ? ct.querySelector('iframe').getAttribute('src') || '' : '';
                    const kind = /modules\/video/.test(src) ? 'video' : /modules\/work/.test(src) ? 'work' : 'other';
                    return { kind, finished: ct.classList.contains('ans-job-finished'), isJob: !!ct.querySelector('.ans-job-icon') };
                })).catch(() => []);
                if (jobs.length) return jobs.filter((job) => job.isJob);
            }
            if (Date.now() >= deadline) return cards ? [] : null;
            await sleepFor([300, 700]);
        }
    }

    /* 视频所在 iframe 的外层 .ans-attach-ct 有没有 ans-job-finished */
    async videoJobFinished(frame) {
        try {
            const element = await frame.frameElement();
            return await element.evaluate((el) => {
                const ct = el.closest('.ans-attach-ct');
                return ct ? ct.classList.contains('ans-job-finished') : null;
            });
        } catch (e) {
            return null;
        }
    }

    /* 切节点之后播放器要装一会儿才会出现 video 元素，不能看一眼就判定“这节没视频” */
    async findVideoWithWait(timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const video = await this.findVideo();
            if (video) return video;
            if (this.stopped || Date.now() >= deadline) return null;
            await sleepFor(this.config.videoProbeMs);
        }
    }

    async videoState(video) {
        try {
            return await video.locator.evaluate((el) => ({
                currentTime: Number(el.currentTime) || 0,
                duration: Number.isFinite(el.duration) ? el.duration : 0,
                paused: el.paused,
                ended: el.ended,
                muted: el.muted,
                volume: el.volume,
                readyState: el.readyState,
                rate: el.playbackRate,
            }));
        } catch (e) {
            return null;
        }
    }

    /* 起播前静音。
     *
     * 实测播放器上的静音按钮 .vjs-mute-control 只有 40x2 像素(图标画在伪元素上),
     * 外面还套着悬停就弹出的竖向音量条, 真实点击很容易落到音量条上——那就成了
     * "调了一下音量"而不是静音。所以直接把 muted 设上: 页面只会收到一个普通的
     * volumechange, 播放器自己的按钮也会跟着变成静音状态。
     * 必须在任何一次起播点击之前做, 否则会先外放一两秒。 */
    async ensureMuted(video) {
        if (!this.config.mute) return;
        const changed = await video.locator.evaluate((el) => {
            if (el.muted) return false;
            el.muted = true;
            return true;
        }).catch(() => false);
        if (changed) this.log.note('已静音');
    }

    /* 起播优先用真实点击：播放器的大播放按钮本来就是给人点的，
     * 点它既能拿到用户激活（不会被 autoplay 策略拦），行为也最普通。 */
    async startPlayback(video) {
        await this.ensureMuted(video);
        const atEnd = (state) => state && (state.ended || (state.duration > 0 && state.currentTime >= state.duration - 0.4));
        const before = await this.videoState(video);
        if (before && !before.paused && before.currentTime > 0) {
            this.log.note('视频已在播放');
            return true;
        }
        /* 播完的视频上 .vjs-play-control 的文字是"重播", 点下去会从头再放一遍 */
        if (atEnd(before)) {
            this.log.note('视频已经在结尾, 不去点"重播"');
            return false;
        }

        /* 判断"起来了没有"要看进度有没有走, 不能只看 paused: 起播后马上碰到视频内
         * 弹题、或者视频本身很短已经放完, 都会是暂停态。只看 paused 会误判失败,
         * 接着去点下一个按钮——放完的视频上那个按钮正是"重播"。 */
        const started = (after) => after && (!after.paused || after.currentTime > (before ? before.currentTime : 0) + 0.05);

        const attempts = [
            [SEL.bigPlayButton, () => video.frame.locator(SEL.bigPlayButton).first()],
            [SEL.playControl, () => video.frame.locator(SEL.playControl).first()],
            /* 播放器皮肤不一样时，点视频画面本身也是人会做的操作 */
            ['视频画面', () => video.locator],
        ];
        for (const [name, target] of attempts) {
            try {
                const now = await this.videoState(video);
                if (started(now)) return true;
                if (atEnd(now)) return true;    /* 上一次点击其实已经放完了, 别再点"重播" */
                const button = target();
                if (await button.count() === 0 || !await button.isVisible()) continue;
                this.log.note(`点击 ${name} 起播`);
                await this.pointer.click(button);
                await sleepFor([700, 1600]);
                if (started(await this.videoState(video))) return true;
            } catch (e) {
                this.log.trace(`点 ${name} 没成功:`, e.message);
            }
        }

        /* 兜底才用脚本调用。前面已经有过真实点击，所以这里通常不会被策略拦。 */
        const last = await this.videoState(video);
        if (started(last) || atEnd(last)) return true;
        if (this.config.allowScriptedPlay) {
            this.log.warn('真实点击未能起播，改用 video.play()（这一步是脚本调用，不是真实点击）');
            const ok = await video.locator.evaluate((el) => el.play().then(() => true).catch(() => false));
            if (ok) return true;
        }
        return false;
    }

    /* 把鼠标移进播放器，video.js 的控制栏才会显示出来 */
    async revealControls(video) {
        const box = await video.frame.locator(SEL.player).first().boundingBox().catch(() => null);
        if (!box) return false;
        await this.pointer.moveTo({
            x: box.x + box.width * human.float(0.3, 0.7),
            y: box.y + box.height * human.float(0.6, 0.88),
        });
        await sleepFor([300, 800]);
        return true;
    }

    /* 读播放器倍速菜单里有哪些档位。没有这个控件就返回 null（平台不让改倍速） */
    async readRates(video) {
        const items = video.frame.locator(SEL.rateMenuItem);
        if (await items.count() === 0) return null;
        /* 选中的那条文字是 "1x, 选择"，parseFloat 取前面的数就行 */
        return items.evaluateAll((nodes) => nodes
            .map((node, index) => ({ index, rate: parseFloat(node.textContent.trim()) }))
            .filter((item) => Number.isFinite(item.rate) && item.rate > 0));
    }

    /* 倍速切到播放器自己允许的最高档。
     *
     * 走播放器的菜单，不写 video.playbackRate：菜单里列出来的才是平台允许的档位，
     * 倍速标签也由播放器自己更新。平台不让改倍速时这个控件根本不存在，那就不动。
     * --playback-rate 1 等于维持原样；给具体数字则取不超过它的最高档。 */
    async applyPlaybackRate(video) {
        const wanted = this.config.playbackRate;
        if (wanted !== 'max' && !(Number(wanted) > 1)) return null;

        const current = await this.videoState(video);
        const rates = await this.readRates(video);
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
                await this.revealControls(video);
                const item = video.frame.locator(SEL.rateMenuItem).nth(target.index);
                /* 先把指针移到倍速按钮上：这类菜单多半悬停就展开。没展开再点一下
                 * （video.js 点击会加 vjs-lock-showing，移开指针也不收起来）。 */
                const button = video.frame.locator(SEL.rateButton).first();
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
            const after = await this.videoState(video);
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

    /* 轮询进度。间隔每轮重抽，不去踩整秒 */
    async watchUntilEnd(video) {
        let lastTime = -1;
        let lastProgressAt = Date.now();
        let lastResumeAt = 0;

        for (;;) {
            if (this.stopped) return 'stopped';
            await sleepFor(this.config.pollIntervalMs, 0.3);

            let state = await this.videoState(video);
            if (!state) {
                /* 实测: 播放中标签页被关掉(再恢复出来的是另一个页面对象)。以前这里会当成
                 * "本节结束", 计一节完成、歇一会儿再去点下一节, 然后在已关闭的页面上报错。 */
                if (this.page.isClosed()) {
                    this.log.warn('课程页被关闭了，已停下。本节没有算作完成；重新打开课程页后再运行即可。');
                    this.stop('课程页已关闭');
                    return 'stopped';
                }
                /* frame 可能因为切节点被换掉了，重新找一次 */
                const again = await this.findVideo();
                if (!again) {
                    this.log.warn('视频元素消失，回到本节重新判断');
                    return 'lost';
                }
                video.frame = again.frame;
                video.locator = again.locator;
                state = await this.videoState(video);
                if (!state) return 'lost';
                /* 换了一个 video 元素, 静音状态不会跟过来 */
                await this.ensureMuted(video);
            }

            const nearEnd = state.duration > 0 && state.currentTime >= state.duration - 0.4;
            if (state.ended || nearEnd) {
                this.log.clearStatus();
                this.log.say(`✓ 播完「${this.currentTitle || '本节'}」（${formatTime(state.duration)}）`);
                return 'ended';
            }

            if (state.currentTime > lastTime + 0.01) {
                lastTime = state.currentTime;
                lastProgressAt = Date.now();
                this.log.trace(`进度 ${formatTime(state.currentTime)} / ${formatTime(state.duration)}`);
            }
            this.showPlaying(state);

            const stalledMs = Date.now() - lastProgressAt;
            const needResume = state.paused || stalledMs >= human.ms(this.config.guardNoProgressMs, 0.25);
            if (needResume && Date.now() - lastResumeAt >= human.ms(this.config.resumeCooldownMs, 0.3)) {
                lastResumeAt = Date.now();
                if (await this.page.evaluate(() => document.hidden) && !this.config.resumeWhileHidden) {
                    this.log.trace('页面在后台，按配置不去动播放状态');
                } else {
                    this.log.note(state.paused ? '视频被暂停，尝试恢复' : `进度停滞 ${Math.round(stalledMs / 1000)} 秒，尝试恢复`);
                    await this.startPlayback(video);
                    lastProgressAt = Date.now();
                }
            }

            await this.maybeDrift();
        }
    }

    async maybeDrift() {
        if (!this.config.idleActivity) return;
        /* 下一次的时间点只在上一次之后抽一次。以前每轮轮询(约 1.2 秒)都重抽一个
         * 阈值, 等于在几十次抽签里取最先满足的那个: 实测间隔全挤在 22–26 秒,
         * 18–55 秒的区间成了一个固定节拍。 */
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

    /* 当前不在视频步骤时，点顶部的“视频”页签 */
    async enterVideoStep() {
        const tabs = this.page.locator(SEL.stepTab);
        const count = await tabs.count();
        for (let i = 0; i < count; i += 1) {
            const tab = tabs.nth(i);
            try {
                if (!await tab.isVisible()) continue;
                const text = ((await tab.textContent()) || '').replace(/\s+/g, '');
                if (!text.includes('视频')) continue;
                this.log.note(`点击学习步骤页签：${text}`);
                await this.pointer.click(tab);
                return true;
            } catch (e) {
                this.log.trace('页签点击失败:', e.message);
            }
        }
        return false;
    }

    async skipChapterTest() {
        if (this.chapterTestTries >= this.config.maxChapterTestTries) {
            this.log.warn('章节测验连续跳转失败，停下来避免页面来回打转');
            return false;
        }
        const next = this.page.locator(SEL.testNext).first();
        if (await next.count() === 0 || !await next.isVisible()) {
            this.log.warn('章节测验页上没找到下一步按钮');
            return false;
        }
        this.chapterTestTries += 1;
        /* 测验页上先“看一眼”再点下一步 */
        await sleepFor(this.config.testPeekMs);
        this.log.note('章节测验：点击下一步');
        await this.pointer.click(next);
        await sleepFor(this.config.testAdvanceWaitMs);
        return true;
    }

    /* 播放中的状态行：正在播什么、播到哪、本次已完成多少 */
    showPlaying(state) {
        const ratio = state.duration > 0 ? state.currentTime / state.duration : 0;
        const done = this.sectionsDone ? ` · 本次已播完 ${this.sectionsDone} 节` : '';
        this.log.status(
            `▶ ${clip(this.currentTitle || '视频')}  ${bar(ratio)} ${String(Math.round(ratio * 100)).padStart(3)}%`
            + `  ${formatTime(state.currentTime)}/${formatTime(state.duration)}${done}`,
        );
    }

    async sectionPause() {
        const long = human.chance(this.config.longBreakChance);
        const ms = human.ms(long ? this.config.longBreakMs : this.config.sectionPauseMs);
        if (long) this.log.say(`休息一下，${Math.round(ms / 1000)} 秒后继续`);
        const until = Date.now() + ms;
        while (!this.stopped && Date.now() < until) {
            const left = Math.ceil((until - Date.now()) / 1000);
            this.log.status(`⏸ 本节结束，${left} 秒后切换下一节 · 本次已播完 ${this.sectionsDone} 节`);
            await sleep(Math.min(1000, until - Date.now()));
        }
        this.log.clearStatus();
    }

    /* 收尾时说一句人话：这次跑了多久、播完几节 */
    reportRun(reason) {
        this.log.clearStatus();
        const spent = formatDuration(Date.now() - this.startedAt);
        this.log.say(`—— ${reason}：本次播完 ${this.sectionsDone} 节，用时 ${spent} ——`);
    }

    /* 目录侧栏收起时目标项在视口外, 先点开侧栏——看不到目录时人也是这么做的 */
    async ensureCatalogVisible(locator) {
        const width = await this.page.evaluate(() => window.innerWidth);
        const visible = async () => {
            const box = await locator.boundingBox();
            return !!box && box.x >= 0 && box.x + box.width <= width;
        };
        if (await visible()) return true;
        const toggle = this.page.locator(SEL.catalogToggle).first();
        if (!await toggle.count() || !await toggle.isVisible()) return false;
        this.log.note('目录侧栏是收起的, 先点开');
        await this.pointer.click(toggle);
        await sleepFor([800, 1400]);   /* 侧栏有滑入动画 */
        return visible();
    }

    /* 点完目录项之后确认真的切过去了: 激活项变成了目标节 */
    async waitForSection(target, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const tree = await this.readTree();
            const current = tree.current;
            if (current && current.chapterIndex === target.chapterIndex && current.sectionIndex === target.sectionIndex) {
                return true;
            }
            await sleepFor([300, 600]);
        }
        return false;
    }

    async gotoNextSection() {
        const tree = await this.readTree();
        if (!tree.current) {
            this.log.warn('目录里找不到当前激活的小节，需要先手动点开一节');
            return false;
        }
        const { target, skipped, marked } = pickNextSection(tree);
        if (!target) {
            this.log.say(marked ? '后面没有待完成任务点的小节了，课程完成' : '已经是最后一节，课程播放完成');
            return false;
        }

        const name = target.title || `第${target.chapterIndex + 1}章第${target.sectionIndex + 1}节`;
        this.currentTitle = name;
        this.log.say(skipped ? `切换到：${name}（跳过中间 ${skipped} 个没有待完成任务点的小节）` : `切换到：${name}`);
        const locator = this.sectionLocator(target);

        /* 以前点完就当切过去了。实测目录侧栏收起时点击落在视口外, 页面纹丝不动,
         * 工具却每隔几秒重新"切换"一次同一节。现在点完必须确认激活项真的变了,
         * 不行就重试一次, 再不行就停下, 不原地打转。 */
        let moved = false;
        for (let attempt = 1; attempt <= 2 && !moved && !this.stopped; attempt += 1) {
            try {
                await this.ensureCatalogVisible(locator);
                await this.pointer.click(locator, { scrollAnchor: this.page.locator(SEL.tree) });
            } catch (e) {
                this.log.warn(`点目录里的「${name}」失败: ${e.message.split('\n')[0]}`);
            }
            moved = await this.waitForSection(target, this.config.sectionSwitchWaitMs);
            if (!moved && attempt === 1) this.log.warn('点完目录没有切过去, 再试一次');
        }
        if (!moved) {
            this.log.error(`点了目录里的「${name}」但页面没有切过去, 已停下。可能是平台弹了提示框或者目录结构变了, 请看一眼浏览器。`);
            this.stop('切换小节失败');
            return false;
        }
        await sleepFor(this.config.sectionLoadMs);
        /* 新的一节重新给满重试次数 */
        this.chapterTestTries = 0;
        this.stepSwitchTries = 0;
        return true;
    }

    /* 刚接管页面时先真实地动一下：移动指针、小幅滚一下再滚回来。
     *
     * 两个理由：
     * 1. 人打开一个页面本来就会先动一动、滚一下看看，不会盯着不动好几秒。
     * 2. 本地靶场实测：被调试端口接管的浏览器里（Playwright 自己启动和接管已有
     *    Chrome 都一样），navigator.userActivation.hasBeenActive 会在页面加载约
     *    1.5 秒后自行变成 true，而普通 Chrome 要等真实交互。于是出现一个自相
     *    矛盾的状态——「浏览器说用户激活过，页面却一个可信输入事件都没收到」。
     *    以前的 1.2~5.5 秒启动延迟反而让这个状态一直挂着：越是加「像人的延迟」，
     *    这个窗口开得越久。先做一次真实输入就把它合上了。
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
        await this.waitForTree();
        const tree = await this.readTree();
        this.currentTitle = tree.current ? tree.current.title || '' : '';
        this.log.say(`课程共 ${tree.chapters.length} 章 ${tree.total} 节，当前：${this.currentTitle || '未定位'}`);
        this.log.say(`开始了。可以把浏览器窗口放到后面去，但别最小化。${keyHint('按 Ctrl+C 停止。')}`);

        while (!this.stopped) {
            if (this.config.maxSections > 0 && this.sectionsDone >= this.config.maxSections) {
                this.log.say(`已完成 ${this.sectionsDone} 节，达到 --max-sections 上限`);
                return;
            }

            /* .prev_title 在旧布局里是步骤名("视频"/"章节测验"), 但实测 mooc2 布局里
             * 它是小节标题, 靠它判断会全部落空。所以先看卡片里的任务点。 */
            const step = await this.currentStepTitle();
            const jobs = await this.readJobs();
            const pendingVideo = jobs ? jobs.some((job) => job.kind === 'video' && !job.finished) : false;
            const pendingOther = jobs ? jobs.filter((job) => job.kind !== 'video' && !job.finished).length : 0;
            if (jobs) {
                this.log.note(`本节任务点: ${jobs.map((job) => `${job.kind}${job.finished ? '✓' : '…'}`).join(' ') || '无'}`);
            }

            /* 有没完成的视频就多等一会儿等播放器装好；其它情况没必要干等 */
            const expectVideo = pendingVideo || step === '视频';
            const waitMs = expectVideo ? this.config.videoWaitMs : human.ms(this.config.stepProbeMs);
            let video = await this.findVideoWithWait(waitMs);
            if (this.stopped) return;

            /* 视频不是任务点(卡片上没有 .ans-job-icon, 实测 mArg 里也没有 job 字段)
             * 时同样不播: 不计入完成度的视频按约定跳过 */
            if (video && (video.finished === true || (jobs && !pendingVideo))) {
                const videoIsJob = video.finished === true || jobs.some((job) => job.kind === 'video');
                this.log.note(videoIsJob ? '本节视频任务点已经完成, 不再重放' : '本节的视频不算任务点, 不播');
                video = null;
            }

            if (!video && jobs && !pendingVideo) {
                /* 新布局: 视频要么没有、要么已完成、要么不是任务点, 剩下的是测验等非视频任务点 */
                const rest = pendingOther
                    ? `还剩 ${pendingOther} 个非视频任务点(章节测验等)需要你自己完成`
                    : (jobs.length ? '本节任务点已全部完成' : '本节没有任务点');
                if (!this.config.autoAdvanceNoVideo && pendingOther) {
                    this.log.warn(`本节没有待播的视频, ${rest}。按配置停下; 去掉 --no-auto-advance-no-video 可自动跳过。`);
                    return;
                }
                /* 计分的测验、课件这些我们不代做, 跳过去找下一个有视频的小节 */
                this.log.say(`本节没有待播的视频, ${rest}, 跳过, 继续找下一个有视频的小节`);
                if (!await this.gotoNextSection()) return;
                continue;
            }

            if (!video) {
                this.log.note(`当前步骤「${step || '未知'}」没有视频`);

                if (step === '章节测验') {
                    if (await this.skipChapterTest()) continue;
                    return;
                }
                /* 点了页签却始终没出现视频时必须停手：否则这里会一直点同一个
                 * 页签转圈，比什么都不做更显眼。 */
                if (this.stepSwitchTries >= this.config.maxStepSwitchTries) {
                    this.log.warn(`已连续 ${this.stepSwitchTries} 次切到视频步骤但没等到视频，停下来避免原地打转`);
                    return;
                }
                if (await this.enterVideoStep()) {
                    this.stepSwitchTries += 1;
                    await sleepFor(this.config.stepSwitchWaitMs);
                    continue;
                }
                if (!this.config.autoAdvanceNoVideo) {
                    this.log.warn('这一节没有视频也没有可识别的学习步骤，已停下。确认无需完成课件后再加 --auto-advance-no-video 重跑。');
                    return;
                }
                this.log.warn('按配置跳过没有视频的小节');
                if (!await this.gotoNextSection()) return;
                continue;
            }

            if (!await this.startPlayback(video)) {
                this.log.warn('这一节起播失败，已停下');
                return;
            }
            /* 倍速要等起播之后再调：真实页面上 .vjs-control-bar 在起播前是
             * display:none，指针移上去也不出来，倍速按钮根本点不到。 */
            await this.applyPlaybackRate(video);

            const result = await this.watchUntilEnd(video);
            if (result === 'stopped') return;
            /* 视频元素没了(页面还在)不等于放完: 回到循环开头重新读本节任务点,
             * 视频还没完成就接着放。连续两次这样就停下, 不原地打转。 */
            if (result === 'lost') {
                this.lostTries += 1;
                if (this.lostTries >= 2) {
                    this.log.warn('视频连续两次在播放中消失，已停下，请看一眼浏览器');
                    return;
                }
                continue;
            }
            this.lostTries = 0;
            this.sectionsDone += 1;
            /* 到了上限就停在这一节, 不先点进下一节再停 */
            if (this.config.maxSections > 0 && this.sectionsDone >= this.config.maxSections) {
                this.log.say(`已完成 ${this.sectionsDone} 节，达到 --max-sections 上限`);
                return;
            }

            await this.sectionPause();
            if (this.stopped) return;
            if (!await this.gotoNextSection()) return;
        }
    }
}
