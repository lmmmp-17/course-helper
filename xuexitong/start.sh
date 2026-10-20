#!/usr/bin/env bash
# 学习通 Playwright 版的入口（Linux / macOS）。
# 第一次运行会自动安装依赖；连不上浏览器时会自动启动一个专用的 Chrome（没装就用 Edge）。
# 参数原样传给 run.mjs，比如 ./start.sh --max-sections 1
set -euo pipefail
cd "$(dirname "$0")/playwright"

if ! command -v node >/dev/null 2>&1; then
    echo "[错误] 没找到 Node.js（需要 20 或更新）。" >&2
    case "$(uname -s)" in
        Darwin) echo "  安装：brew install node，或者到 https://nodejs.org 下载 LTS 版" >&2 ;;
        *)      echo "  安装：用系统的包管理器装 nodejs（20 以上），或者到 https://nodejs.org 下载 LTS 版" >&2 ;;
    esac
    exit 1
fi
if [ "$(node -p 'parseInt(process.versions.node)')" -lt 20 ]; then
    echo "[错误] Node.js 版本太旧（当前 $(node -v)，需要 20 或更新），请到 https://nodejs.org 下载 LTS 版。" >&2
    exit 1
fi

exec node run.mjs "$@"
