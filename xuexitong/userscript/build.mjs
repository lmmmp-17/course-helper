import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = import.meta.dirname;
/* 统一成 LF 再拼: Windows 上检出的源码是 CRLF, 而下面的元数据模板是 LF,
 * 直接拼会写出混合换行的文件, git status 永远是脏的。 */
const source = readFileSync(resolve(root, 'v3_optimized.js'), 'utf8')
    .replace(/^﻿/, '')
    .replace(/\r\n/g, '\n');
const metadata = `// ==UserScript==
// @name         学习通自动刷课脚本 V3 稳定版
// @namespace    local.codex.xuexitong
// @version      3.5.0
// @description  自动播放、自动切换下一节；行为随机化以降低自动化特征，页面结构异常时安全停止
// @author       Codex
// @match        https://mooc1.chaoxing.com/mycourse/studentstudy*
// @match        https://*.chaoxing.com/mycourse/studentstudy*
// @match        https://*.chaoxing.com/mooc2-ans/mycourse/studentstudy*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

`;

writeFileSync(resolve(root, 'v3_optimized.user.js'), `${metadata}${source}`, 'utf8');
