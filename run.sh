#!/usr/bin/env bash
# macOS / Linux 源码运行入口: 首次运行自动部署环境, 之后直接启动。
set -euo pipefail

cd "$(dirname "$0")"

case "$(uname -s)" in
    Darwin) PLATFORM=macos ;;
    Linux)  PLATFORM=linux ;;
    *)
        echo "[ERROR] 不支持的系统: $(uname -s). Windows 请双击 run.cmd." >&2
        exit 1
        ;;
esac

STAMP_DIR=".autovisor"
STAMP_FILE="$STAMP_DIR/env.ready"

# 读取 ini 配置项（跳过注释行）
ini_value() {
    local file="$1" key="$2" target
    target=$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')
    awk -v target="$target" '
        BEGIN { FS = "=" }
        /^[[:space:]]*[;#]/ { next }
        {
            name = $1
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
            if (tolower(name) == target) {
                value = $2
                for (i = 3; i <= NF; i++) value = value "=" $i
                gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
                print value
                exit
            }
        }
    ' "$file"
}

# 解析参数：识别 --config 与自身开关 --setup(不转发给程序)
force_setup=false
has_config=false
config_file=""
forward=()
args=("$@")
idx=0
while [ "$idx" -lt "${#args[@]}" ]; do
    cur="${args[$idx]}"
    case "$cur" in
        --setup)
            force_setup=true
            ;;
        --config=*)
            has_config=true
            config_file="${cur#--config=}"
            forward+=("$cur")
            ;;
        --config)
            has_config=true
            config_file="${args[$((idx + 1))]:-}"
            forward+=("$cur")
            if [ "$((idx + 1))" -lt "${#args[@]}" ]; then
                forward+=("${args[$((idx + 1))]}")
                idx=$((idx + 1))
            fi
            ;;
        *)
            forward+=("$cur")
            ;;
    esac
    idx=$((idx + 1))
done
if [ -z "$config_file" ]; then
    config_file="config.$PLATFORM.ini"
fi
if [ "$has_config" = true ]; then
    set -- ${forward[@]+"${forward[@]}"}
else
    set -- --config "$config_file" ${forward[@]+"${forward[@]}"}
fi

# 计算 sha256: macOS 自带 shasum, 不少 Linux 发行版只有 sha256sum
sha256() {
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$@"
    else
        sha256sum "$@"
    fi
}

# 确保 uv 可用
ensure_uv() {
    if command -v uv >/dev/null 2>&1; then
        echo "[setup] 使用已安装的 uv: $(command -v uv)"
        return 0
    fi
    echo "[setup] 未检测到 uv, 正在自动安装..."
    if [ "$PLATFORM" = macos ] && command -v brew >/dev/null 2>&1; then
        echo "[setup] 通过 Homebrew 安装 uv..."
        brew install uv
        return 0
    fi
    echo "[setup] 使用官方脚本安装 uv..."
    if ! curl -LsSf https://astral.sh/uv/install.sh | sh; then
        # 官方脚本从 GitHub 下载, 国内很多网络上很慢或者连不上
        echo "[setup] 官方脚本没装上, 改从国内的 PyPI 镜像下载 uv..."
        install_uv_from_mirror || {
            echo "[ERROR] uv 安装失败, 请手动安装后重试: $(uv_hint)" >&2
            exit 1
        }
    fi
    if [ -x "$HOME/.local/bin/uv" ]; then
        export PATH="$HOME/.local/bin:$PATH"
    elif [ -x "$HOME/.cargo/bin/uv" ]; then
        export PATH="$HOME/.cargo/bin:$PATH"
    fi
    command -v uv >/dev/null 2>&1 || {
        echo "[ERROR] 未能找到 uv 可执行文件, 请手动安装后重试: $(uv_hint)" >&2
        exit 1
    }
}

# uv 也以 wheel 的形式发布在 PyPI 上, 里面带着 uv 可执行文件, 而 PyPI 在国内有镜像.
# 取最新的、适合本机的 wheel, 校验 sha256 后把 uv、uvx 放进 ~/.local/bin
# (和官方脚本装的位置一样). Windows 上的同一件事见 resources/install-uv.ps1
install_uv_from_mirror() {
    command -v python3 >/dev/null 2>&1 || return 1
    python3 - "$HOME/.local/bin" <<'PY'
import hashlib, io, os, platform, re, stat, sys, urllib.parse, urllib.request, zipfile

bin_dir = sys.argv[1]
machine = platform.machine().lower()
arch = {"amd64": "x86_64", "arm64": "aarch64"}.get(machine, machine)
if sys.platform == "darwin":
    wanted = lambda tag: tag.startswith("macosx") and tag.endswith("arm64" if arch == "aarch64" else "x86_64")
else:
    wanted = lambda tag: "manylinux" in tag and tag.endswith(arch)

# 镜像拒绝不带 User-Agent 的请求 (Windows 上实测 403), 显式带一个
def fetch(url, timeout):
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 course-helper (uv installer)"})
    return urllib.request.urlopen(request, timeout=timeout).read()

for index in ("https://pypi.tuna.tsinghua.edu.cn/simple/uv/", "https://mirrors.aliyun.com/pypi/simple/uv/"):
    try:
        page = fetch(index, 30).decode("utf-8", "replace")
        best = None
        for href in re.findall(r'href="([^"]+)"', page):
            m = re.search(r"/uv-(\d+)\.(\d+)\.(\d+)-py3-none-([^/#]+)\.whl#sha256=([0-9a-f]{64})$", href)
            if m and wanted(m.group(4)):
                version = tuple(int(x) for x in m.group(1, 2, 3))
                if best is None or version > best[0]:
                    best = (version, href, m.group(5))
        if best is None:
            raise RuntimeError("no wheel for this machine")
        url = urllib.parse.urljoin(index, best[1].split("#")[0])
        data = fetch(url, 600)
        if hashlib.sha256(data).hexdigest() != best[2]:
            raise RuntimeError("checksum mismatch")
        os.makedirs(bin_dir, exist_ok=True)
        with zipfile.ZipFile(io.BytesIO(data)) as wheel:
            for name in wheel.namelist():
                if re.search(r"\.data/scripts/uvx?$", name):
                    target = os.path.join(bin_dir, os.path.basename(name))
                    with open(target, "wb") as out:
                        out.write(wheel.read(name))
                    os.chmod(target, os.stat(target).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        print("[setup] uv %s <- %s" % (".".join(map(str, best[0])), index))
        sys.exit(0)
    except Exception as exc:
        print("[setup] 从 %s 没装上 uv: %s" % (index, exc))
sys.exit(1)
PY
}

uv_hint() {
    if [ "$PLATFORM" = macos ]; then
        echo "brew install uv"
    else
        echo "curl -LsSf https://astral.sh/uv/install.sh | sh"
    fi
}

# 首次部署：根据配置安装依赖与浏览器
deploy() {
    local cfg="$1"
    if [ ! -f "$cfg" ]; then
        echo "[ERROR] 未找到配置文件: $cfg" >&2
        echo "[ERROR] 请先复制模板并编辑: cp config.$PLATFORM.ini.example $cfg" >&2
        exit 1
    fi
    chmod 600 "$cfg"

    ensure_uv

    local captcha driver extra=""
    captcha=$(ini_value "$cfg" enableAutoCaptcha | tr '[:upper:]' '[:lower:]')
    driver=$(ini_value "$cfg" driver | tr '[:upper:]' '[:lower:]')
    case "$captcha" in
        true|1|yes|on) extra="--extra captcha" ;;
    esac
    echo "[setup] 安装 Python 依赖 (uv sync $extra)..."
    # 先走官方源; 不行再换国内镜像 (清华 PyPI 装依赖, npmmirror 装 Python).
    # 不默认走镜像: 那样 uv 会把 uv.lock 里的下载地址改写成镜像的, git 工作区就脏了
    # (版本不变, 实测). 用户自己设过镜像变量的话不换.
    if ! uv sync $extra; then
        if [ -n "${UV_DEFAULT_INDEX:-}${UV_PYTHON_INSTALL_MIRROR:-}" ]; then
            exit 1
        fi
        echo "[setup] 官方源没装上, 改用国内镜像 (清华 PyPI、npmmirror) 再试一次..."
        export UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple
        export UV_PYTHON_INSTALL_MIRROR=https://registry.npmmirror.com/-/binary/python-build-standalone
        uv sync $extra
    fi

    case "$driver" in
        chromium)
            echo "[setup] 检测到 driver = chromium, 安装 Playwright Chromium..."
            uv run playwright install chromium
            if [ "$PLATFORM" = linux ]; then
                echo "[setup] 若启动时报缺少系统库, 执行: sudo uv run playwright install-deps chromium"
            fi
            ;;
        *)
            echo "[setup] 使用系统浏览器(默认 Chrome), 无需下载 Playwright 浏览器。"
            ;;
    esac
}

# 环境指纹: pyproject + lock + 配置 任一变化时重新部署
signature() {
    {
        if [ -f pyproject.toml ]; then
            sha256 pyproject.toml uv.lock 2>/dev/null | awk '{print $1}'
        fi
        if [ -f "$config_file" ]; then
            sha256 "$config_file" 2>/dev/null | awk '{print $1}'
        fi
    } | sha256 | awk '{print $1}'
}

# 第一次运行：没有配置文件就从模板生成一份，接着往下跑。
# 课程地址可以不填：登录后在浏览器里点开一门课就会开始。
if [ ! -f "$config_file" ] && [ "$config_file" = "config.$PLATFORM.ini" ] && [ -f "config.$PLATFORM.ini.example" ]; then
    cp "config.$PLATFORM.ini.example" "$config_file"
    chmod 600 "$config_file"
    echo "[setup] 已从模板生成配置文件 $config_file，想改设置可以用文本编辑器打开它"
fi

# 上次是靠国内镜像装上的 (uv.lock 里记着镜像的地址): 接着用镜像.
# 不然下面的 uv run 会把 uv.lock 改回官方源再解析一遍, 连不上官方源时直接失败
if [ -z "${UV_DEFAULT_INDEX:-}${UV_PYTHON_INSTALL_MIRROR:-}" ] && grep -q "pypi.tuna.tsinghua.edu.cn" uv.lock 2>/dev/null; then
    export UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple
    export UV_PYTHON_INSTALL_MIRROR=https://registry.npmmirror.com/-/binary/python-build-standalone
fi

if [ "$force_setup" = true ]; then
    echo "===== Autovisor 强制环境部署 ====="
    deploy "$config_file"
elif [ -f "$STAMP_FILE" ] && [ "$(cat "$STAMP_FILE")" = "$(signature)" ]; then
    echo "[run] 环境已就绪, 直接启动."
else
    echo "===== Autovisor 首次/变更环境部署 ====="
    deploy "$config_file"
    mkdir -p "$STAMP_DIR"
    chmod 700 "$STAMP_DIR"
    printf '%s' "$(signature)" > "$STAMP_FILE"
fi

exec uv run python -u Autovisor.py "$@"