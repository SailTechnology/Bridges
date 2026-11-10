#!/bin/sh
set -eu
BRIDGES_CLIENT_ROOT="$HOME/Library/Application Support/Bridges"
/bin/mkdir -p "$BRIDGES_CLIENT_ROOT"
BRIDGES_URL_FILE="$BRIDGES_CLIENT_ROOT/windows-url.txt"
if [ ! -f "$BRIDGES_URL_FILE" ]; then
  printf '请输入 Windows Bridges 的 Tailscale HTTPS 地址（见接入说明）：\n'
  IFS= read -r BRIDGES_WINDOWS_URL
  case "$BRIDGES_WINDOWS_URL" in
    https://*.ts.net:*|https://*.ts.net|http://127.0.0.1:*) ;;
    *) printf '地址需要是 Tailscale HTTPS 地址，或本机 SSH 转发地址。\n' >&2; exit 1 ;;
  esac
  printf '%s\n' "$BRIDGES_WINDOWS_URL" > "$BRIDGES_URL_FILE"
fi
IFS= read -r BRIDGES_WINDOWS_URL < "$BRIDGES_URL_FILE"
exec /usr/bin/open "$BRIDGES_WINDOWS_URL"
