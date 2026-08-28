<p align="center">
  <img src="assets/logos/Logo Transparent BG.png" alt="QGN Logo" width="120" />
</p>

<h1 align="center">QGN</h1>

<p align="center">
  Instant screenshot capture and screen recording for Windows.<br />
  One hotkey. Clipboard-first. No cloud, no account, no subscription.
</p>

<p align="center">
  <a href="https://qgn.app">Website</a> &middot;
  <a href="https://github.com/Mopra/qgn.app/releases/latest">Download</a> &middot;
  <a href="https://github.com/Mopra/qgn.app.website">Website Source</a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/license/Mopra/qgn.app?style=flat-square" alt="License" />
  <img src="https://img.shields.io/github/v/release/Mopra/qgn.app?style=flat-square" alt="Latest Release" />
  <img src="https://img.shields.io/badge/platform-Windows%2010%2B-blue?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/github/downloads/Mopra/qgn.app/total?style=flat-square" alt="Downloads" />
</p>

---

## What is QGN?

QGN (Quick Gen) is a lightweight, open-source desktop screenshot tool for Windows. Press `Ctrl+Q`, select a region, and your screenshot is instantly on your clipboard. No sign-ups, no cloud uploads, no monthly fees: just fast screen capture that stays out of your way.

**Website:** [qgn.app](https://qgn.app)

## Features

### Capture
- **Instant hotkey capture:** `Ctrl+Q` activates a fullscreen overlay with crosshair cursor
- **Pixel-precise region selection:** Click and drag to capture exactly what you need
- **Full-screen capture:** Press `Space` on the overlay (or use the tray menu) to grab the whole display
- **Real-time dimension display:** See pixel width and height as you drag
- **Multi-monitor support:** Works across all connected displays seamlessly
- **Clipboard-first:** Every capture is on your clipboard before the overlay closes
- **Multiple formats:** Copy as PNG (default), JPG, WebP, or base64 Data URI (with adjustable JPG/WebP quality)

### Screen Recording
- **Region recording:** `Ctrl+Shift+Q` to record any screen region
- **Microphone input:** Toggle mic and pick your audio device
- **Pause & resume:** Pause mid-recording and pick up where you left off
- **Optional countdown:** A 3-2-1 pre-roll before recording starts (configurable)
- **Format options:** Export as MP4 or WebM
- **Visual indicator:** Pulsing red border shows what's being recorded

### Floating Previews
- **Always-on-top cards:** Captures appear as draggable, resizable preview windows
- **Drag out to any app:** Drag the thumbnail straight into Slack, email, or an editor
- **Copy again:** Re-copy a capture to the clipboard with one click
- **Pin and stack:** Pin previews to keep them between sessions
- **Persistent pins:** Pinned cards survive app restarts and reboots
- **Auto-dismiss:** Unpinned previews fade after a configurable timer (5s/10s/20s/Never)

### Studio

One editor for screenshots and recordings, in two modes. **Markup** works on the
pixels themselves and saves back over the original. **Compose** frames the
capture on a background and saves a new file. Every annotation tool is available
in both, and on clips as well as stills.

**Annotation tools**
- **Drawing:** freehand drawing, arrows, and shapes (rectangle, ellipse, diamond, line)
- **Text:** add text labels anywhere, in three sizes
- **Numbered callouts:** auto-incrementing numbered markers
- **Redaction:** solid block (default, unrecoverable) or pixelate, for hiding sensitive information
- **Crop:** trim down to what matters, and undo it later
- **Cursor stamp:** drop a mouse pointer anywhere (captures are cursor-free, so you place it deliberately)
- **Six colors,** and every tool on a single-key shortcut (V, D, A, S, T, X, C, P, R)
- **Undo and redo:** `Ctrl+Z` / `Ctrl+Y` across annotations and crops alike

**Composition**
- **Backgrounds:** gradients, wallpapers, solid colors, or your own image
- **Saved palettes:** keep custom gradients and colors for reuse
- **Frames:** none, a plain window, or browser chrome with an address bar
- **Layout:** padding, corner rounding, shadow depth, and a fixed aspect ratio

**Recordings**
- **Trim:** set in and out points on the timeline
- **Zoom keyframes:** auto-generated from your clicks, or placed by hand with easing and a focus point
- **Synthetic cursor:** an optional styled pointer with click ripples
- **Export:** MP4, WebM, GIF, or animated WebP, with an output size estimate

### System Integration
- **System tray:** Runs invisibly in the tray, no window to manage
- **Annotate clipboard image:** Open the editor on whatever image is on your clipboard
- **Auto-save:** Optionally save every capture to a folder with timestamps
- **Single instance:** Launching again triggers a capture instead of a second copy
- **Customizable hotkeys:** Rebind capture and recording shortcuts (with conflict detection and reset)
- **Start with Windows:** Optional startup with your system
- **Auto-updates:** Background update checks with one-click install

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Desktop shell | Electron |
| Image processing | Sharp |
| UI | Vanilla HTML/CSS/JS |
| Build system | electron-builder |
| Auto-updates | electron-updater |
| Distribution | GitHub Releases (NSIS installer) |

No framework overhead. Vanilla JavaScript throughout. The entire app is a single `main.js` file plus HTML views.

## Download

Grab the latest installer from the [Releases](https://github.com/Mopra/qgn.app/releases/latest) page, or download directly:

**[Download QGN-Setup.exe](https://github.com/Mopra/qgn.app/releases/latest/download/QGN-Setup.exe)** (85 MB, Windows 10+)

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- Windows (for building the installer)

### Setup

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

Produces a Windows NSIS installer in the `dist/` directory.

### Project Structure

```
qgn.app/
├── main.js                  # Main Electron process (windows, IPC, capture)
├── overlay.html             # Fullscreen capture overlay
├── preview.html             # Floating preview card
├── studio.html              # Studio: the editor shell (markup + compose, stills + clips)
├── studio/                  # Studio modules (scene, annotation, motion, video, sidebar)
├── settings.html            # Settings panel
├── record-control.html      # Recording control bar
├── welcome.html             # First-run welcome screen
├── *-preload.js             # IPC bridge scripts for each window
├── lib/                     # Pure main-process logic, unit tested on its own
├── assets/                  # Logos and images
├── icons/                   # App icons (tray, installer)
├── scripts/                 # Checks, tests, and icon generation
├── CHANGELOG.md             # Release notes, published to GitHub by CI
└── .github/workflows/       # CI/CD (release + version bump)
```

### Tests

```bash
npm run check   # syntax, HTML inline scripts, lib unit tests, main-process boot
npm run smoke   # boots a hidden Studio window and drives it end to end
npm test        # both
```

`check` needs no dependencies and no display, and runs on every push. `smoke`
launches a real Electron window (hidden) and renders an actual clip and
animation, so it needs a desktop session; run it locally for anything touching
Studio.

## Related Repositories

| Repository | Description |
|-----------|-------------|
| [qgn.app](https://github.com/Mopra/qgn.app) | The desktop application (this repo) |
| [qgn.app.website](https://github.com/Mopra/qgn.app.website) | Marketing website at [qgn.app](https://qgn.app) |

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE), free to use, modify, and distribute.
