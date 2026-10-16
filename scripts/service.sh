#!/bin/sh
# Run the supervised server as a macOS login service (launchd), so it starts when you
# log in and comes back after a reboot. The supervisor (scripts/supervise.js) restarts
# the server itself; launchd restarts the supervisor if that ever exits.
#
#   npm run service:install     install and start
#   npm run service:uninstall   stop and remove
#   npm run service:status      is it loaded, and the last log lines
set -e
LABEL=com.technext.energiebee-core
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"

case "$1" in
  install)
    MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
    if [ "$MAJOR" -lt 22 ]; then echo "Node 22.13 or newer is needed (found $("$NODE" -v) at $NODE). Run 'nvm use 22' first."; exit 1; fi
    mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/data/logs"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$ROOT/scripts/supervise.js</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>$ROOT/data/logs/supervisor-error.log</string>
</dict>
</plist>
EOF
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "Installed $LABEL using $NODE. Log: $ROOT/data/logs/server.log"
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed $LABEL."
    ;;
  status)
    if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then echo "$LABEL is loaded."; else echo "$LABEL is not loaded."; fi
    tail -n 5 "$ROOT/data/logs/server.log" 2>/dev/null || true
    ;;
  *)
    echo "usage: $0 install|uninstall|status"; exit 1 ;;
esac
