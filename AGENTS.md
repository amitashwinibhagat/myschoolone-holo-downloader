# Project Instructions

## Project

- Node.js 20+ and strict TypeScript ES modules (see `package.json` and `tsconfig.json`).
- Local macOS automation that downloads photo attachments from the MySchoolOne Pro portal: a deterministic direct HTTP poll first, with a Playwright browser fallback when the direct poll cannot be trusted. The Holo vision agent (`src/agent.ts`) is a manual rescue tool, not the primary path.
- Duplicate detection is SHA-256 based; reopening the same update must not create repeated files.

## Development

- Use the scripts already defined in `package.json`; do not invent new workflows.
- After any TypeScript change, run `npm run check` (tsc noEmit) and then `npm test` (node --test).
- When behavior changes, add or update a focused test under `test/*.test.ts`.
- Run test commands only against mocked/CI-safe inputs. Most commands read `.env` at startup, so never run live portal commands as part of validation.

## Code conventions

- Keep strict TypeScript enabled and use relative `.js` import specifiers (NodeNext).
- Preserve the direct-poll-to-browser fallback and the duplicate-detection behavior.
- Make the smallest scoped change; follow the surrounding style and comments.

## Safety and privacy

- Do not run live portal, browser, login, scheduling, Telegram, or capture commands unless the user explicitly requests that exact operation. This includes the `login`, `daily`, `agent`, `scheduled`, `telegram-bot`, `capture`, `health`, and `rescan` scripts and the LaunchAgent installers under `scripts/`. (`install-browser` is a local dependency step, not a live operation.)
- Never read, print, copy, commit, or modify `.env`, browser profiles, state directories, debug captures, downloaded photos, credentials, session cookies, API keys, Telegram tokens, or school data unless explicitly authorized. Even when authorized, never surface secrets in chat or commit them.
- Preserve the portal agent's read-only behavior: no message sending, form submission, acknowledgement, setting changes, or content deletion, and never bypass authentication or CAPTCHA.

## Files and generated state

- `.env`, `.browser-profile/`, `.state/`, `debug/`, downloaded content, and `dist/` are local, private runtime artifacts. Keep them out of commits and out of chat.
