# Cloud deployment — $0/month free-tier setup

This repo can run entirely in the cloud with **no dependency on a local Mac**:
GitHub Actions provides the compute, Cloudflare R2 provides storage, and
Telegram + Healthchecks.io handle notifications — all on free tiers.

```
GitHub Actions (ubuntu-latest, public repo → free unlimited minutes)
├─ schedule: weekdays 15:00 & 21:00 IST (cron 30 9,15 * * 1-5 UTC)
├─ workflow_dispatch:  manual "Run now" from the GitHub app/UI
├─ repository_dispatch: run-downloader (hook for a future Telegram /run bridge)
├─ job: restore state from R2 → npm run scheduled → sync photos + state to R2
└─ concurrency group: at most one run at a time (queued, never cancelled)
        │ aws s3 sync (S3-compatible API)
        ▼
Cloudflare R2 bucket (10 GB free, zero egress fees)
├─ photos/YYYY-MM-DD/*.jpg
└─ state/: downloads.json, cookie snapshot, discovery file
        │
        ▼
Telegram notifications (photos + run summary) and Healthchecks.io dead-man ping
```

The Mac becomes optional: keep it as a consumer that pulls from R2, or retire
it. The only permanently local step is the occasional portal login if the
portal session/OTP flow ever requires a human (see [Limitations](#limitations--mitigations)).

## Components and their free tiers

| Component | Service | Free-tier headroom |
|---|---|---|
| Compute | GitHub Actions, `ubuntu-latest` | **Unlimited minutes for public repos**; private repos draw from the 2,000 min/month quota (this workload needs ~200–300) |
| Storage | Cloudflare R2 | 10 GB, 1M writes + 10M reads/month, zero egress — a school year of photos fits easily |
| Notifications | Telegram Bot API | Free |
| Dead-man alert | Healthchecks.io | Free single check |

## How a run works

1. **Trigger** — cron (`30 9,15 * * 1-5` UTC = weekdays 15:00 & 21:00 IST;
   IST is UTC+5:30 with no DST, so the offset is fixed), a manual
   `workflow_dispatch`, or a `repository_dispatch: run-downloader` event.
2. **Restore** — `aws s3 sync` pulls `state/` (downloads.json, cookie
   snapshot, discovery file) from R2 into the workspace. `run.lock/`,
   `debug/`, and `*.corrupt-*` files are excluded both ways: a stale lock
   must never block the next runner, and debug captures must stay private.
3. **Run** — `npm run scheduled`. The entry point itself derives fast vs
   reconcile mode from the live IST clock, skips weekends, sends Telegram
   notifications, and pings Healthchecks.io. It also auto-logs-in to the
   portal using `SCHOOL_USERNAME`/`SCHOOL_PASSWORD` because each runner
   starts with a fresh browser profile. The runner's preinstalled real
   Chrome (`BROWSER_CHANNEL=chrome`) is the Cloudflare defense.
4. **Sync back** (`if: always()`, so it happens even on failed runs) —
   photos go to `photos/`, state back to `state/`. Duplicate detection is
   SHA-256 based, so re-syncs and repeated runs are inherently safe.

The workflow is `.github/workflows/scheduled.yml`. Its cron is pinned to
`src/schedule-window.ts` (the single source of truth for schedule times) by
`test/schedule-workflow.test.ts`, so the YAML cannot silently drift from the
code — change the times in `schedule-window.ts` and the test will fail until
the cron matches.

## Setup

### 1. Create the Cloudflare R2 bucket and token

1. In the Cloudflare dashboard, enable **R2** and create a bucket
   (e.g. `myschoolone-photos`).
2. Create an **S3 API token** scoped to that bucket with *Object Read &
   Write*. Note the **Access Key ID**, **Secret Access Key**, and the
   endpoint `https://<account-id>.r2.cloudflarestorage.com`.

### 2. Add GitHub secrets

Repo → *Settings → Secrets and variables → Actions*. Values live only in
secrets — never in the repo, never in chat.

| Secret | Purpose |
|---|---|
| `SCHOOL_URL` | Exact MySchoolOne Pro portal URL |
| `SCHOOL_USERNAME` | Portal credentials — required on cloud runners for auto-login |
| `SCHOOL_PASSWORD` | (as above) |
| `TELEGRAM_BOT_TOKEN` | Notifications |
| `TELEGRAM_CHAT_ID` | Notifications |
| `HEALTHCHECK_URL` | Optional dead-man ping (the app pings it — the workflow must **not** ping separately) |
| `R2_BUCKET` | Bucket name |
| `R2_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID` | R2 S3 token credentials |
| `R2_SECRET_ACCESS_KEY` | (as above) |

To set the `.env`-sourced secrets without typing values into a terminal,
run `scripts/set-cloud-secrets.sh` — it reads the local `.env` and pipes each
value straight into `gh secret set` (never printed, never in shell history).
The four R2 secrets are not in `.env`; the script prints the `gh secret set`
commands for them at the end.

### 3. First run (shadow run)

- Push the workflow to the default branch, then trigger it manually:
  *Actions → Scheduled downloader → Run now* (`workflow_dispatch`), with the
  **force** input checked. `scheduled.ts` skips runs outside the
  15:00–21:00 IST window unless forced, and the shadow run intentionally
  happens at an arbitrary time while the Mac LaunchAgents still own the
  real schedule.
- Watch the run logs. The first browser-fallback runs from a datacenter IP
  are the ones that prove (or worry) the Cloudflare story — see below.
- Confirm photos appear in the R2 bucket and Telegram receives the run
  summary. The Mac keeps its own schedule meanwhile; because duplicate
  detection is SHA-256 based, both fetching the same updates concurrently
  is safe.

### 4. Optional: seed prior state

The system works from a fresh state (the 7-day reconcile lookback re-fetches
recent updates, and dedupe prevents duplicates). If you want the cloud to
inherit your Mac's history instead, upload the local `downloads.json` (and
cookie snapshot) to `s3://<bucket>/state/` once — e.g. with the same awscli
credentials.

## Costs

Everything above is **$0/month** on a public repo. On a private repo,
Actions usage would draw ~240 of the 2,000 free minutes/month
(estimated 4 min per fast run, 7 min per reconcile run), which is why a
public repo is the recommended posture for this setup.

## Limitations & mitigations

- **GitHub cron drifts** by minutes (occasionally more under load). Runs that
  drift outside the IST schedule window skip themselves harmlessly; the
  weekday 21:00 reconcile covers a 7-day lookback, so nothing is lost — it
  may just arrive later than the ideal time.
- **60-day auto-disable**: GitHub disables scheduled workflows on repos with
  no activity for 60 days. GitHub emails before disabling; a manual
  "Run now" (or any commit) resets the clock.
- **Cloudflare from datacenter IPs**: GitHub runners egress from
  abuse-heavy Azure ranges, so browser challenges are more likely than from
  a residential IP. The real Chrome channel mitigates this; if it ever gets
  bad, a WireGuard tunnel to a home router is the escape hatch (network path
  only — still no compute dependency on the Mac).
- **Auto-login**: cloud runs rely on `SCHOOL_USERNAME`/`SCHOOL_PASSWORD`.
  The browser profile is intentionally *not* synced to R2 (hundreds of MB).
  If the portal ever adds an OTP/2FA step to login, that becomes a human
  step — the app's no-CAPTCHA-defeat policy stands; never attempt to bypass it.
- **No always-on Telegram bot** on ephemeral runners, so `/run` and
  `/status` chat commands are unavailable. `workflow_dispatch` from the
  GitHub mobile app covers most of it; a ~50-line Cloudflare Worker
  (free tier, 100k requests/day) can bridge a Telegram webhook to
  `repository_dispatch: run-downloader` if chat control is wanted later.
- **Public repo visibility**: the code and workflow run logs are public.
  Secrets stay hidden as long as they exist only in GitHub secrets, but be
  mindful of anything identifying (school name, portal URL) in the repo and
  logs. Never add debug steps that echo secret values.

## Migrating off the Mac

1. **Shadow run** (recommended): keep the Mac LaunchAgents running while the
   cloud schedule is live for a week or two. Compare per-run tallies in
   Telegram and the R2 bucket contents.
2. **Cutover**: uninstall the two LaunchAgents
   (`scripts/install-launch-agent.sh` counterparts) once confident. `npm run
   rescan` remains available locally against a synced-down bucket if a state
   rebuild is ever needed.
3. **Retention**: the R2 bucket is the durable archive. If photos should
   also live in iCloud Drive, a small scheduled sync from R2 (on the Mac or
   any always-on box) is all that remains.

The local LaunchAgent mode continues to work unchanged — every cloud
behaviour is confined to the workflow file and environment variables, so the
two can run side by side during evaluation.
