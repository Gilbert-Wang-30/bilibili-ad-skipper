#!/usr/bin/env bash
# Launches a throw-away Chrome profile with remote debugging, installs the unpacked extension through the
# DevTools protocol (Extensions.loadUnpacked — Chrome 126+, needs --enable-unsafe-extension-debugging) and opens a video.
# The scratch profile is not signed in, so bilibili serves it only a fraction of the danmaku a logged-in user gets.
# Usage: tools/launch-test-browser.sh [video-url]
# Env: CHROME (exe path), PROFILE (user-data-dir), CDP_PORT (default 9333), DENO (deno exe)
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
CHROME="${CHROME:-/c/Program Files/Google/Chrome/Application/chrome.exe}"
PROFILE="${PROFILE:-${TEMP:-/tmp}/bas-test-profile}"
CDP_PORT="${CDP_PORT:-9333}"
DENO="${DENO:-deno}"
URL="${1:-https://www.bilibili.com/video/BV1jCJs6UE9S/}"
mkdir -p "$PROFILE"
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi; }
ARGS="--user-data-dir=\"$(winpath "$PROFILE")\" --enable-unsafe-extension-debugging --remote-debugging-port=$CDP_PORT --no-first-run --no-default-browser-check --mute-audio --window-size=1366,900 --autoplay-policy=no-user-gesture-required about:blank"

if command -v powershell >/dev/null 2>&1; then
  # Stop a previous scratch instance (only processes using this profile dir), then start Chrome through WMI so it is
  # not a child of this shell (a plain background job is killed when the calling tool's shell exits).
  powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'chrome.exe' -and \$_.CommandLine -like '*$(basename "$PROFILE")*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" || true
  sleep 1
  powershell -NoProfile -Command "\$cmd = '\"$(winpath "$CHROME")\" ' + '$ARGS'; Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = \$cmd } | Out-Null"
else
  eval "nohup \"$CHROME\" $ARGS >/dev/null 2>&1 &"
fi
for i in $(seq 1 40); do curl -s "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 && break; sleep 0.5; done
export CDP_PORT
EXT_ID=$("$DENO" run --allow-net --allow-write --allow-read --allow-env "$HERE/tools/cdp.js" loadext "$(winpath "$HERE")" | tr -d '\r' | sed -n 's/.*"id": "\([a-z]*\)".*/\1/p')
echo "extension id: $EXT_ID   (export BAS_EXT_ID=$EXT_ID to use 'cdp.js evalcs')"
"$DENO" run --allow-net --allow-write --allow-read --allow-env "$HERE/tools/cdp.js" new "$URL"
