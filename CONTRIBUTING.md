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
3. Test locally with `npm start`
4. Commit with a clear message describing what you changed and why
5. Push and open a Pull Request

## What to Contribute

- Bug fixes
- Performance improvements
- New annotation tools
- UI/UX improvements
- Documentation

## Code Style

- Vanilla JavaScript — no frameworks or transpilers
- Keep it simple and readable
- Each HTML file is a self-contained window with inline styles and scripts
- IPC communication goes through preload scripts, never expose Node APIs to renderers

## Reporting Bugs

Open an issue with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Your Windows version

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
