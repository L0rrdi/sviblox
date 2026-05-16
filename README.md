# SviBlox

Chrome/Opera extension that adds privacy-conscious quality-of-life features to the Roblox website. No analytics, no third-party hosts, no credential prompts.

Status: **Beta, Published – Unlisted** on the Chrome Web Store. Install by direct link.

## Features

Home page

- "Your Most Played" widget using local + imported playtime data.
- Favorites and My Games sections rendered with thumbnails, like ratio, and active player counts.
- Friend-tile stats restoration: like % and active player count next to friend avatars on Roblox carousels (Continue / Recommended / Standout).
- One-click dropdown that collapses Standout and Recommended sections together.

Profiles and friends

- Banned/terminated profile viewer: when Roblox 302-redirects a banned user's profile to `/request-error?code=404`, SviBlox rebuilds the profile in place — fullbody avatar, displayName, BANNED badge, friends/followers/following counts, description, joined date, plus About-tab sections for currently-wearing items, favorite experiences, friends, communities, badges, and a Creations tab listing the user's experiences. Recovers the userId from the most-recent profile-link click; forgotten accounts fall back to the user-profile-api `combinedName` lookup.
- "Last online" chip on a friend's profile: shows live presence (Online / In-game / In Studio) or `Last online Xh ago` based on a snapshot the service worker captures every 5 minutes.
- Deleted friends on the Friends page get the entire card surface made clickable (not just the avatar/name link area) so a click anywhere on the tile opens the SviBlox banned-profile view.

Game pages

- Badge replacement showing ownership, rarity, won-yesterday, won-ever, with sort and filter controls.
- Dev products on the Store tab, rendered under the Passes list.
- Subplaces on the Servers tab: a collapsible list of every place inside the experience.
- Optional Robux-to-currency converter that shows a small estimate beside Robux prices (USD / GBP / NOK; Regular / DevEx / Roblox+ rates).
- Optional Total Spent display in the Store tab, totalling Robux spent on the current experience using the signed-in user's own transaction history. All computation is local; nothing is uploaded.
- Per-server "Ping: `<n>`ms" line and "Share" button on every tile in the Other Servers list. Share copies a `roblox.com/games/start?placeId=...&gameInstanceId=...` deep link to the clipboard.
- "Filters" button next to Refresh on the Other Servers list, with **Available Space**, **Random Shuffle**, and **Best Connection**. Fetches up to ~300 servers from the public-server API, sorts the union, and replaces the visible tiles with the top 30 (so sorting works across the full server pool, not just whatever Roblox has paginated in). "Clear" restores the native list.

Badge detail pages

- A "Badges Awarded" row is inserted alongside Type / Updated / Description, showing the badge's `awardedCount` from `badges.roblox.com/v1/badges/{id}`.

Themes and tracking

- Custom themes with presets, palette controls, and local background images.
- **`classic-2016` theme**: deep 2012-style Home reskin that includes a bundled ROBLOX wordmark, restyled navy 56-px header (with renamed nav items and a flat-white search field positioned past the ROBUX button), left rail trimmed to the reference items + green "Upgrade Now" button + small blue friend-count badge, fullbody friend tile avatars (URL rewritten from `/AvatarHeadshot/` to `/Avatar/`), a fixed bottom friends-online strip with ~30 chips fetched live, and Favorites/My Games rendered as a single-row 5-column grid. Desktop only; on small viewports the page falls back to Roblox's responsive layout.
- Manual RoPro playtime import.
- Optional local playtime tracking via Roblox presence polling while the browser is open.

## Setup

Requirements: Node.js 18+ and npm.

```bash
npm install
```

## Development

Run a watched extension build while developing:

```bash
npm run dev
```

Reload the unpacked extension after each rebuild.

## Checks

```bash
npm run typecheck
npm run lint
npm run build
npm run test:ui
```

`npm run build` runs TypeScript checking and then writes the built extension to `dist/`.

## UI Testing

This project includes a Playwright smoke test for extension UI work. It launches Chromium with the built `dist/` extension loaded, opens the popup and options pages, and writes screenshots to `test-results/`.

```bash
npm run build
npm run test:ui
```

For an interactive browser while debugging UI:

```bash
npm run test:ui:headed
```

Playwright MCP is also installed and registered in the local Codex config as `playwright`. The MCP server uses `playwright.mcp.config.json`, which launches Chromium with this project's built `dist/` extension loaded. Restart Codex after changing MCP config so the tool becomes available in future sessions.

## Load unpacked

1. Open `chrome://extensions` (or `opera://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this project's `dist/` folder.

## Package For Web Store

Build the extension, remove sourcemaps from the generated output if you do not want to upload them, then zip the contents of `dist/`:

```powershell
npm.cmd run build
Get-ChildItem dist -Recurse -Include *.map | Remove-Item -Force
Compress-Archive -Path dist\* -DestinationPath sviblox-beta-0.2.0-chrome-web-store.zip -Force
```

Generated upload ZIPs and `dist/` are build artifacts. They should not normally be committed; regenerate them for each store submission.

## Permissions

- `storage`: saves settings in sync storage; saves playtime, cache, and custom theme data locally.
- `alarms`: runs the 1-minute opt-in presence poll for playtime tracking.
- `unlimitedStorage`: allows large custom theme background images in local extension storage.
- `host_permissions` for `roblox.com` / `*.roblox.com`: reads Roblox pages and Roblox API responses using the user's existing browser session.

## Privacy

- Never asks for `.ROBLOSECURITY` or any session token.
- Does not bypass private inventories, private friend lists, moderation, or Roblox rate limits.
- Playtime data, transaction summaries, and custom themes stay in Chrome extension storage in the user's browser profile.
- Full policy: <https://l0rrdi.github.io/sviblox-privacy/>

## Tech stack

TypeScript + Vite + React (popup/options) + plain TS content scripts. Manifest V3.

## License

Source provided as-is for review and personal use. No license granted for redistribution.

The `classic-*` theme presets (CSS only) include adapted work from two GPL v3 UserScripts — see [ATTRIBUTION.md](ATTRIBUTION.md) for details and source links.
