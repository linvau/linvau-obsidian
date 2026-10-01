# Linvau for Obsidian — pilot

> **Pilot build (0.0.x).** For internal testing via [BRAT](https://github.com/TfTHacker/obsidian42-brat). Not yet in the Community Plugins directory. Use a **test vault**.

Linvau publishes individual notes as live links: you choose a note, get a link, and every time you save, readers see the new version. You can pause, resume, regenerate or unpublish the link at any time.

## Disclosures

- **Network use:** only notes you explicitly publish are sent to the Linvau server configured in settings (pilot: a private Cloudflare Worker). Nothing else in your vault is read or uploaded.
- **Properties (frontmatter) are stripped on your device** and never uploaded.
- **Account:** the pilot uses a single access token, stored in this device's local storage (not in the vault).
- **No telemetry.** The pilot panel keeps a local log; you can copy it manually with "Copy diagnostics".

## Commands

| Command | What it does |
|---|---|
| Publish current note (or sync now) | Creates the link (first time) and copies it; afterwards forces a sync |
| Copy link of current note | Copies the live link |
| Pause / Resume link | Readers see "paused" immediately; same link and QR on resume |
| Regenerate link | Old link stops working (410); a new one is created |
| Unpublish current note | Removes the link and all versions from the server |
| Open pilot panel | Sync latency P50/P95, published notes, event log |
| Copy diagnostics | Copies a JSON report (no note content) |

## Development

```bash
npm install
npm run dev     # watch build into main.js
npm run build   # typecheck + production build
```

Release: `npm version patch && git push --follow-tags` (or Actions → *Release plugin* → Run workflow). The workflow attaches `main.js`, `manifest.json` and `styles.css` to a GitHub release, which is what BRAT installs.
