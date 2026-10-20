/* ------------------------------------------------------------------
 * 只读检查真实课程页：目录、学习步骤、各个 frame 里的播放器和弹出物。
 *
 * 用途是适配页面结构——智慧树那边的教训是，照旧代码的选择器建桩、再拿桩验证桩，
 * 会漏掉"那个元素其实一直没命中"这种问题。所以动手改操作之前先跑这个，看真实结构。
 *
 * 只读 DOM，不点击、不播放、不改任何状态。
 * ------------------------------------------------------------------ */

const DESCRIBE_JS = `(el, depth) => {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3)
    .map((n) => n.textContent.trim()).filter(Boolean).join(' ');
  return {
    depth, tag: el.tagName.toLowerCase(), id: el.id || '',
    cls: typeof el.className === 'string' ? el.className : '',
    text: own.slice(0, 40),
    rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
    visible: rect.width > 0 && rect.height > 0 && style.display !== 'none'
      && style.visibility !== 'hidden' && style.opacity !== '0',
    pointer: style.cursor === 'pointer',
    display: style.display,
  };
}`;

const SUBTREE_JS = `({ selector, maxDepth, maxNodes }) => {
  const describe = ${DESCRIBE_JS};
  const root = document.querySelector(selector);
  if (!root) return null;
  const out = [];
  const walk = (el, depth) => {
    if (out.length >= maxNodes) return;
    out.push(describe(el, depth));
    if (depth < maxDepth) for (const child of el.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return out;
}`;

/* 视频所在 frame 的概况：video 状态、播放器容器、以及所有"像弹出物"的可见元素 */
const VIDEO_FRAME_JS = `() => {
  const describe = ${DESCRIBE_JS};
  const video = document.querySelector('video');
  if (!video) return null;
  let player = video;
  for (let i = 0; i < 6 && player.parentElement; i++) {
    player = player.parentElement;
    if (/video-js|vjs|player/i.test(player.className || '')) break;
  }
  const popups = Array.from(document.querySelectorAll('[class*=quiz i],[class*=topic i],[class*=question i],[class*=exam i],[class*=dialog i],[class*=modal i],[class*=popup i],[class*=layer i]'))
    .map((el) => describe(el, 0))
    .filter((d) => d.visible)
    .slice(0, 30);
  return {
    video: { id: video.id, cls: video.className, paused: video.paused, muted: video.muted,
             volume: video.volume, rate: video.playbackRate, currentTime: Math.round(video.currentTime),
             duration: Math.round(video.duration || 0), readyState: video.readyState },
    player: { tag: player.tagName.toLowerCase(), id: player.id, cls: player.className },
    popups,
  };
}`;

const TOP_PAGE_JS = `() => {
  const text = (el) => (el ? (el.getAttribute('title') || el.textContent || '').trim().slice(0, 40) : null);
  const tree = document.querySelector('#coursetree');
  return {
    title: document.title,
    stepTitle: text(document.querySelector('.prev_title')),
    stepTabs: Array.from(document.querySelectorAll('.prev_white')).map((el) => ({
      text: el.textContent.replace(/\\s+/g, ''), visible: el.getBoundingClientRect().height > 0 })),
    tree: tree ? {
      chapters: document.querySelectorAll('#coursetree > ul > li').length,
      sections: document.querySelectorAll('.posCatalog_select:not(.firstLayer)').length,
      active: text(document.querySelector('.posCatalog_active .posCatalog_name')),
    } : null,
    testNext: Array.from(document.querySelectorAll('#prevNextFocusNext, #right1, .nextChapter'))
      .map((el) => ({ id: el.id, cls: el.className, visible: el.getBoundingClientRect().height > 0 })),
  };
}`;

function render(nodes) {
    return nodes.map((n) => {
        let name = n.tag + (n.id ? `#${n.id}` : '') + (n.cls ? `.${n.cls.trim().split(/\s+/).slice(0, 3).join('.')}` : '');
        const marks = `${n.visible ? '' : ' [隐藏]'}${n.pointer ? ' [pointer]' : ''}`;
        const text = n.text ? ` '${n.text}'` : '';
        const [x, y, w, h] = n.rect;
        return `${'  '.repeat(n.depth)}${name}${text} ${w}x${h} @${x},${y}${marks}`;
    }).join('\n');
}

export async function inspectPage(page, { hoverPlayer = null } = {}) {
    const lines = [];
    const top = await page.evaluate(`(${TOP_PAGE_JS})()`);
    lines.push('===== 顶层页面 =====', JSON.stringify(top, null, 1));

    lines.push('', '===== frame 列表 =====');
    for (const frame of page.frames()) {
        lines.push(`  ${frame.url().slice(0, 120)}`);
    }

    for (const frame of page.frames()) {
        if (frame.isDetached()) continue;
        let info = null;
        try {
            info = await frame.evaluate(`(${VIDEO_FRAME_JS})()`);
        } catch (e) {
            continue;
        }
        if (!info) continue;
        lines.push('', `===== 视频 frame: ${frame.url().slice(0, 100)} =====`);
        lines.push(`video: ${JSON.stringify(info.video)}`);
        lines.push(`播放器容器: ${JSON.stringify(info.player)}`);

        const selector = info.player.id ? `#${info.player.id}` : (info.player.cls ? `.${info.player.cls.trim().split(/\s+/)[0]}` : 'video');
        const dump = await frame.evaluate(`(${SUBTREE_JS})(${JSON.stringify({ selector, maxDepth: 4, maxNodes: 120 })})`);
        if (dump) lines.push('--- 播放器结构 ---', render(dump));

        if (hoverPlayer) {
            /* 控制栏多半要指针进入才显示——智慧树那个就是。交给调用方移动指针后再看一次 */
            try {
                await hoverPlayer(frame, selector);
                const hovered = await frame.evaluate(`(${SUBTREE_JS})(${JSON.stringify({ selector, maxDepth: 4, maxNodes: 120 })})`);
                if (hovered) lines.push('--- 指针移进播放器之后 ---', render(hovered));
            } catch (e) {
                lines.push(`--- 指针移进播放器失败: ${e.message.split('\n')[0]} ---`);
            }
        }

        if (info.popups.length) {
            lines.push('--- 可见的弹出物候选 ---', render(info.popups));
        }
    }
    return lines.join('\n');
}
