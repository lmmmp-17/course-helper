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
            /* 开关只有勾上才传；没勾就是默认行为，不要显式传反向参数。
             * invert：界面上的说法和参数相反（界面「静音」、参数 --no-mute），
             * 这时是「明确取消勾选」才传；没传值就是默认，什么也不加。 */
            const send = option.invert ? raw === false : raw === true;
            if (send) args.push(option.flag);
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
        /* 留空 = 保持原样。不然没填密码就会把配置里存着的密码清掉 */
        if (option.type !== 'bool' && String(raw).trim() === '') continue;
        const value = option.type === 'bool' ? (raw ? 'True' : 'False') : String(raw).trim();
        /* 键名按小写比：configparser 不分大小写，而且它写回文件时会全转成小写
         * （上游 GUI.py 存过的配置就是 enablehidewindow 这样）。按原样比的话会
         * 认为键不存在、再追加一行，configparser 读到重复键直接报错。 */
        wanted.set(option.key.join('.').toLowerCase(), { section: option.key[0], name: option.key[1], value });
    }

    let section = '';
    const written = new Set();
    const out = lines.map((line) => {
        const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
        if (header) { section = header[1].trim(); return line; }
        const entry = line.match(/^(\s*)([A-Za-z_][\w-]*)(\s*=\s*)(.*)$/);
        if (!entry) return line;
        const key = `${section}.${entry[2]}`.toLowerCase();
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
        const at = out.findIndex((line) => line.trim().toLowerCase() === `[${hit.section.toLowerCase()}]`);
        if (at < 0) { out.push(`[${hit.section}]`, `${hit.name} = ${hit.value}`); continue; }
        let end = at + 1;
        while (end < out.length && !/^\s*\[[^\]]+\]\s*$/.test(out[end])) end += 1;
        out.splice(end, 0, `${hit.name} = ${hit.value}`);
    }
    return out.join('\n');
}

/* 从已有的 ini 里读出界面上那几项的当前值，用来预填表单。
 * 键名不分大小写（configparser 也不分）；密码不读，不往页面上送。 */
export function readConfig(text, tool) {
    const found = new Map();
    let section = '';
    for (const line of text.split(/\r?\n/)) {
        const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
        if (header) { section = header[1].trim().toLowerCase(); continue; }
        const entry = line.match(/^\s*([A-Za-z_][\w-]*)\s*=\s*(.*?)\s*$/);
        if (entry) found.set(`${section}.${entry[1].toLowerCase()}`, entry[2]);
    }
    const out = {};
    for (const option of tool.options) {
        if (!option.key || option.type === 'password') continue;
        const raw = found.get(option.key.join('.').toLowerCase());
        if (raw === undefined || raw === '') continue;
        if (option.type === 'bool') {
            out[option.key.join('.')] = /^(true|1|yes|on)$/i.test(raw);
            continue;
        }
        /* 选项按登记表里的写法回传：配置里写的可能是 edge，界面上的单选值是 Edge */
        const choice = option.choices?.find((item) => item.value.toLowerCase() === raw.toLowerCase());
        out[option.key.join('.')] = choice ? choice.value : raw;
    }
    return out;
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
