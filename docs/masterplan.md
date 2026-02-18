# qgn — Masterplan

## What is qgn?

qgn is a desktop tool that turns anything on your screen into code. Select any UI component, button, card, or layout you see — in a browser, a game, a native app, anywhere — and get a production-ready React + Tailwind component back in seconds.

## The Problem

Building web apps in React with Tailwind means constantly recreating UI you've already seen somewhere else. You spot a nice component on a website, a clean layout in a game menu, a slick button in a native app — and then you spend 20-60 minutes manually rebuilding it in code. The gap between "I see it" and "I have it in my codebase" is way too wide.

## The Solution

One hotkey. Select the area. Get the code.

1. Press **Ctrl+Q** to activate the screen overlay
2. Draw a selection around the component you want
3. The screenshot is sent to an AI model (OpenAI) with instructions to convert it to a React + Tailwind component
4. The generated component code is copied to your clipboard, ready to paste

No context switching. No manual recreation. No design-to-code translation in your head.

## Core Features

### Primary: Image-to-Code (the main event)

- **Screen selection** — Full-screen overlay with crosshair selection (already built)
- **AI conversion** — Send the captured image to OpenAI's vision API with a system prompt optimized for React + Tailwind output
- **Clipboard output** — Generated component code is copied to clipboard automatically
- **Quick iteration** — The whole flow should take under 10 seconds from hotkey to code in clipboard

### Secondary: Screenshot Capture (already working)

- Select an area, get the image copied to clipboard
- Useful on its own as a lightweight screenshot tool
- This is the current functionality and should remain available as a mode

## Architecture

### Current Stack

- **Electron** — Desktop shell, global hotkeys, screen capture, clipboard access
- **Main process** (`main.js`) — Window management, `desktopCapturer`, tray icon, IPC
- **Overlay** (`overlay.html`) — Transparent fullscreen window with selection UI
- **Preload** (`preload.js`) — IPC bridge between overlay and main process

### What Needs to Be Built

#### 1. Mode System

After the user completes a selection, they need to choose what happens with it:

- **Screenshot mode** (current behavior) — Copy image to clipboard
- **Code mode** (new) — Send to AI, get component code back

How the user picks the mode is TBD. Options:
- Different hotkeys (e.g. Ctrl+Q for screenshot, Ctrl+Shift+Q for code)
- Post-selection toolbar with two buttons
- Settings/default mode toggle in tray menu

#### 2. AI Integration

- OpenAI API integration (GPT-4o vision or latest model with image input)
- System prompt engineering for React + Tailwind output
- API key management (stored securely, configured via settings)
- Handle the image → base64 → API call → parse response pipeline

#### 3. Prompt Engineering

The system prompt is critical. It needs to instruct the AI to:
- Output a single, self-contained React functional component
- Use Tailwind CSS classes exclusively for styling
- Match the visual appearance as closely as possible
- Use sensible prop names and component structure
- Not include any imports/boilerplate beyond the component itself (or make this configurable)

#### 4. Output & Feedback

- Copy generated code to clipboard
- Show a small notification/toast confirming success
- Loading indicator while AI processes (small floating indicator, not blocking)
- Error handling for API failures, rate limits, etc.

#### 5. Settings & Configuration

- OpenAI API key input
- Default mode (screenshot vs code)
- Custom system prompt override (power user feature)
- Output format options (TSX vs JSX, with/without props interface)
- Hotkey customization

## UX Flow (Code Mode)

```
User presses Ctrl+Q
  → Screen freezes (captured)
  → Overlay appears with crosshair

User drags selection
  → Selection rectangle with dimensions shown

User releases mouse
  → Small floating "processing..." indicator appears
  → Screenshot is sent to OpenAI Vision API
  → Response is parsed → component code extracted
  → Code copied to clipboard
  → Toast: "Component copied to clipboard"
```

## Business Model

### Open Source + Subscription

The app is open source. The core functionality is free forever — no paywalls, no feature gates on the desktop tool itself.

### Free Tier (no account required)

Everything that runs locally is free:

- **Screenshot capture** — Works out of the box, no setup needed
- **Image-to-code with BYO API key** — Bring your own OpenAI key, use it unlimited
- **All local features** — Modes, hotkeys, settings, prompt customization

This is the full app. No crippled demo, no trial period, no nag screens. Users who never want to pay never have to.

### Subscription Tier (qgn Pro / qgn Cloud)

For users who want convenience and cloud features:

- **Managed AI — no API key needed.** Subscribe and it just works. No OpenAI account, no key management, no billing surprises. We handle the AI calls.
- **Component library.** Every component you generate is saved and searchable. Browse your history, re-use past captures, build up a personal library over time.
- **Image capture history.** Screenshots are stored too — not just code mode captures.
- **Cloud sync.** Your library and settings sync across machines.
- **Team sharing.** Share components with your team. Shared library of captured components.
- **Custom prompt presets.** Save and switch between prompt configurations (e.g. one for landing pages, one for dashboards, one that outputs Vue instead of React).
- **Priority processing.** Faster AI responses, access to latest models.

### Why This Works

- **Free tier gets the app installed.** Screenshot mode alone is useful enough to keep running. The more installs, the more people discover and try code mode.
- **BYO key removes cost risk.** We're not subsidizing anyone's API usage. Power users who already have keys get full value for free — and they tell other devs about it.
- **Subscription sells convenience + cloud, not core features.** Users aren't paying to unlock the tool. They're paying to skip API key setup AND get a component library, history, sync, and sharing on top. Much easier sell.
- **Open source builds trust.** People can verify we're not doing anything shady with their screen captures. It also attracts contributors and community goodwill.

### Pricing (TBD)

Ballpark thinking — needs market validation:
- Free: $0, forever
- Pro: ~$8-12/mo (individual, managed AI + cloud library)
- Team: ~$15-20/mo per seat (shared library, team features)

## Technical Decisions to Make

| Decision | Options | Notes |
|----------|---------|-------|
| Mode selection UX | Separate hotkeys / post-selection toolbar / tray toggle | Separate hotkeys is simplest to build |
| AI provider | OpenAI / Anthropic / both | Start with OpenAI (GPT-4o), can add others later |
| API key storage | Electron store / OS keychain / env var | Electron store is simplest, keychain is most secure |
| Settings UI | Tray menu only / dedicated settings window | Start with tray, add window if needed |
| Output format | JSX / TSX / configurable | Default TSX, make configurable |
| Auth for subscription | Clerk / Auth0 / custom | Needs to work in Electron context |
| Cloud storage | Supabase / Firebase / custom API | For component library and image history |
| Payment processing | Stripe | Standard for SaaS subscriptions |

## Milestones

### v0.1 — Screenshot Tool (done)
- [x] Global hotkey activation
- [x] Full-screen overlay with selection
- [x] Crop and copy to clipboard
- [x] System tray with menu

### v0.2 — Image-to-Code MVP
- [ ] OpenAI API integration
- [ ] System prompt for React + Tailwind conversion
- [ ] Code output to clipboard
- [ ] Basic loading/success/error feedback
- [ ] API key configuration (tray menu or simple settings)

### v0.3 — Polish & Modes
- [ ] Dual-mode support (screenshot vs code)
- [ ] Mode selection UX
- [ ] Toast notifications
- [ ] Better error handling and retry logic

### v0.4 — Power User Features
- [ ] Custom system prompt configuration
- [ ] Output format options (JSX/TSX, with/without types)
- [ ] Multiple AI provider support
- [ ] Hotkey customization
- [ ] Settings window

### v0.5 — Subscription & Cloud
- [ ] Auth integration (sign up / sign in from the app)
- [ ] Stripe payment integration
- [ ] Managed AI endpoint (proxy API calls through our backend)
- [ ] Component library (save, browse, search generated components)
- [ ] Image capture history
- [ ] Cloud sync for settings and library

### v0.6 — Team Features
- [ ] Team accounts
- [ ] Shared component library
- [ ] Team billing

## Non-Goals (for now)

- Web app version — this is a desktop tool (though a web dashboard for the component library could come later)
- Real-time preview of generated code
- Built-in code editor
- Plugin/extension marketplace
- Mobile app
