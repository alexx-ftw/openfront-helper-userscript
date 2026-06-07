# OpenFront Helper — standalone userscript

A self-contained **userscript** for [OpenFront.io](https://openfront.io/) that
adds three things the base game doesn't have:

- **Auto-join** — keep searching the public lobby list and auto-join the first
  match for your filters (team size, map, modifiers, start gold).
- **In-game overlays** — gold-per-minute, team build stats (with a first-Missile-Silo
  warning), trade balances, alliance/nuke/boat prediction, heatmaps, and more.
- **Auto-bot** — a private-lobby training bot you can configure live in-game.

One `.user.js` file with a built-in **multi-language** UI. Works under
[Tampermonkey](https://www.tampermonkey.net/),
[Violentmonkey](https://violentmonkey.github.io/), and
[quoid/Userscripts (Safari)](https://github.com/quoid/userscripts).

## Install

1. Install a userscript manager (Tampermonkey / Violentmonkey / Userscripts).
2. Open the raw script — the manager shows its install prompt; confirm it:
   <https://raw.githubusercontent.com/nguyenvancaokyfpt/openfront-helper-userscript/main/openfront-helper.user.js>
3. Load <https://openfront.io/>. A draggable **⊕** icon appears — click it for the
   settings popup; the floating auto-join panel and in-game overlays load on their own.

The script declares `@updateURL` / `@downloadURL`, so your manager checks for new
versions automatically.

## Usage

- **⊕ launcher** — drag it anywhere; click to open the popup (**Esc** or click
  outside to close). Tabs: **Auto-Join** (with _Filters_ / _Maps_ sub-tabs),
  **Helpers**, **Auto Bot**, **Settings**.
- **Auto-Join** — toggle it on, then pick team size / minimum lobby size / maps /
  modifiers. The floating panel shows the live search and lobby forecast.
- **Helpers** — turn individual in-game overlays on or off.
- **Auto Bot** — open it while in a private lobby to enable and tune the bot.
- **Settings → Language** — searchable language picker; missing text falls back
  to English and applies in-game too.

## Languages

The Settings tab lists every available language, and English is always the fallback
for any untranslated text.

To add a translation: copy `locales/en/` to `locales/<code>/`, translate the values
(keep the keys), and rebuild — the new language shows up in the picker automatically.

## Build from source

```bash
npm install
npm run build       # → openfront-helper.user.js (minified)
npm run build:raw   # unminified build (readable source + console.log for debugging)
npm run check       # type-check
npm test            # smoke test
```

## Credits

This project builds on
**[phil0010-gh/openfront-helper](https://github.com/phil0010-gh/openfront-helper)**
by [phil0010-gh](https://github.com/phil0010-gh) — the in-game overlays and helper
panels are adapted from it. The **auto-bot**, a number of additional features, and
the **UI** (the vanilla, multi-language popup and the in-game panels) are original
to this project. Huge thanks to phil0010-gh for the foundation.

Not affiliated with or endorsed by OpenFront.io. Use at your own discretion and in
line with the game's rules.
