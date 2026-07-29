#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Absolute node path: launchd does not load nvm/homebrew shell PATH.
NODE_BIN="$(command -v node)"
TSX_CLI="$PROJECT_DIR/node_modules/tsx/dist/cli.mjs"
PLIST="$HOME/Library/LaunchAgents/com.amit.myschoolone-downloader.plist"
# Prefer local state dir (outside iCloud) when configured in .env.
if [ -f "$PROJECT_DIR/.env" ]; then
  STATE_FROM_ENV="$(grep -E '^STATE_DIR=' "$PROJECT_DIR/.env" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  STATE_FROM_ENV="${STATE_FROM_ENV/#\~/$HOME}"
fi
LOG_DIR="${STATE_FROM_ENV:-$HOME/.local/share/myschoolone-downloader/state}"
# Two daily run times. Override with: ./scripts/install-launch-agent.sh HH MM HH MM
RUN1_HOUR="${1:-19}"
RUN1_MINUTE="${2:-30}"
RUN2_HOUR="${3:-$(( (RUN1_HOUR + 2) % 24 ))}"
RUN2_MINUTE="${4:-30}"
for v in RUN1_HOUR RUN1_MINUTE RUN2_HOUR RUN2_MINUTE; do
  if ! [[ "${!v}" =~ ^[0-9]+$ ]]; then
    echo "Usage: $0 [HOUR1 MIN1] [HOUR2 MIN2]   (defaults: 19 30, 21 30)" >&2
    exit 1
  fi
done
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
      <key>Hour</key><integer>${RUN1_HOUR}</integer>
      <key>Minute</key><integer>${RUN1_MINUTE}</integer>
    </dict>
    <dict>
      <key>Hour</key><integer>${RUN2_HOUR}</integer>
      <key>Minute</key><integer>${RUN2_MINUTE}</integer>
    </dict>
  </array>
  <key>StandardOutPath</key><string>${LOG_DIR}/launchd.out.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/launchd.err.log</string>
</dict>
</plist>
PLIST

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
printf 'Installed daily runs at %02d:%02d and %02d:%02d: %s\n' "$RUN1_HOUR" "$RUN1_MINUTE" "$RUN2_HOUR" "$RUN2_MINUTE" "$PLIST"
echo "Logs: $LOG_DIR/launchd.out.log and launchd.err.log"

# Schedule the Mac to wake from sleep 5 minutes before the first run (requires sudo).
WAKE_HOUR=$RUN1_HOUR
WAKE_MINUTE=$(( RUN1_MINUTE - 5 ))
if [ "$WAKE_MINUTE" -lt 0 ]; then WAKE_MINUTE=55; WAKE_HOUR=$(( (RUN1_HOUR + 23) % 24 )); fi
printf -v WAKE_TIME '%02d:%02d:00' "$WAKE_HOUR" "$WAKE_MINUTE"
echo ""
echo "To wake the Mac from sleep automatically at $WAKE_TIME daily, run:"
echo "  sudo pmset repeat wakeorpoweron MTWRFSU $WAKE_TIME"
echo "(Enter your Mac password when prompted. The Mac must be plugged in.)"
