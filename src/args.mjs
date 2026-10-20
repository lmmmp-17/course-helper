/* ------------------------------------------------------------------
 * 把界面上填的值变成命令行参数 / 配置文件内容。
 *
 * 这一层单独拎出来是因为它最容易出错，而且不需要浏览器就能测：
 * 布尔选项不该在没勾时冒出一个 --no-xxx，数字框留空不该传一个空参数。
 * ------------------------------------------------------------------ */

/* flags 类工具：只传用户真正设过的选项 */
export function buildArgs(tool, values = {}) {
    const args = [];
    for (const option of tool.options) {
        const raw = values[option.flag];
        if (option.type === 'bool') {
            /* 开关只有勾上才传；没勾就是默认行为，不要显式传反向参数 */
            if (raw === true) args.push(option.flag);
            continue;
        }
        const value = raw === undefined || raw === null ? '' : String(raw).trim();
        if (!value) continue;
        /* 和默认值一样就不必传，命令行干净些 */
        if (option.default !== undefined && value === String(option.default)) continue;
        args.push(option.flag, value);
    }
    return args;
}

/* config 类工具：把值合并进 ini 文本，保留原有的注释和没动过的项 */
export function applyConfig(text, tool, values = {}) {
    const lines = text.split(/\r?\n/);
    const wanted = new Map();
    for (const option of tool.options) {
        const raw = values[option.key.join('.')];
        if (raw === undefined || raw === null) continue;
        let value = raw;
        if (option.type === 'bool') {
            /* invert: 界面上是"静音"，配置里也是 soundOff，含义一致；
             * 留这个开关是为了以后出现"界面说法和配置项相反"的情况 */
            const on = option.invert ? Boolean(raw) : Boolean(raw);
            value = on ? 'True' : 'False';
        }
        wanted.set(option.key.join('.'), { section: option.key[0], name: option.key[1], value: String(value) });
    }

    let section = '';
    const written = new Set();
    const out = lines.map((line) => {
        const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
        if (header) { section = header[1]; return line; }
        const entry = line.match(/^(\s*)([A-Za-z_][\w-]*)(\s*=\s*)(.*)$/);
        if (!entry) return line;
        const key = `${section}.${entry[2]}`;
        const hit = wanted.get(key);
        if (!hit) return line;
        written.add(key);
        /* 模板里空值那行写的是 "URL1 ="，分隔符不含尾随空格，直接拼会变成
         * "URL1 =https://…"。能读，但看着像坏了，所以补一个空格。 */
        const sep = !hit.value || entry[3].endsWith(' ') ? entry[3] : `${entry[3]} `;
        return `${entry[1]}${entry[2]}${sep}${hit.value}`;
    });

    /* 模板里没有的项补到对应段落末尾 */
    for (const [key, hit] of wanted) {
        if (written.has(key)) continue;
        const at = out.findIndex((line) => line.trim() === `[${hit.section}]`);
        if (at < 0) { out.push(`[${hit.section}]`, `${hit.name} = ${hit.value}`); continue; }
        let end = at + 1;
        while (end < out.length && !/^\s*\[[^\]]+\]\s*$/.test(out[end])) end += 1;
        out.splice(end, 0, `${hit.name} = ${hit.value}`);
    }
    return out.join('\n');
}

/* 必填项检查，返回缺了哪些（给界面提示用） */
export function missingRequired(tool, values = {}) {
    return tool.options
        .filter((option) => option.required)
        .filter((option) => {
            const key = option.flag || option.key.join('.');
            const value = values[key];
            return value === undefined || value === null || String(value).trim() === '';
        })
        .map((option) => option.label);
}
