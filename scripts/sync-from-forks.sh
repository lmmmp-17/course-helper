#!/usr/bin/env bash
# 把三个 fork 的最新提交同步进来（维护者用，普通使用不需要）。
#
# 效果和 `git subtree pull --prefix=<目录> <仓库> <分支> --squash` 一样，提交格式也一样，
# 装了 git-subtree 的话两种方式可以混用。单独写一份是因为不少发行版的 git 不带 subtree。
#
# 用法：scripts/sync-from-forks.sh            同步全部
#       scripts/sync-from-forks.sh autovisor  只同步一个
set -euo pipefail
cd "$(dirname "$0")/.."

# 目录 仓库 分支
FORKS=(
    "xuexitong https://github.com/lmmmp-17/xuexitongScript feat/low-fingerprint-playwright"
    "yuketang  https://github.com/lmmmp-17/yuketang feat/real-browser"
    "autovisor https://github.com/lmmmp-17/Autovisor feat/low-fingerprint-cross-platform"
)

if [ -n "$(git status --porcelain)" ]; then
    echo "工作区有没提交的改动，先提交或暂存再同步。" >&2
    exit 1
fi

sync_one() {
    local prefix=$1 repo=$2 branch=$3
    # 上一次同步留下的 squash 提交：它的尾注里记着同步到了 fork 的哪个提交
    local last old new tree squash
    last=$(git log --grep="^git-subtree-dir: $prefix\$" -1 --format=%H)
    if [ -z "$last" ]; then
        echo "$prefix：找不到上一次同步的记录（git-subtree-dir: $prefix）" >&2
        return 1
    fi
    old=$(git log -1 --format=%B "$last" | sed -n "s/^git-subtree-split: //p")
    git fetch -q "$repo" "$branch"
    new=$(git rev-parse FETCH_HEAD)
    if [ "$old" = "$new" ]; then
        echo "$prefix：已是最新（${new:0:7}）"
        return 0
    fi
    tree=$(git rev-parse "FETCH_HEAD^{tree}")
    squash=$({
        printf "Squashed '%s/' changes from %s..%s\n\n" "$prefix" "${old:0:7}" "${new:0:7}"
        git log --format='%h %s' "$old..$new" 2>/dev/null || true
        printf "\ngit-subtree-dir: %s\ngit-subtree-split: %s\n" "$prefix" "$new"
    } | git commit-tree "$tree" -p "$last")
    # 上一次的 squash 提交就是合并基点，-Xsubtree 把它的根目录对到 $prefix/ 上
    git merge -q -Xsubtree="$prefix" --no-edit -m "Merge commit '$squash' as '$prefix'" "$squash"
    echo "$prefix：${old:0:7} → ${new:0:7}"
}

for entry in "${FORKS[@]}"; do
    read -r prefix repo branch <<<"$entry"
    if [ $# -gt 0 ] && [ "$1" != "$prefix" ]; then continue; fi
    sync_one "$prefix" "$repo" "$branch"
done
