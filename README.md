# MySchoolOne Pro Holo3.1 Photo Downloader

A local macOS automation that combines:

- **Deterministic HTTP + Playwright** for the normal daily-download path.
- **Holo3.1** (optional) for understanding and navigating the school's visual
  interface when the deterministic path is not enough.
- **SHA-256 duplicate detection** so reopening the same update does not create repeated files.

The project does not contain your H Company key or school credentials.

## 1. Requirements

- macOS
- Node.js 20 or newer
- An H Company Models API key
- The exact MySchoolOne Pro URL supplied by your child's school

Check Node:

```bash
node --version
```

## 2. Install

```bash
cd myschoolone-holo-downloader
npm install
npm run install-browser
cp .env.example .env
```

Open `.env` and set:

```dotenv
HAI_API_KEY=your-real-key
SCHOOL_URL=https://the-exact-school-portal-url
```

Do not share or commit `.env`.

## 3. Save the login session

```bash
npm run login
```

A separate Chromium window opens. Log in manually, including OTP or CAPTCHA. When the dashboard is visible, return to Terminal and press Enter. The browser session is kept in `.browser-profile` on your Mac, and a cookie snapshot is written to `STATE_DIR/browser-storage-state.json` for the direct HTTP path.

## 4. Run the downloader

```bash
npm run daily
```

This is the primary path. It first tries a fast **direct HTTP poll** (no
browser) using the saved cookies and the AJAX request structure captured by the
last browser run (`daily-log-discovery.json`). If the direct path cannot be
trusted — no discovery data yet, stale/incomplete discovery, or HTTP errors —
it falls back to a Playwright browser session, which also refreshes the
discovery file.

> Note: on the current school portal the AJAX endpoints sit behind a Cloudflare
> challenge that raw requests cannot pass, so the direct poll usually falls
> back to the browser automatically. Set `DIRECT_POLL=false` in `.env` to skip
> the wasted requests; the direct path is kept for networks where the challenge
> is not present.

New images are saved under:

```text
$DOWNLOAD_DIR/YYYY-MM-DD/
```

(`DOWNLOAD_DIR` defaults to `~/Pictures/School Updates`; on the Mac Mini
it is set to the iCloud Drive folder so the photos also appear on your phone.
The duplicate history is stored in `STATE_DIR/downloads.json`.)

## 5. Optional Holo vision agent (manual rescue tool)

The deterministic path above handles the normal case. When the portal layout
changes and the deterministic path cannot navigate, you can run the vision
agent as a fallback:

```bash
npm run agent
```

Keep the Chromium window visible during the first few runs. Holo will inspect
screenshots and choose actions. Agent runs are recorded in the same state file
as normal runs and notify you on failure.

If the agent gets stuck:

```bash
npm run capture
```

Manually navigate to the troublesome page and press Enter. This creates a local
`debug/` folder containing a screenshot, HTML and visible text. Do not send
that folder publicly; it can contain children's names, school data and
session-sensitive page content.

## 6. Scheduling — only after manual runs work

The included script installs a macOS LaunchAgent that runs the downloader at
**3:00 PM** and **9:00 PM** IST on weekdays, checking the last 7 days for new
photos each time:

```bash
./scripts/install-launch-agent.sh
```

The schedule times are defined in a single place
(`src/schedule-window.ts`); the installer reads them from there, so the plist
cannot drift from the code.

The scheduler uses an exclusive local lock, so manual runs and scheduled runs
cannot share one browser profile. It records recent run results in the local
state file; inspect them with:

```bash
npm run status
```

A scheduled GUI browser automation needs an active, unlocked macOS user
session. For unattended recovery after a power failure, configure automatic
login and `pmset autorestart 1`. Validate a manual operation before enabling it.

Optional: configure `HEALTHCHECK_URL` with a Healthchecks.io ping URL. The
scheduler pings it after the 9:00 PM reconciliation, so an external service can
alert if the Mini stops running entirely. The ping contains no school content
or credentials.

### Health check (portal fingerprint)

`npm run health` fingerprints the portal's structural elements (date picker,
AJAX endpoints, scripts) and compares against a known-good baseline, detecting
portal changes before they break the downloader. A baseline change is only
accepted after it is seen on **two consecutive** checks, so a transient
Cloudflare interstitial or maintenance page never silently becomes the new
baseline. The scheduler runs this after each successful reconcile and notifies
you if the portal changed.

### Repairing the download index

If a run crashed between writing an image and saving its record, run:

```bash
npm run rescan
```

This re-reads the download folder, hashes every image and re-adds any records
missing from the state file.

## 7. Telegram remote control

If you want to start a run or check status from your phone, enable the optional
Telegram bot.

Set in `.env`:

```dotenv
TELEGRAM_BOT_TOKEN=your-bot-token-from-at-telegram-dot-org
TELEGRAM_CHAT_ID=your-chat-id
```

Run the bot in the foreground for testing:

```bash
npm run telegram-bot
```

Supported commands (only from the configured chat):

- `/run` — Start a full photo download run (same as `npm run daily`).
- `/status` — Show total photos, this week/month counts, last run, and next scheduled run.
- `/help` — List commands.

`/run` replies immediately and starts the downloader as a separate process, so
the bot keeps answering `/status` while the run is in progress. Only one
downloader run can run at a time — if a run is already active, the bot replies
that it is busy.

Install a LaunchAgent so the bot starts automatically and restarts if it exits:

```bash
./scripts/install-telegram-bot-launch-agent.sh
```

## Failure recovery

- **"LOGIN REQUIRED"** notification: the portal session expired and the browser
  cannot sign in automatically. Run `npm run login` and complete the OTP/CAPTCHA.
- **Repeated failures**: after 3 consecutive failed runs you get an
  "ACTION NEEDED" notification. Steps: `npm run login`, then `npm run health`,
  then `npm run status`.
- Session cookies are checked before every run; a warning is sent when they
  expire within 48 hours.

## Privacy

Screenshots sent to Holo may contain school updates, names and photo
thumbnails. The H Company API documentation states that its API uses zero data
retention by default, but the screenshots still leave the Mac for inference.
The deterministic `npm run daily` path sends no screenshots anywhere. For
stronger privacy, the same architecture can later point at a locally hosted
Holo3.1 model.

## Safety boundaries in the agent prompt

The agent is instructed to remain read-only. It must not send messages, submit forms, acknowledge updates, alter settings, delete content or open unrelated profiles.
