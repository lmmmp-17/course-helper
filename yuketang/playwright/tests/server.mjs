/* 本地静态服务：任何路径都返回学习空间桩页面（它自己用 history 改地址） */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function startFixtureServer() {
    const body = await readFile(resolve(import.meta.dirname, 'fixtures', 'workspace.html'));
    const server = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(body);
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address();
    return {
        url: `http://127.0.0.1:${port}/ai-workspace/lms-graph/1/video/V2`,
        async close() {
            /* 浏览器会保持 keep-alive 连接，不先掐断的话 server.close() 会一直等下去 */
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            await new Promise((done) => server.close(done));
        },
    };
}
