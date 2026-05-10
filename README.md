# SviBlox

Chrome/Opera extension that adds privacy-conscious quality-of-life features to the Roblox website. No analytics, no third-party hosts, no credential prompts.

Status: **Beta, Published – Unlisted** on the Chrome Web Store. Install by direct link.

## Features

Home page

- "Your Most Played" widget using local + imported playtime data.
- Favorites and My Games sections rendered with thumbnails, like ratio, and active player counts.
- Friend-tile stats restoration: like % and active player count next to friend avatars on Roblox carousels (Continue / Recommended / Standout).
- One-click dropdown that collapses Standout and Recommended sections together.

Game pages

- Badge replacement showing ownership, rarity, won-yesterday, won-ever, with sort and filter controls.
- Dev products on the Store tab, rendered under the Passes list.
- Subplaces on the Servers tab: a collapsible list of every place inside the experience.
- Optional Robux-to-currency converter that shows a small estimate beside Robux prices (USD / GBP / NOK; Regular / DevEx / Roblox+ rates).
- Optional Total Spent display in the Store tab, totalling Robux spent on the current experience using the signed-in user's own transaction history. All computation is local; nothing is uploaded.

Themes and tracking

- Custom themes with presets, palette controls, and local background images.
- Manual RoPro playtime import.
- Optional local playtime tracking via Roblox presence polling while the browser is open.

## Build

```bash
npm install
npm run build
```

The built extension is written to `dist/`.

## Load unpacked

1. Open `chrome://extensions` (or `opera://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this project's `dist/` folder.

Reload the extension after each rebuild.

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
