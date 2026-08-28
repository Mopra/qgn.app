# Contributing to QGN

Thanks for your interest in contributing to QGN! Here's how to get started.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/qgn.app.git`
3. Install dependencies: `npm install`
4. Run the app: `npm start`

## Making Changes

1. Create a branch for your change: `git checkout -b my-feature`
2. Make your changes
3. Run `npm run check` (syntax, unit tests, and a stubbed main-process boot).
   CI runs the same thing on every push.
4. Run `npm run smoke` for anything touching Studio. It boots a real hidden
   Electron window on `studio.html`, drives the editor, and renders both a clip
   and an animation end to end. It needs a desktop session, so it is not part
   of `check`.
5. Test by hand with `npm start`
6. If the change is user-visible, add a line to the top section of
   `CHANGELOG.md`. CI publishes that section as the GitHub release notes.
7. Commit with a clear message describing what you changed and why
8. Push and open a Pull Request

## What to Contribute

- Bug fixes
- Performance improvements
- New annotation tools
- UI/UX improvements
- Documentation

## Code Style

- Vanilla JavaScript, no frameworks or transpilers
- Keep it simple and readable
- Each HTML file is a self-contained window with inline styles and scripts.
  Studio is the exception: it is large enough that its logic lives in
  `studio/*.js` modules loaded as plain classic scripts.
- Pure main-process logic that is worth testing belongs in `lib/`, which
  `scripts/test-lib.js` covers directly
- IPC communication goes through preload scripts, never expose Node APIs to renderers

## Reporting Bugs

Open an issue with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Your Windows version

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
