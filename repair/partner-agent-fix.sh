#!/bin/sh
# AAB助手启动修复：仅清除指定应用及内部文件的下载隔离标记。
# 用法：/bin/sh partner-agent-fix.sh [目标 App 路径]
# 不指定路径时依次查找：脚本同目录、系统应用程序、当前用户的应用程序目录。
# 退出码：0 已修复；10 无需修复；11 找不到应用；12 清除失败。
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
if [ "$#" -gt 0 ]; then
    APP="$1"
else
    SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
    APP=""
    for candidate in "$SCRIPT_DIR/AAB助手.app" "/Applications/AAB助手.app" "$HOME/Applications/AAB助手.app"; do
        if [ -d "$candidate" ]; then APP="$candidate"; break; fi
    done
fi
if [ -z "$APP" ] || [ ! -d "$APP" ]; then
    echo "找不到 AAB助手.app。请将脚本放到应用旁边，或在脚本后指定 App 路径。"
    exit 11
fi
case "$APP" in *.app|*.app/) ;; *) echo "请选择目标 .app 应用。"; exit 11 ;; esac
# 检查所有内部文件，兼容仅子文件带隔离标记的情况。
if ! xattr -r "$APP" 2>/dev/null | grep -q 'com.apple.quarantine'; then
    echo "无需修复：应用及内部文件没有隔离标记。"
    exit 10
fi
if ! xattr -dr com.apple.quarantine "$APP" >/dev/null 2>&1; then
    echo "清除失败：请检查该应用及内部文件的写入权限。"
    exit 12
fi
if xattr -r "$APP" 2>/dev/null | grep -q 'com.apple.quarantine'; then
    echo "清除失败：部分文件仍有隔离标记。"
    exit 12
fi
echo "已清除隔离标记：$APP"
exit 0
