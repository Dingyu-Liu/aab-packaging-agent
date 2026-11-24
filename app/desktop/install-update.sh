#!/bin/bash
# Runs outside the application bundle so replacing the bundle cannot replace this process.
set -u
parent_pid="$1"
target="$2"
candidate="$3"
backup="$4"
update_root="$5"
install_id="$6"
version="$7"
data_dir="$8"
ready="$update_root/ready-$install_id"
result="$update_root/install-result.json"
log="$update_root/install-$install_id.log"
exec >>"$log" 2>&1
report() { printf '{"status":"%s","version":"%s","message":"%s"}\n' "$1" "$version" "$2" > "$result.tmp"; /bin/mv -f "$result.tmp" "$result"; }
launch() {
  unset ELECTRON_RUN_AS_NODE NODE_OPTIONS NODE_PATH
  PARTNER_AGENT_DATA_DIR="$data_dir" "$target/Contents/MacOS/Partner Agent" >>"$log" 2>&1 &
  launched_pid=$!
  printf '%s\n' "$launched_pid" > "$update_root/relaunch-$install_id.pid"
}
for ((i=0;i<240;i++)); do
  if ! /bin/kill -0 "$parent_pid" 2>/dev/null; then break; fi
  /bin/sleep 0.25
done
if /bin/kill -0 "$parent_pid" 2>/dev/null; then report failed '旧版 App 未退出，已取消安装。'; exit 1; fi
if ! /bin/mv "$target" "$backup"; then report failed '无法备份旧版 App，请确认安装目录可写。'; launch; exit 1; fi
if ! /bin/mv "$candidate" "$target"; then
  /bin/mv "$backup" "$target"
  report rolled_back '新版 App 替换失败，已恢复旧版。'
  launch
  exit 1
fi
launch
for ((i=0;i<360;i++)); do
  if [ -f "$ready" ]; then report installed '更新已安装，App 已重新启动。'; exit 0; fi
  if ! /bin/kill -0 "$launched_pid" 2>/dev/null; then break; fi
  /bin/sleep 0.25
done
children="$(/usr/bin/pgrep -P "$launched_pid" 2>/dev/null || true)"
/bin/kill -TERM "$launched_pid" 2>/dev/null || true
for ((i=0;i<20;i++)); do
  if ! /bin/kill -0 "$launched_pid" 2>/dev/null; then break; fi
  /bin/sleep 0.25
done
/bin/kill -KILL "$launched_pid" 2>/dev/null || true
for child_pid in $children; do /bin/kill -TERM "$child_pid" 2>/dev/null || true; done
if /bin/mv "$target" "$candidate" && /bin/mv "$backup" "$target"; then
  report rolled_back '新版 App 启动失败，已自动恢复旧版。'
  launch
else
  report failed '自动恢复未完成，请从备份重新安装 App。'
fi
exit 1
