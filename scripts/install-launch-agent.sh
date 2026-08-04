#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
TSX_CLI="$PROJECT_DIR/node_modules/tsx/dist/cli.mjs"
LABEL="com.amit.myschoolone-downloader"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

if [ -f "$PROJECT_DIR/.env" ]; then
  STATE_FROM_ENV="$(grep -E '^STATE_DIR=' "$PROJECT_DIR/.env" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  STATE_FROM_ENV="${STATE_FROM_ENV/#\~/$HOME}"
fi
LOG_DIR="${STATE_FROM_ENV:-$HOME/.local/share/myschoolone-downloader/state}"

if [ ! -f "$TSX_CLI" ]; then
  echo "tsx not found. Run: npm install" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

# Single source of truth for schedule times: src/schedule-window.ts.
CALENDAR_ENTRIES="$(
  cd "$PROJECT_DIR" \
  && "$NODE_BIN" --import tsx --input-type=module -e '
    import { schedulerCalendarTimes } from "./src/schedule-window.ts";
    process.stdout.write(
      schedulerCalendarTimes()
        .map((t) => `    <dict>\n      <key>Hour</key><integer>${t.hour}</integer>\n      <key>Minute</key><integer>${t.minute}</integer>\n    </dict>`)
        .join("\n") + "\n",
    );
  ' 2>/dev/null
)"
SCHEDULE_LABEL="$(
  cd "$PROJECT_DIR" \
  && "$NODE_BIN" --import tsx --input-type=module -e '
    import { schedulerCalendarTimes } from "./src/schedule-window.ts";
    process.stdout.write(
      schedulerCalendarTimes()
        .map((t) => `${t.hour}:${String(t.minute).padStart(2, "0")}`)
        .join(" and "),
    );
  ' 2>/dev/null
)"
if [ -z "$CALENDAR_ENTRIES" ]; then
  echo "Warning: could not read schedule times from src/schedule-window.ts; using defaults 15:00 and 21:00." >&2
  CALENDAR_ENTRIES='    <dict>
      <key>Hour</key><integer>15</integer>
      <key>Minute</key><integer>0</integer>
    </dict>
    <dict>
      <key>Hour</key><integer>21</integer>
      <key>Minute</key><integer>0</integer>
    </dict>'
  SCHEDULE_LABEL="15:00 and 21:00"
fi

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${TSX_CLI}</string>
    <string>src/scheduled.ts</string>
  </array>
  <key>WorkingDirectory</key><string>${PROJECT_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>${HOME}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StartCalendarInterval</key>
  <array>
$(printf '%b' "$CALENDAR_ENTRIES")  </array>
  <key>StandardOutPath</key><string>${LOG_DIR}/launchd.out.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/launchd.err.log</string>
</dict>
</plist>
PLIST

plutil -lint "$PLIST"
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

TRIGGER_COUNT="$(printf '%s' "$CALENDAR_ENTRIES" | grep -c '<dict>')"
echo "Installed ${LABEL}: ${SCHEDULE_LABEL} IST on weekdays (${TRIGGER_COUNT} calendar triggers)."
echo "RunAtLoad is enabled for weekday-window catch-up after login/reboot."
echo "Logs: $LOG_DIR/launchd.out.log and $LOG_DIR/launchd.err.log"
echo "If the Mini might sleep, wake it five minutes before the window:"
echo "  sudo pmset repeat wakeorpoweron MTWRFSU 12:55:00"
