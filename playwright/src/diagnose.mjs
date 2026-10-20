/* ------------------------------------------------------------------
 * 特征自检
 * 把页面侧真正能读到的那些值打出来，顺便用一次真实点击验证 isTrusted。
 * 用 --check 运行，不会动课程进度。
 * ------------------------------------------------------------------ */
import { sleep } from './human.mjs';

const PROBE_ID = '__pw_probe_layer';

export async function collectFingerprint(page) {
    return page.evaluate(() => {
        const nav = navigator;
        /* isTrusted 是实例自身的 [LegacyUnforgeable] accessor，正常情况下
         * configurable 为 false。若变成 true，说明这个浏览器环境被动过手脚。 */
        const trustedDescriptor = Object.getOwnPropertyDescriptor(new MouseEvent('probe'), 'isTrusted');
        return {
            'navigator.webdriver': nav.webdriver,
            'document.hasFocus()': document.hasFocus(),
            'document.visibilityState': document.visibilityState,
            'userAgent 含 Headless': /Headless/i.test(nav.userAgent),
            'navigator.languages': Array.isArray(nav.languages) ? nav.languages.join(',') : String(nav.languages),
            'navigator.plugins 数量': nav.plugins ? nav.plugins.length : 0,
            'window.chrome 存在': typeof window.chrome === 'object' && window.chrome !== null,
            'navigator.hardwareConcurrency': nav.hardwareConcurrency,
            'screen 尺寸': `${screen.width}x${screen.height}`,
            'window 尺寸': `${innerWidth}x${innerHeight}`,
            'Notification 权限': typeof Notification === 'function' ? Notification.permission : '不可用',
            'isTrusted 仍不可伪造': Boolean(trustedDescriptor && trustedDescriptor.configurable === false),
        };
    });
}

/* 在页面右下角放一块半透明探针，真实点一下，读回 isTrusted 等字段后立刻移除 */
export async function probeTrustedInput(page, pointer) {
    await page.evaluate((id) => {
        document.getElementById(id)?.remove();
        const layer = document.createElement('div');
        layer.id = id;
        layer.style.cssText = [
            'position:fixed', 'right:24px', 'bottom:24px', 'width:150px', 'height:54px',
            'z-index:2147483647', 'background:rgba(0,0,0,0.04)', 'border-radius:6px',
        ].join(';');
        window.__pwProbeResult = null;
        layer.addEventListener('click', (event) => {
            /* 真实事件实例上本来就有 own isTrusted（enumerable、不可配置、带 getter）。
             * 所以“存在 own property”不是伪造痕迹，变成可配置或退化成 value 才是。 */
            const descriptor = Object.getOwnPropertyDescriptor(event, 'isTrusted');
            window.__pwProbeResult = {
                isTrusted: event.isTrusted,
                detail: event.detail,
                clientX: event.clientX,
                clientY: event.clientY,
                movementSeen: window.__pwProbeMoves || 0,
                isTrustedTampered: Boolean(descriptor && (descriptor.configurable === true || !descriptor.get)),
                sourceCapabilities: event.sourceCapabilities
                    ? `InputDeviceCapabilities(firesTouchEvents=${event.sourceCapabilities.firesTouchEvents})`
                    : null,
            };
        });
        window.__pwProbeMoves = 0;
        layer.addEventListener('mousemove', () => { window.__pwProbeMoves += 1; });
        document.body.appendChild(layer);
    }, PROBE_ID);

    try {
        await pointer.click(page.locator(`#${PROBE_ID}`));
        await sleep(120);
        return await page.evaluate(() => window.__pwProbeResult);
    } finally {
        await page.evaluate((id) => {
            document.getElementById(id)?.remove();
            delete window.__pwProbeResult;
            delete window.__pwProbeMoves;
        }, PROBE_ID);
    }
}

export function formatReport(fingerprint, probe, focus) {
    const lines = ['', '页面侧能读到的环境特征：'];
    const flag = (key, value) => {
        const bad = (key === 'navigator.webdriver' && value === true)
            || (key === 'userAgent 含 Headless' && value === true)
            || (key === 'window.chrome 存在' && value === false)
            || (key === 'navigator.plugins 数量' && value === 0)
            || (key === 'isTrusted 仍不可伪造' && value === false)
            || (key === 'document.hasFocus()' && value === false)
            || (key === 'document.visibilityState' && value !== 'visible');
        return bad ? ' ← 可疑' : '';
    };
    for (const [key, value] of Object.entries(fingerprint)) {
        lines.push(`  ${key.padEnd(38)} ${String(value)}${flag(key, value)}`);
    }

    if (focus) {
        lines.push('', '焦点与生命周期：');
        for (const name of focus.applied) lines.push(`  已启用  ${name}`);
        for (const name of focus.skipped) lines.push(`  不可用  ${name}`);
    }

    lines.push('', '真实点击实测：');
    if (!probe) {
        lines.push('  探针没有收到点击（页面可能拦掉了覆盖层）');
    } else {
        lines.push(`  event.isTrusted                        ${probe.isTrusted}${probe.isTrusted ? '' : ' ← 不是可信事件'}`);
        lines.push(`  event.detail                           ${probe.detail}`);
        lines.push(`  落点坐标                               ${probe.clientX},${probe.clientY}`);
        lines.push(`  点击前经过的 mousemove 次数            ${probe.movementSeen}`);
        lines.push(`  isTrusted 被动过手脚                   ${probe.isTrustedTampered}${probe.isTrustedTampered ? ' ← 可疑' : ''}`);
        lines.push(`  event.sourceCapabilities               ${probe.sourceCapabilities ?? 'null'}`);
    }
    lines.push('');
    return lines.join('\n');
}
