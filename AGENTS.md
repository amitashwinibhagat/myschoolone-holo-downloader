# Project Instructions

## Project

- Node.js 20+ and strict TypeScript ES modules (see `package.json` and `tsconfig.json`).
- Local macOS automation that downloads photo attachments from the MySchoolOne Pro portal: a deterministic direct HTTP poll first, with a Playwright browser fallback when the direct poll cannot be trusted. There is no AI/vision component — the pipeline is fully deterministic.
- Duplicate detection is SHA-256 based (of the original bytes, before any compression); reopening the same update must not create repeated files.

## Development

- Use the scripts already defined in `package.json`; do not invent new workflows.
- After any TypeScript change, run `npm run check` (tsc noEmit) and then `npm test` (node --test).
- When behavior changes, add or update a focused test under `test/*.test.ts`.
- Run test commands only against mocked/CI-safe inputs. Most commands read `.env` at startup, so never run live portal commands as part of validation.
- CI (`.github/workflows/ci.yml`) runs `check` + `test` on Node 20 and 22; keep the code compatible with both.

## Build and runtime

- `npm run build` compiles `src/` to `dist/` via `tsconfig.build.json` (sources only, never `test/`).
- The LaunchAgent installers under `scripts/` prefer compiled `dist/*.js` and fall back to `tsx` when no build exists. Prefer the compiled runtime for scheduled runs: it does not depend on the `tsx`/`esbuild` packages being readable at runtime.
- Keep both run modes working. Any code that spawns another entry point (e.g. the Telegram bot spawning `daily`) must detect whether it is running as compiled `.js` or tsx-run `.ts` and pick the sibling entry accordingly.

## Scheduling and time

- Schedule times live in exactly one place, `src/schedule-window.ts`; the installers read them from there so the plists cannot drift from the code.
- Schedule logic reasons in IST (`Asia/Kolkata`), and the installers set `TZ=Asia/Kolkata` in the LaunchAgent environment. Do not reintroduce a dependency on the Mac's local system timezone.

## State integrity

- `DownloadStore.load()` must be resilient: corrupt JSON, wrong-shaped-but-valid JSON, and legacy files without a `schemaVersion` are all tolerated. Unreadable state is quarantined (renamed, never deleted) and the store starts empty; `npm run rescan` rebuilds the index.
- `downloads.json` writes go through a temp file + rename, and any command that mutates state (`rescan` included) must hold the run lock so it cannot clobber a live run.

## Reliability invariants

- Bound anything that can hang. Playwright does not time out `evaluate()`, so in-page reads go through `withTimeout()` in `utils.ts`, and every navigation has an explicit timeout.
- Attachments are size-capped (`MAX_ATTACHMENT_BYTES` in `utils.ts`): refuse an oversized body before buffering it, and re-check after buffering for chunked responses that omit `Content-Length`.
- File writes are atomic (temp file + rename) and must remove their temp file on failure so stale `.tmp` files never accumulate.
- On the hot path, prefer a positive readiness signal (wait for the real element) over a fixed `waitForTimeout` sleep; keep remaining sleeps short and justified.

## Code conventions

- Keep strict TypeScript enabled and use relative `.js` import specifiers (NodeNext).
- Preserve the direct-poll-to-browser fallback and the duplicate-detection behavior. Trust decisions around the direct poll may only become *more* conservative (add a browser verification), never less.
- Make the smallest scoped change; follow the surrounding style and comments.

## Safety and privacy

- Do not run live portal, browser, login, scheduling, Telegram, or capture commands unless the user explicitly requests that exact operation. This includes the `login`, `daily`, `scheduled`, `telegram-bot`, `capture`, `health`, `rescan`, `resend-photos`, and `backfill` scripts and the LaunchAgent installers under `scripts/`. (`install-browser` is a local dependency step, not a live operation.)
- Never read, print, copy, commit, or modify `.env`, browser profiles, state directories, debug captures, downloaded photos, credentials, session cookies, API keys, Telegram tokens, or school data unless explicitly authorized. Even when authorized, never surface secrets in chat or commit them.
- Preserve the portal automation's read-only behavior: no message sending, form submission, acknowledgement, setting changes, or content deletion, and never bypass authentication or CAPTCHA. Auto-login uses the user's own credentials only; it must not attempt to defeat Cloudflare or any real challenge.

## Files and generated state

- `.env`, `.browser-profile/`, `.state/`, `debug/`, downloaded content, and `dist/` are local, private runtime artifacts. Keep them out of commits and out of chat.
- Runtime state belongs outside iCloud Drive (default `~/.local/share/myschoolone-downloader/`). macOS "Optimize Mac Storage" can evict project files, including `node_modules/`, which breaks scheduled runs with `Unknown system error -11` or a missing `tsx`. Keep the repo outside iCloud Drive, or mark it **Keep Downloaded** in Finder, and prefer the compiled `dist/` runtime.
