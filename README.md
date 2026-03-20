<p align="center">
  <img src="assets/logos/Logo Transparent BG.png" alt="QGN Logo" width="120" />
</p>

<h1 align="center">QGN</h1>

<p align="center">
  Quick screenshot capture and screen recording tool for Windows.
</p>

<p align="center">
  <strong>Source-available, not open source.</strong>
</p>

---

## About

QGN is a lightweight desktop tool that lets you capture screen regions instantly with a single hotkey. Screenshots are copied to your clipboard and optionally saved to disk. Floating preview cards let you pin, annotate, and manage your captures without leaving your workflow.

### Features

- **Instant capture** — Press `Ctrl+Q` to activate a fullscreen overlay, draw a selection, done
- **Clipboard-first** — Every capture is immediately copied to your clipboard (PNG, JPG, WebP, or base64)
- **Floating previews** — Captured screenshots appear as pinnable, always-on-top preview cards
- **Annotation editor** — Draw, mark up, and annotate images before sharing or saving
- **Screen recording** — Press `Ctrl+Shift+Q` to record screen regions with microphone input
- **Save to disk** — Optionally auto-save captures to a folder of your choice
- **System tray** — Runs quietly in the background, accessible from the tray

## Tech Stack

- **Electron** — Desktop application shell
- **Sharp** — Image processing and format conversion
- **Vanilla JS** — No framework overhead

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)

### Install & Run

```bash
git clone https://github.com/Mopra/qgn.app.git
cd qgn.app
npm install
npm start
```

### Build

```bash
npm run build
```

Produces a Windows x64 executable in the `dist/` directory.

## License

**All Rights Reserved.**

This code is **source-available** for personal, educational, and reference purposes only. You may view and study the code, but you may not modify, distribute, sublicense, or self-host it without explicit written permission.

For licensing inquiries, open an issue or reach out directly.
