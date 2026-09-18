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

# Prefer the compiled build (dist/) so the LaunchAgent does not depend on tsx
# at runtime. dist/ is far smaller than node_modules and is not affected by
# iCloud evicting individual package files. Fall back to tsx + src/ when the
# project has not been built yet.
if [ -f "$PROJECT_DIR/dist/scheduled.js" ]; then
  PROGRAM_ARGS="$(printf '    <string>%s</string>\n    <string>%s</string>' "$NODE_BIN" "$PROJECT_DIR/dist/scheduled.js")"
  RUN_MODE="compiled (dist/scheduled.js)"
else
  if [ ! -f "$TSX_CLI" ]; then
    echo "Neither dist/scheduled.js nor tsx was found." >&2
    echo "Build it (npm run build) or install dependencies (npm install), then rerun." >&2
    exit 1
  fi
  PROGRAM_ARGS="$(printf '    <string>%s</string>\n    <string>%s</string>\n    <string>src/scheduled.ts</string>' "$NODE_BIN" "$TSX_CLI")"
  RUN_MODE="tsx (src/scheduled.ts) — run 'npm run build' for a tsx-free runtime"
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

# Single source of truth for schedule times: src/schedule-window.ts. Read it
# with the compiled module when available, otherwise through tsx.
SCHEDULE_MODULE="./dist/schedule-window.js"
if [ ! -f "$PROJECT_DIR/dist/schedule-window.js" ]; then
  SCHEDULE_MODULE="./src/schedule-window.ts"
  schedule_snippet() {
    cd "$PROJECT_DIR" && "$NODE_BIN" --import tsx --input-type=module -e "$1"
  }
else
  schedule_snippet() {
    cd "$PROJECT_DIR" && "$NODE_BIN" --input-type=module -e "$1"
  }
fi

CALENDAR_ENTRIES="$(
  schedule_snippet "
    import { schedulerCalendarTimes } from '${SCHEDULE_MODULE}';
    process.stdout.write(
      schedulerCalendarTimes()
        .map((t) => \`    <dict>\n      <key>Hour</key><integer>\${t.hour}</integer>\n      <key>Minute</key><integer>\${t.minute}</integer>\n    </dict>\`)
        .join('\n') + '\n',
    );
  " 2>/dev/null
)"
SCHEDULE_LABEL="$(
  schedule_snippet "
    import { schedulerCalendarTimes } from '${SCHEDULE_MODULE}';
    process.stdout.write(
      schedulerCalendarTimes()
        .map((t) => \`\${t.hour}:\${String(t.minute).padStart(2, '0')}\`)
        .join(' and '),
    );
  " 2>/dev/null
)"
if [ -z "$CALENDAR_ENTRIES" ]; then
  echo "Warning: could not read schedule times from schedule-window; using defaults 15:00 and 21:00." >&2
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
${PROGRAM_ARGS}
  </array>
  <key>WorkingDirectory</key><string>${PROJECT_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>${HOME}</string>
    <!-- The schedule logic reasons in IST; force it so a Mac on another system
         timezone still fires at the intended IST windows. -->
    <key>TZ</key><string>Asia/Kolkata</string>
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
echo "Run mode: ${RUN_MODE}"
echo "RunAtLoad is enabled for weekday-window catch-up after login/reboot."
echo "Logs: $LOG_DIR/launchd.out.log and $LOG_DIR/launchd.err.log"
echo "If the Mini might sleep, wake it five minutes before the window:"
echo "  sudo pmset repeat wakeorpoweron MTWRFSU 12:55:00"
