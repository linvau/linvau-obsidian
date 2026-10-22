# Linvau for Obsidian — pilot

> **Pilot build (0.0.x).** For internal testing via [BRAT](https://github.com/TfTHacker/obsidian42-brat). Not yet in the Community Plugins directory. Use a **test vault**.

Linvau publishes individual notes as live links: you choose a note, get a link, and every time you save, readers see the new version. You can pause, resume, regenerate or unpublish the link at any time.

## Disclosures

- **Network use:** only notes you explicitly publish are sent to the Linvau server (pilot: a Cloudflare Worker; the address is built in and can only be changed under Settings → Advanced, for development). Nothing else in your vault is read or uploaded.
- **Properties (frontmatter) are stripped on your device** and never uploaded.
- **Account required to publish:** the first time you publish, the plugin asks for your email and sends you a 6-digit code (no password). Installing and exploring the plugin needs no account; readers of your links never need one.
- **What is stored on the device:** this device's session (a renewable token), in Obsidian's local storage for this vault — never in the vault, so it does not travel with sync or git.
- **Email:** login codes are sent by Linvau through Cloudflare Email Service from `notify.linvau.com`.
- **No telemetry.** The pilot panel keeps a local log; you can copy it manually with "Copy diagnostics".

## Commands

| Command | What it does |
|---|---|
| Publish current note (or sync now) | Creates the link (first time) and copies it; afterwards forces a sync |
| Copy link of current note | Copies the live link |
| Pause / Resume link | Readers see "paused" immediately; same link and QR on resume |
| Regenerate link | Old link stops working (410); a new one is created |
| Unpublish current note | Removes the link and all versions from the server |
| Connect this device | Asks for your email and the 6-digit code we send you. Also opens by itself on your first publish |
| Disconnect this device | Ends this device's session. Your links stay online |
| Resolve conflict of current note | Appears only when another device published a different version and the vault sync did not settle it in 10 minutes |
| Open pilot panel | Sync latency P50/P95, notes published from this vault, the account's notes on other devices or vaults (open, copy, pause, resume, unpublish), event log |
| Copy diagnostics | Copies a JSON report (no note content) |

## Development

```bash
npm install
npm run dev     # watch build into main.js
npm run build   # typecheck + production build
```

Release: `npm version patch && git push --follow-tags` (or Actions → *Release plugin* → Run workflow). The workflow attaches `main.js`, `manifest.json` and `styles.css` to a GitHub release, which is what BRAT installs.
