/* ------------------------------------------------------------------
 * 只读检查真实页面：目录、当前项、播放器、可见的弹窗。
 *
 * 适配页面改版时先跑这个，看真实结构再改选择器——照旧代码的选择器建桩、再拿桩
 * 验证桩，会漏掉“那个元素其实一直没命中”这种问题。
 *
 * 只读 DOM，不点击、不播放、不改任何状态。
 * ------------------------------------------------------------------ */
import { SEL } from './selectors.mjs';
import { keyEntries } from './learning.mjs';

export async function inspectPage(page) {
    const lines = [];
    const top = await page.evaluate((sel) => {
        const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
        const visible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const video = document.querySelector(sel.video);
        const list = document.querySelector(sel.navList);
        return {
            url: location.href,
            title: document.title,
            unitTitle: text(document.querySelector(sel.unitTitle)),
            unitRate: text(document.querySelector(sel.unitRate)),
            navList: list ? { scrollTop: Math.round(list.scrollTop), scrollHeight: list.scrollHeight, clientHeight: list.clientHeight } : null,
            video: video ? {
                currentTime: Math.round(video.currentTime), duration: Math.round(video.duration || 0),
                paused: video.paused, ended: video.ended, muted: video.muted, volume: video.volume,
                rate: video.playbackRate, readyState: video.readyState,
            } : null,
            bigPlayButton: visible(document.querySelector(sel.bigPlayButton)),
            controlsShown: visible(document.querySelector(sel.controlBox)),
            dialogs: Array.from(document.querySelectorAll(sel.dialog)).filter(visible)
                .map((el) => el.innerText.replace(/\s+/g, ' ').slice(0, 120)),
        };
    }, SEL);
    lines.push('===== 页面 =====', JSON.stringify(top, null, 1));

    const raw = await page.evaluate((sel) => {
        const list = document.querySelector(sel.navList);
        if (!list) return [];
        const text = (el) => (el ? el.textContent : '').trim();
        const out = [];
        for (const el of list.querySelectorAll('.leaf-item, .expand-icon')) {
            if (el.classList.contains('leaf-item')) {
                out.push({ type: 'leaf', kind: text(el.querySelector(sel.leafTag)), title: text(el.querySelector(sel.leafTitle)),
                    done: Boolean(el.querySelector(sel.leafDone)), active: el.classList.contains('is-active') });
            } else if (!el.classList.contains('is-expanded')) {
                const node = el.closest('.nav-item-node');
                out.push({ type: 'node', title: text(node && node.querySelector('.nav-item-title')) });
            }
        }
        return out;
    }, SEL);
    const entries = keyEntries(raw);
    lines.push('', '===== 目录（✓ 已完成，▶ 当前，+ 折叠的知识点） =====');
    for (const entry of entries) {
        if (entry.type === 'node') {
            lines.push(`  +    ${entry.title}`);
        } else {
            lines.push(`  ${entry.active ? '▶' : ' '}${entry.done ? '✓' : ' '}  [${entry.kind}] ${entry.title}`);
        }
    }
    return lines.join('\n');
}
