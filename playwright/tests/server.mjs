/* 本地静态服务：fixture 用 http 提供，iframe 才和父页面同源。
 *
 * 默认把任何路径都返回 course.html(旧布局桩)。传 { layout: 'mooc2' } 时按真实
 * 学习通的 URL 结构分发，因为代码是靠 frame 的 URL 路径认出卡片和播放器的：
 *   /mycourse/studentstudy      -> mooc2/course.html
 *   /knowledge/cards            -> mooc2/cards.html
 *   /ananas/modules/video/...   -> mooc2/video.html
 *   /ananas/modules/work/...    -> mooc2/work.html
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const MOOC2_ROUTES = [
    ['/mycourse/studentstudy', 'mooc2/course.html'],
    ['/knowledge/cards', 'mooc2/cards.html'],
    ['/ananas/modules/video/', 'mooc2/video.html'],
    ['/ananas/modules/work/', 'mooc2/work.html'],
];

export async function startFixtureServer({ layout = 'legacy' } = {}) {
    const fixtures = resolve(import.meta.dirname, 'fixtures');
    const legacy = await readFile(resolve(fixtures, 'course.html'));
    const server = createServer(async (req, res) => {
        let body = legacy;
        if (layout === 'mooc2') {
            const path = new URL(req.url, 'http://x').pathname;
            const hit = MOOC2_ROUTES.find(([prefix]) => path.startsWith(prefix));
            body = hit ? await readFile(resolve(fixtures, hit[1])) : Buffer.from('');
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(body);
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    return {
        url: layout === 'mooc2' ? `${base}/mycourse/studentstudy?courseId=1` : `${base}/course.html`,
        async close() {
            /* 浏览器会保持 keep-alive 连接，不先掐断的话 server.close() 会一直等下去 */
            if (typeof server.closeAllConnections === 'function') {
                server.closeAllConnections();
            }
            await new Promise((done) => server.close(done));
        },
    };
}
