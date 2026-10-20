import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourcePath = resolve(root, 'v3_optimized.js');
const userScriptPath = resolve(root, 'v3_optimized.user.js');
const userScript = readFileSync(userScriptPath, 'utf8');
const marker = '// ==/UserScript==\n\n';
const markerIndex = userScript.indexOf(marker);

if (markerIndex < 0) throw new Error('油猴元数据块缺失或格式错误');
const metadata = userScript.slice(0, markerIndex + marker.length);
const payload = userScript.slice(markerIndex + marker.length);
const source = readFileSync(sourcePath, 'utf8');
if (payload !== source) throw new Error('油猴脚本未由 v3_optimized.js 同步生成');

execFileSync(process.execPath, ['--check', sourcePath], { stdio: 'inherit' });
execFileSync(process.execPath, ['--check', userScriptPath], { stdio: 'inherit' });

/* ------------------------------------------------------------------
 * 安全回归检查
 * 脚本运行在已登录的学习通页面上，拥有该会话的全部权限，因此不允许
 * 引入远程代码或动态求值。以下断言用于防止这些模式被重新引入。
 * ------------------------------------------------------------------ */

/* 去掉注释后再扫描，避免说明文字造成误报 */
function stripComments(code) {
    return code
        .split('\n')
        .filter((line) => {
            const trimmed = line.trim();
            return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
        })
        .join('\n');
}

const code = stripComments(source);

const forbiddenPatterns = [
    { pattern: /\bhttps?:\/\//, reason: '出现远程地址：脚本不得加载或连接任何外部资源' },
    { pattern: /\beval\s*\(/, reason: '出现 eval()' },
    { pattern: /new\s+Function\s*\(/, reason: '出现 new Function()' },
    { pattern: /\.innerHTML\s*=/, reason: '出现 innerHTML 赋值' },
    { pattern: /insertAdjacentHTML/, reason: '出现 insertAdjacentHTML' },
    { pattern: /document\.write/, reason: '出现 document.write' },
    { pattern: /createElement\s*\(\s*['"]script['"]/, reason: '出现动态 script 注入' },
];

for (const { pattern, reason } of forbiddenPatterns) {
    if (pattern.test(code)) {
        throw new Error(`安全检查失败：${reason}（匹配 ${pattern}）`);
    }
}

/* 油猴元数据：仅 https、禁止注入到子框架、不授予任何 GM 权限 */
const matchLines = metadata.split('\n').filter((line) => line.includes('@match'));
if (matchLines.length === 0) throw new Error('安全检查失败：缺少 @match 限制');
for (const line of matchLines) {
    if (!line.includes('https://')) {
        throw new Error(`安全检查失败：@match 必须限定为 https —— ${line.trim()}`);
    }
    if (!line.includes('chaoxing.com')) {
        throw new Error(`安全检查失败：@match 必须限定在 chaoxing.com —— ${line.trim()}`);
    }
}
if (!/@noframes/.test(metadata)) throw new Error('安全检查失败：缺少 @noframes');
if (!/@grant\s+none/.test(metadata)) throw new Error('安全检查失败：@grant 必须为 none');

/* 运行域名校验必须保留 */
if (!/ALLOWED_HOSTS/.test(code) || !/isAllowedHost/.test(code)) {
    throw new Error('安全检查失败：运行时域名校验缺失');
}

console.log('V3 source and userscript payload are synchronized and syntactically valid.');
console.log('安全检查通过：无远程依赖、无动态求值、元数据作用域已收紧。');
