# SviBlox

Chrome/Opera extension that adds privacy-conscious quality-of-life features to the Roblox website. No analytics, no third-party hosts, no credential prompts.

Status: **Beta, Published – Unlisted** on the Chrome Web Store. Install by direct link.

## Features

Home page

- "Your Most Played" widget using local + imported playtime data.
- Favorites and My Games sections rendered with thumbnails, like ratio, and active player counts.
- User-defined game folders for sorting your favorites, with an "Add to folder" button on game pages and home tiles.
- Friend-tile stats restoration: like % and active player count next to friend avatars on Roblox carousels (Continue / Recommended / Standout).
- One-click dropdown that collapses Standout and Recommended sections together.
- Universal slide-in "Quick Play" button on hover over any game tile site-wide.
- Search autocomplete with a Quick Play button on the top result.

Favorites and catalog

- Hover-revealed `×` (remove) button on each tile of your Favorites page, with an Undo toast for accidental removals.
- "Included in bundles" panel on `/catalog/{assetId}` item pages, showing which Roblox bundles the asset belongs to (with thumbnails) — e.g. Headless Head → Headless Horseman.

Profiles and friends

- Banned/terminated profile viewer: when Roblox 302-redirects a banned user's profile to `/request-error?code=404`, SviBlox rebuilds the profile in place — fullbody avatar, displayName, BANNED badge, friends/followers/following counts, description, joined date, plus About-tab sections for currently-wearing items, favorite experiences, friends, communities, badges, and a Creations tab listing the user's experiences. Recovers the userId from the most-recent profile-link click; forgotten accounts fall back to the user-profile-api `combinedName` lookup.
- "Last online" chip on a friend's profile: shows live presence (Online / In-game / In Studio) or `Last online Xh ago` based on a snapshot the service worker captures every 5 minutes.
- Deleted friends on the Friends page get the entire card surface made clickable (not just the avatar/name link area) so a click anywhere on the tile opens the SviBlox banned-profile view.
- Optional **Account Value** card: Limited RAP + current catalog prices of avatar items (hats, clothing, accessories) + (own profile only) Robux purchase history. Lazy-loads on expand. Off-sale items count but contribute 0.
- Private **notes + nickname** editor card under the profile header on other people's profiles. Nicknames also appear as small `(nickname)` chips next to friend avatars on home carousels and on the Friends / Followers / Following pages. Local-only — no sync.
- **Mutuals** tab on Friends pages: compares mutual friends, favorite games, groups, items, and limiteds. On your own profile each tile shows which of your friends share that item via a "Shared with N friends" dropdown.

Game pages

- Badge replacement showing ownership, rarity, won-yesterday, won-ever, with sort and filter controls. Optional per-tier rarity color tinting.
- Dev products on the Store tab, rendered under the Passes list.
- Subplaces on the Servers tab: a collapsible list of every place inside the experience.
- Optional Robux-to-currency converter that shows a small estimate beside Robux prices (USD / GBP / NOK; Regular / DevEx / Roblox+ rates).
- Optional Total Spent display in the Store tab, totalling Robux spent on the current experience using the signed-in user's own transaction history. All computation is local; nothing is uploaded.
- Per-server "Ping: `<n>`ms" line on every tile in the Other Servers list.
- "Filters" button next to Refresh on the Other Servers list, with **Available Space**, **Random Shuffle**, and **Best Connection**. Fetches up to ~300 servers from the public-server API, sorts the union, and replaces the visible tiles with the top 30 (so sorting works across the full server pool, not just whatever Roblox has paginated in). "Clear" restores the native list. Custom-sorted tiles have a one-click Join that calls the same launcher API as Roblox's own Join button.

Badge detail pages

- A "Badges Awarded" row is inserted alongside Type / Updated / Description, showing the badge's `awardedCount` from `badges.roblox.com/v1/badges/{id}`.

Site-wide hotkeys

- Configurable single-key hotkeys for jumping around game pages (Description, Store, Badges, Servers, Comments, Play…) and site sections (Home, Profile, Friends, Avatar, Inventory, Themes, UHBL). Folder-game bindings navigate straight into a game.
- Bind keys in the popup's Hotkeys panel. Hold `|` to show an on-screen help overlay of your current bindings. Hotkeys are ignored when an input/textarea/contenteditable has focus or any modifier is held.

Themes and other

- Custom themes with built-in presets plus multiple savable user presets — create, rename, and delete alongside the built-ins. Palette controls and local background images per preset.
- Optional **theme schedule**: automatically switch between a light preset and a dark preset at configurable local times of day. Windows that cross midnight work.
- **`classic-2016` theme**: deep 2012-style Home reskin that includes a bundled ROBLOX wordmark, restyled navy 56-px header (with renamed nav items and a flat-white search field positioned past the ROBUX button), left rail trimmed to the reference items + green "Upgrade Now" button + small blue friend-count badge, fullbody friend tile avatars (URL rewritten from `/AvatarHeadshot/` to `/Avatar/`), a fixed bottom friends-online strip with ~30 chips fetched live, and Favorites/My Games rendered as a single-row 5-column grid. Desktop only; on small viewports the page falls back to Roblox's responsive layout.
- **Ultra Hard Badge List (UHBL)** page accessible from the left nav — mirrors the public community-maintained UHBL Google Sheet, grouped by difficulty, with sticky filter bar (search / Difficulty / Enjoyment Rating / Tags) and per-tier "X / N owned" counts when signed in. Stale-while-revalidate cache, 6h freshness.
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
Compress-Archive -Path dist\* -DestinationPath sviblox-beta-0.4.0-chrome-web-store.zip -Force
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
