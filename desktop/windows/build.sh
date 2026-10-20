#!/usr/bin/env bash
# 编译 Windows 窗口版外壳（网课助手.exe）。在 Linux / macOS 上交叉编译即可，不需要 Windows。
#
# 用法：desktop/windows/build.sh [版本号] [输出目录]
#   版本号默认 0.0.0；输出目录默认仓库根目录（exe 要和 launcher\ 放在一起才能用）
# 需要：Go（go.mod 里写的版本）、go-winres（go install github.com/tc-hib/go-winres@v0.3.3）
set -euo pipefail
cd "$(dirname "$0")"
VERSION="${1:-0.0.0}"
OUT="${2:-../..}"
WINRES="$(command -v go-winres || echo "$(go env GOPATH)/bin/go-winres")"
if [ ! -x "$WINRES" ]; then
    echo "[错误] 没找到 go-winres，先执行：go install github.com/tc-hib/go-winres@v0.3.3" >&2
    exit 1
fi
# 图标、清单（DPI 感知、新版控件样式）、版本信息 → rsrc_windows_amd64.syso，go build 会自动带上
"$WINRES" make --arch amd64 --file-version "$VERSION" --product-version "$VERSION"
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-H windowsgui -s -w" -o "$OUT/网课助手.exe" .
echo "已生成 $OUT/网课助手.exe"
