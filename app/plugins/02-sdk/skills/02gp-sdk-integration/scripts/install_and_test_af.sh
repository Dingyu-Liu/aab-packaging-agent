#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "usage: $0 <apk> <test-package> [serial] [--fresh]" >&2
    echo "env: ADB, ACTIVITY, WAIT_SECONDS, LOG_OUT, AF_TAG" >&2
    exit 2
}

[[ $# -ge 2 ]] || usage
APK=$1
PACKAGE=$2
SERIAL=${3:-}
FRESH=0
for arg in "$@"; do
    [[ "$arg" == "--fresh" ]] && FRESH=1
done

ADB=${ADB:-adb}
ACTIVITY=${ACTIVITY:-com.unity3d.player.UnityPlayerGameActivity}
WAIT_SECONDS=${WAIT_SECONDS:-20}
AF_TAG=${AF_TAG:-AppsFlyer_6.18.1}
LOG_OUT=${LOG_OUT:-"$(pwd)/af-device-test.log"}

[[ "$PACKAGE" == *.test ]] || { echo "refusing non-test package: $PACKAGE" >&2; exit 1; }
[[ -f "$APK" ]] || { echo "APK not found: $APK" >&2; exit 1; }

if [[ -n "$SERIAL" ]]; then
    ADB_SERIAL=(-s "$SERIAL")
else
    ADB_SERIAL=()
fi

"$ADB" "${ADB_SERIAL[@]}" get-state >/dev/null
if [[ "$FRESH" -eq 1 ]]; then
    "$ADB" "${ADB_SERIAL[@]}" uninstall "$PACKAGE" >/dev/null 2>&1 || true
fi
"$ADB" "${ADB_SERIAL[@]}" install -r "$APK"
"$ADB" "${ADB_SERIAL[@]}" logcat -c
for tag in Unity "$AF_TAG" AFLogger AppsFlyer; do
    "$ADB" "${ADB_SERIAL[@]}" shell setprop "log.tag.$tag" V
done
"$ADB" "${ADB_SERIAL[@]}" shell am force-stop "$PACKAGE"
"$ADB" "${ADB_SERIAL[@]}" shell am start -W -n "$PACKAGE/$ACTIVITY"
sleep "$WAIT_SECONDS"

"$ADB" "${ADB_SERIAL[@]}" logcat -d > "$LOG_OUT"
echo "log: $LOG_OUT"
grep -aE 'Partner02Demo|AppsFlyer|AFLogger|response code|onConversion|Launch status|\[PA\]' "$LOG_OUT" | tail -200 || true
