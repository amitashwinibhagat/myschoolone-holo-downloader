# MySchoolOne Pro Holo3.1 Photo Downloader

A local macOS automation that combines:

- **Holo3.1** for understanding and navigating the school's visual interface.
- **Playwright** for predictable clicking, browser-session reuse and file handling.
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

A separate Chromium window opens. Log in manually, including OTP or CAPTCHA. When the dashboard is visible, return to Terminal and press Enter. The browser session is kept in `.browser-profile` on your Mac.

## 4. Run the downloader

```bash
npm run agent
```

Keep the Chromium window visible during the first few runs. Holo will inspect screenshots and choose actions. New images are saved under:

```text
~/Pictures/School Updates/YYYY-MM-DD/
```

The duplicate history is stored in `.state/downloads.json`.

## 5. Important first-run behaviour

The agent is deliberately generic because different schools can configure MySchoolOne Pro differently. On the first run, watch whether it reaches the right updates section and opens attachments correctly.

If it gets stuck:

```bash
npm run capture
```

Manually navigate to the troublesome page and press Enter. This creates a local `debug/` folder containing a screenshot, HTML and visible text. Do not send that folder publicly; it can contain children's names, school data and session-sensitive page content.

## 6. Scheduling — only after manual runs work

The included script installs a macOS LaunchAgent for 7:30 PM daily:

```bash
./scripts/install-launch-agent.sh
```

A scheduled GUI browser automation can fail when the Mac is asleep, locked, logged out, or Chromium lacks macOS permissions. Validate manual operation before enabling it.

## Privacy

Screenshots sent to Holo may contain school updates, names and photo thumbnails. The H Company API documentation states that its API uses zero data retention by default, but the screenshots still leave the Mac for inference. For stronger privacy, the same architecture can later point at a locally hosted Holo3.1 model.

## Safety boundaries in the agent prompt

The agent is instructed to remain read-only. It must not send messages, submit forms, acknowledge updates, alter settings, delete content or open unrelated profiles.
