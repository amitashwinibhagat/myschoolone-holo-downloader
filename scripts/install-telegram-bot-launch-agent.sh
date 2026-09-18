#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
TSX_CLI="$PROJECT_DIR/node_modules/tsx/dist/cli.mjs"
LABEL="com.amit.myschoolone-telegram-bot"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

if [ -f "$PROJECT_DIR/.env" ]; then
  STATE_FROM_ENV="$(grep -E '^STATE_DIR=' "$PROJECT_DIR/.env" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  STATE_FROM_ENV="${STATE_FROM_ENV/#\~/$HOME}"
fi
LOG_DIR="${STATE_FROM_ENV:-$HOME/.local/share/myschoolone-downloader/state}"

# Prefer the compiled build (dist/) so the bot does not depend on tsx at
# runtime; fall back to tsx + src/ when the project has not been built yet.
if [ -f "$PROJECT_DIR/dist/telegram-bot.js" ]; then
  PROGRAM_ARGS="$(printf '    <string>%s</string>\n    <string>%s</string>' "$NODE_BIN" "$PROJECT_DIR/dist/telegram-bot.js")"
  RUN_MODE="compiled (dist/telegram-bot.js)"
else
  if [ ! -f "$TSX_CLI" ]; then
    echo "Neither dist/telegram-bot.js nor tsx was found." >&2
    echo "Build it (npm run build) or install dependencies (npm install), then rerun." >&2
    exit 1
  fi
  PROGRAM_ARGS="$(printf '    <string>%s</string>\n    <string>%s</string>\n    <string>src/telegram-bot.ts</string>' "$NODE_BIN" "$TSX_CLI")"
  RUN_MODE="tsx (src/telegram-bot.ts) — run 'npm run build' for a tsx-free runtime"
fi

if [ ! -f "$PROJECT_DIR/.env" ]; then
  echo ".env not found. Copy .env.example to .env and set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

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
    <key>TZ</key><string>Asia/Kolkata</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${LOG_DIR}/telegram-bot.out.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/telegram-bot.err.log</string>
</dict>
</plist>
PLIST

plutil -lint "$PLIST"
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "Installed ${LABEL}: Telegram bot running in background."
echo "Run mode: ${RUN_MODE}"
echo "Logs: $LOG_DIR/telegram-bot.out.log and $LOG_DIR/telegram-bot.err.log"
echo "To stop: launchctl bootout gui/$(id -u) $PLIST"
echo "Remember to set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in $PROJECT_DIR/.env"
