# Linvau for Obsidian

Publish individual notes as **live links**. Choose a note, get a link, and every time you save, readers see the new version. Pause, resume, regenerate or unpublish the link at any time. Review changes before they go live, protect a note with a password, and share a QR code.

Readers need no account and no Obsidian.

## Install

1. In Obsidian: **Settings → Community plugins → Browse**, search for **Linvau**, install and enable it.
2. Open a note and run the command **Linvau: Publish current note (or sync now)**. The first time, you connect with your email: we send you a 6-digit code, no password.

*Before the plugin appears in the directory,* you can install it with [BRAT](https://github.com/TfTHacker/obsidian42-brat) using this repository.

## Plans

| | Free | Pro |
|---|---|---|
| Active shared notes | 3 | No limit |
| Password, Review mode, QR code | Yes | Yes |

Prices and the full plan comparison: <https://linvau.com/#pricing>. Upgrade from **Settings → Linvau → Plan** or with the command **Upgrade to Pro**. A Pro subscription can be cancelled at any time from **Manage subscription**; there is a 10-day money-back guarantee. When an account goes back to Free, notes over the limit are **paused, not deleted**, and resume when you upgrade again.

## Disclosures

These are required by Obsidian's developer policies:

- **Account required to publish.** Installing and exploring the plugin needs no account. Publishing needs a Linvau account (email and a code; no password). Readers of your links never need one.
- **Payment required for full access.** Pro is a paid subscription. The plugin does not process payments and never sees card data: it opens the payment page of **Creem** (our payment provider and merchant of record) in your browser. The plugin only receives your plan and subscription status from the Linvau server.
- **Network use.** Only the notes you choose to publish (and the attachments they embed) are sent to `api.linvau.com`; readers open them at `linvau.online`. The plugin also asks that server for your plan and subscription status. Nothing else in your vault is read or uploaded.
- **Properties (frontmatter) are removed on your device** before anything is sent.
- **Local storage.** This device's session (a renewable token) is kept in Obsidian's local storage for the vault, never inside the vault, so it does not travel with sync or git.
- **Closed-source service.** This plugin is MIT-licensed. The Linvau server that stores and serves published notes is proprietary.
- **No client-side telemetry.** The plugin keeps a local event log you can copy manually with **Copy diagnostics** (it contains no note content). The server keeps short-lived technical logs; see the Privacy Policy.
- **No ads.** Published pages show a small Linvau mark in their status bar; it is part of the published page, not an ad inside the plugin.
- **Not affiliated with Obsidian.**

## Commands

| Command | What it does |
|---|---|
| Publish current note (or sync now) | Creates the link (first time) and copies it; afterwards forces a sync |
| Copy link of current note | Copies the live link |
| Pause / Resume link | Readers see "paused" immediately; same link and QR on resume |
| Regenerate link | Old link stops working; a new one is created |
| Unpublish current note | Removes the link and all versions from the server |
| Set or change password… / Remove password | Readers must enter it to open the note |
| Switch to Review mode / Live mode, Publish revision… | Saves wait until you publish them |
| Embedded content of current note… | Choose which embedded notes and attachments are published |
| Upgrade to Pro… | Opens the payment page in your browser |
| Manage subscription (billing portal) | Cancel, change card, download invoices |
| Connect / Disconnect this device | Email + 6-digit code. Disconnecting keeps your links online |
| Resolve conflict of current note | Appears only if another device published a different version |
| Open sync panel | Sync latency, notes published from this vault and from your other devices, event log |
| Copy diagnostics | Copies a JSON report (no note content) |

## Privacy, terms and support

- [Terms](https://linvau.com/terms/) · [Privacy Policy](https://linvau.com/privacy/) · [Support](https://linvau.com/support/)
- Support: support@linvau.com (Monday to Friday, 9:00–17:00 Argentina time). Report abusive content: abuse@linvau.com.

## Development

```bash
npm install
npm run dev     # watch build into main.js
npm run build   # typecheck + production build
```

Release: `npm version patch && git push --follow-tags` (or Actions → *Release plugin* → Run workflow). The workflow attaches `main.js`, `manifest.json` and `styles.css` to a GitHub release. The tag must equal the version in `manifest.json` (no "v").

## License

MIT, see [LICENSE](LICENSE). Third-party software: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
