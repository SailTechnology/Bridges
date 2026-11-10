#!/bin/sh
set -eu
BRIDGES_PACKAGE_DIR=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && pwd)
BRIDGES_INSTALL_DIR="$HOME/Projects/Bridges"
/bin/mkdir -p "$BRIDGES_INSTALL_DIR"
if [ -f "$BRIDGES_INSTALL_DIR/neo-agent.sh" ]; then
  /bin/cp -p "$BRIDGES_INSTALL_DIR/neo-agent.sh" "$BRIDGES_INSTALL_DIR/neo-agent-$(/bin/date +%Y%m%d-%H%M%S).sh.bak"
fi
/bin/cp "$BRIDGES_PACKAGE_DIR/neo-agent.sh" "$BRIDGES_INSTALL_DIR/neo-agent.sh"
/bin/chmod 700 "$BRIDGES_INSTALL_DIR/neo-agent.sh"
/bin/sh "$BRIDGES_INSTALL_DIR/neo-agent.sh" health
printf '\n现场助手已安装。远程登录和 SSH 配对仍需按说明完成。\n'
printf '按回车关闭。'; IFS= read -r BRIDGES_DONE
