/* ------------------------------------------------------------------
 * 两个入口（窗口版、终端版）共用的设置：上次选的平台、每个平台填过的值。
 *
 * 以前窗口版记在浏览器的 localStorage 里，换个入口就没了。现在放在系统的
 * 用户配置目录，哪个入口填的，另一个打开时都能预填。密码不存。
 * ------------------------------------------------------------------ */
import { homedir } from 'node:os';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export function settingsDir(platform = process.platform, env = process.env, home = homedir()) {
    if (platform === 'win32') return win32.join(env.APPDATA || win32.join(home, 'AppData', 'Roaming'), 'course-helper');
    if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support', 'course-helper');
    return posix.join(env.XDG_CONFIG_HOME || posix.join(home, '.config'), 'course-helper');
}

const keyOf = (option) => option.flag || option.key.join('.');

export function createSettings({ dir = settingsDir() } = {}) {
    const join = dir.includes('\\') ? win32.join : posix.join;
    const file = join(dir, 'settings.json');

    function read() {
        try {
            const data = JSON.parse(readFileSync(file, 'utf8'));
            return {
                picked: typeof data.picked === 'string' ? data.picked : null,
                values: data.values && typeof data.values === 'object' ? data.values : {},
            };
        } catch (e) {
            return { picked: null, values: {} };
        }
    }

    /* 先写临时文件再改名：两个入口不会同时开，但写到一半断电也不该留下坏文件 */
    function write(data) {
        mkdirSync(dir, { recursive: true });
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
        renameSync(tmp, file);
    }

    return {
        dir,
        file,
        read,
        /* 每个平台填过的值，密码一律不留 */
        valuesFor(id) {
            return read().values[id] || {};
        },
        pick(id) {
            const data = read();
            data.picked = id;
            write(data);
        },
        remember(tool, values) {
            const data = read();
            const kept = {};
            for (const option of tool.options) {
                const key = keyOf(option);
                if (option.type === 'password' || !(key in values)) continue;
                kept[key] = values[key];
            }
            data.picked = tool.id;
            data.values[tool.id] = kept;
            write(data);
        },
    };
}
