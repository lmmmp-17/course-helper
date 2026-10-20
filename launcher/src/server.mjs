/* ------------------------------------------------------------------
 * 本地控制台的 HTTP 服务。
 *
 * 安全上两条：
 *   1. 只绑 127.0.0.1，不对外网暴露；
 *   2. 带一个随机 token。这个服务能在你机器上启动进程，本机别的程序
 *      （包括浏览器里任何一个网页）要是能随便调它就太糟了。token 放在
 *      地址里，只有拿到那条地址的人能用。
 * ------------------------------------------------------------------ */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, byId } from './tools.mjs';

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

export async function startServer({ root, runner, publicDir, settings = null, port = 0, token = randomBytes(16).toString('hex') }) {
    const send = (res, code, body, type = 'application/json; charset=utf-8') => {
        res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    const server = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        /* 静态页面本身不含敏感内容，但接口一律要 token */
        const authorized = url.searchParams.get('token') === token;

        if (url.pathname === '/' || url.pathname === '/index.html') {
            const html = await readFile(resolve(publicDir, 'index.html'), 'utf8');
            return send(res, 200, html, TYPES['.html']);
        }
        if (url.pathname.startsWith('/api/') && !authorized) {
            return send(res, 403, { error: '口令不对。请用脚本打印的那条地址打开控制台。' });
        }

        if (url.pathname === '/api/tools') {
            /* 上次选的平台和填过的值，窗口版和终端版共用（settings.mjs） */
            const saved = settings ? settings.read() : { picked: null, values: {} };
            return send(res, 200, { tools: describe(root, process.platform, { remembered: saved.values }), state: runner.state(), picked: saved.picked });
        }

        if (url.pathname === '/api/pick' && req.method === 'POST') {
            let body = '';
            for await (const chunk of req) body += chunk;
            let payload;
            try { payload = JSON.parse(body || '{}'); } catch (e) { return send(res, 400, { error: '请求格式不对' }); }
            if (!byId(payload.tool)) return send(res, 400, { error: '没有这个工具' });
            try { settings?.pick(payload.tool); } catch (e) { /* 记不住就算了 */ }
            return send(res, 200, { picked: payload.tool });
        }

        if (url.pathname === '/api/events') {
            res.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-store',
                connection: 'keep-alive',
            });
            res.write(`data: ${JSON.stringify({ type: 'state', ...runner.state() })}\n\n`);
            const off = runner.onEvent((event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
            /* 有些代理会掐断长时间没数据的连接，隔一会儿发个注释行保活 */
            const beat = setInterval(() => res.write(': ping\n\n'), 20000);
            req.on('close', () => { off(); clearInterval(beat); });
            return undefined;
        }

        if (url.pathname === '/api/start' && req.method === 'POST') {
            let body = '';
            for await (const chunk of req) body += chunk;
            let payload;
            try { payload = JSON.parse(body || '{}'); } catch (e) { return send(res, 400, { error: '请求格式不对' }); }
            const tool = byId(payload.tool);
            if (!tool) return send(res, 400, { error: '没有这个工具' });
            try {
                return send(res, 200, await runner.start(tool, payload.values || {}));
            } catch (error) {
                return send(res, 400, { error: error.message });
            }
        }

        if (url.pathname === '/api/stop' && req.method === 'POST') {
            let body = '';
            for await (const chunk of req) body += chunk;
            let payload;
            try { payload = JSON.parse(body || '{}'); } catch (e) { return send(res, 400, { error: '请求格式不对' }); }
            /* 不指定工具就全停 */
            if (payload.tool !== undefined && !byId(payload.tool)) return send(res, 400, { error: '没有这个工具' });
            return send(res, 200, { stopped: runner.stop(payload.tool) });
        }

        return send(res, 404, { error: '没有这个地址' });
    });

    await new Promise((done) => server.listen(port, '127.0.0.1', done));
    const actual = server.address().port;
    return {
        port: actual,
        token,
        url: `http://127.0.0.1:${actual}/?token=${token}`,
        async close() {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            await new Promise((done) => server.close(done));
        },
    };
}
