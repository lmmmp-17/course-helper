#!/usr/bin/env bash
# 保留旧入口: 逻辑已并入同时支持 macOS 与 Linux 的 run.sh
exec "$(dirname "$0")/run.sh" "$@"
