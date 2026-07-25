#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Absolute node path: launchd does not load nvm/homebrew shell PATH.
NODE_BIN="$(command -v node)"
TSX_CLI="$PROJECT_DIR/node_modules/tsx/dist/cli.mjs"
PLIST="$HOME/Library/LaunchAgents/com.amit.myschoolone-downloader.plist"
LOG_DIR="$PROJECT_DIR/.state"
# Daily run time, override with: ./scripts/install-launch-agent.sh HH MM
RUN_HOUR="${1:-19}"
RUN_MINUTE="${2:-30}"
# Catch-up trigger 2h later; daily.ts skips if the day's run already succeeded.
CATCHUP_HOUR=$(( (RUN_HOUR + 2) % 24 ))
mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

if [ ! -f "$TSX_CLI" ]; then
  echo "tsx not found. Run: npm install" >&2
  exit 1
fi

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.amit.myschoolone-downloader</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${TSX_CLI}</string>
    <string>src/daily.ts</string>
  </array>
  <key>WorkingDirectory</key><string>${PROJECT_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>${HOME}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <array>
    <dict>
      <key>Hour</key><integer>${RUN_HOUR}</integer>
      <key>Minute</key><integer>${RUN_MINUTE}</integer>
    </dict>
    <dict>
      <key>Hour</key><integer>${CATCHUP_HOUR}</integer>
      <key>Minute</key><integer>${RUN_MINUTE}</integer>
    </dict>
  </array>
  <key>StandardOutPath</key><string>${LOG_DIR}/launchd.out.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/launchd.err.log</string>
</dict>
</plist>
PLIST

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
printf 'Installed daily run at %02d:%02d (catch-up at %02d:%02d): %s\n' "$RUN_HOUR" "$RUN_MINUTE" "$CATCHUP_HOUR" "$RUN_MINUTE" "$PLIST"
echo "Logs: $LOG_DIR/launchd.out.log and launchd.err.log"

# Schedule the Mac to wake from sleep 5 minutes before the run (requires sudo).
WAKE_HOUR=$RUN_HOUR
WAKE_MINUTE=$(( RUN_MINUTE - 5 ))
if [ "$WAKE_MINUTE" -lt 0 ]; then WAKE_MINUTE=55; WAKE_HOUR=$(( (RUN_HOUR + 23) % 24 )); fi
printf -v WAKE_TIME '%02d:%02d:00' "$WAKE_HOUR" "$WAKE_MINUTE"
echo ""
echo "To wake the Mac from sleep automatically at $WAKE_TIME daily, run:"
echo "  sudo pmset repeat wakeorpoweron MTWRFSU $WAKE_TIME"
echo "(Enter your Mac password when prompted. The Mac must be plugged in.)"
