# Third-party Attribution

SviBlox is mostly original work. The **classic-era CSS presets** (the `classic-*` themes selectable from the SviBlox Themes page) are adapted from two community Roblox UserScripts. Those scripts are licensed under **GNU General Public License v3.0**, and this attribution file documents the derivation.

## Sources

### `2014-esque Roblox` by sayorisocks
- Repository: <https://github.com/sayorisocks/robsblocks>
- License: GNU GPL v3.0
- Provided palette references for the 2013–2015 era presets (header background colours, body backgrounds, header heights, banner themes).

### `ROBLOX 2012` by legosavant
- Greasyfork page: <https://greasyfork.org/en/scripts/437246-roblox-2012>
- License: GNU GPL v3.0
- Provided the bulk of the layout and selector list used in `getEraLayoutCss()` inside `src/content/themeInjector.ts`. Square corners, the `.rbx-header` styling, the classic vote-bar layout, the chat-panel gradient, button gradients (silver tile and blue gradient), the friends-grid layout, and the popover styling all derive from CSS in this script.

## What we copied

CSS rules from these userscripts that target the modern Roblox DOM were adapted and trimmed for clarity. Specifically:

- Body / container basics and `970px` max-width
- Top navbar (`#rbx-header`, navbar search, popovers)
- Left rail mini-bar
- Game card / item card classic styling
- Game-detail page layout (Play button, calls-to-action, stats, vote bar)
- Tab edge sprites (the slice-9 `.png` references)
- Friends grid + status dots
- Chat panel header gradient
- Modal header tab style

## What we did **not** copy

- The `(function() { ... })();` immediate-invoked jQuery DOM rewrites at the top of `ROBLOX 2012.user.js` — these mutate page DOM at load time and were excluded as out-of-scope.
- The base64 `@icon` for the UserScript itself.
- The base64 `--buywithR` Buy-with-Robux button image.
- The `document.querySelector('link[rel="icon"]').href = '...'` favicon replacement.
- The Stylus preprocessor `if layout == "..."` conditional branches — these are not valid raw CSS. We picked the late-2014 baseline and inlined it.
- Deep avatar-editor, configure-group, and settings page reskins (out of scope and high collision risk with modern Roblox).
- BTRoblox-specific selectors (`.btr-*`) — useful only if the user also has BTRoblox installed.

## License implications

The `getEraLayoutCss()` function in `src/content/themeInjector.ts` (and only that function) is a derivative work of GPL v3 source. If this repository is redistributed in source or binary form, the GPL-derived portion must remain GPL v3.

The rest of the SviBlox extension is original work and is provided under the terms in the project's main README.

If you are the author of either source script and would like the attribution adjusted, removed, or reworded, open an issue at <https://github.com/L0rrdi/sviblox/issues> and the change will be made.
