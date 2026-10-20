/* ------------------------------------------------------------------
 * 焦点与生命周期
 *
 * 这是 CDP 模式相对油猴版的另一个实质差别。
 *
 * 油猴版只能在页面里“对抗”焦点变化：监听 blur / visibilitychange，等视频被
 * 页面脚本暂停之后再把它按回去。事件照样发生过，页面照样看得见。
 *
 * 这里改为从浏览器层面让这些事件根本不发生：
 *   - Emulation.setFocusEmulationEnabled：渲染进程始终认为自己持有焦点，
 *     （Playwright 接管每个页面时自己就会发这一条，连接模式也一样；这里再显式
 *     发一次，不依赖它的默认行为。另外两条 Playwright 不发。）
 *     document.hasFocus() 恒为 true，窗口失焦时不再触发 blur / focusout。
 *   - Page.setWebLifecycleState('active')：阻止标签页被冻结（frozen），
 *     否则后台标签的定时器会被大幅节流甚至停掉。
 *   - Emulation.setIdleOverride：Idle Detection API 恒为“用户活跃、屏幕未锁”。
 *
 * 还剩一件事做不到：document.visibilityState。它由标签页自身的状态决定，
 * 没有对应的 override。规避办法是别把课程页切到后台——详见下面 noteOnVisibility()。
 * ------------------------------------------------------------------ */

const STEPS = [
    {
        name: '焦点模拟（blur 不再触发）',
        method: 'Emulation.setFocusEmulationEnabled',
        params: { enabled: true },
    },
    {
        name: '阻止标签页被冻结',
        method: 'Page.setWebLifecycleState',
        params: { state: 'active' },
    },
    {
        name: '空闲检测恒为活跃',
        method: 'Emulation.setIdleOverride',
        params: { isUserActive: true, isScreenUnlocked: true },
    },
];

export async function hardenFocus(page, log) {
    const applied = [];
    const skipped = [];
    let session;
    try {
        session = await page.context().newCDPSession(page);
    } catch (e) {
        log.warn('拿不到 CDP 会话，焦点模拟跳过:', e.message);
        return { applied, skipped: STEPS.map((step) => step.name), session: null };
    }

    for (const step of STEPS) {
        try {
            await session.send(step.method, step.params);
            applied.push(step.name);
            log.note(`已启用：${step.name}`);
        } catch (e) {
            /* 旧版 Chrome 可能没有某个命令，不影响其余部分 */
            skipped.push(step.name);
            log.trace(`${step.method} 不可用:`, e.message);
        }
    }
    return { applied, skipped, session };
}

export function noteOnVisibility() {
    return [
        'document.visibilityState 没有 CDP override，所以：',
        '  - 把课程页放在一个单独的浏览器窗口里。失焦但没被遮住的窗口，其活动标签页',
        '    的 visibilityState 仍然是 visible，只有 hasFocus() 会变 false——而那一项已经被模拟掉了。',
        '  - 不要在同一个窗口里切到别的标签页，那会让课程页变成后台标签（hidden）。',
        '  - 窗口最小化也会变 hidden。放到后面、或者挪到另一个工作区都没问题——',
        '    但 Windows 上窗口被完全盖住同样会变 hidden，要靠浏览器启动时带',
        '    --disable-backgrounding-occluded-windows（脚本自己开的 Chrome / Edge 都带）。',
    ].join('\n');
}
