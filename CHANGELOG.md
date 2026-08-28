# Changelog

The top section is what ships in the next release. CI publishes it as the
release notes on GitHub, and the in-app update card links straight to it.

## 0.1.15

**Studio: one editor for screenshots and recordings**

The separate annotation editor and video studio are gone. There is now a single
Studio window that handles stills and clips, in two modes:

- **Markup** works on the pixels themselves and saves back over the original,
  the way the old annotation editor did.
- **Compose** frames the capture on a background and saves a new file.

Every annotation tool works in both modes, and on clips as well as stills.
Switching between modes keeps your framing, so a round trip no longer throws
away the background and padding you set up.

**Annotation**

- Marks are stored in original image pixels, so they stay put when you crop,
  change the aspect ratio, resize the window, or export at any scale.
- Crop is undoable, and sits on the same undo stack as everything else.
- New pointer tool (V) for when you want to look without drawing.
- Text comes in three sizes; callouts, redaction (solid block or pixelate) and
  the cursor stamp all carry over.

**Recordings**

- Trim a clip with in and out points on the timeline.
- Zoom keyframes, generated automatically from where you clicked while
  recording, or placed by hand with adjustable easing and a focus point.
- An optional styled cursor with click ripples, layered over the recording.
- Export to MP4, WebM, GIF or animated WebP, with a size estimate before you
  commit to a render.

**Fixes**

- Pressing the capture shortcut during recording setup no longer strands the
  recording control bar on screen with no way to dismiss it.
- Exported GIFs and WebPs no longer offer a "Open in Studio" button that could
  not actually open them.
- Long GIF and WebP exports used to fail outright past about 90 seconds, and
  could exhaust memory before that. They now scale resolution and sampling to
  fit, so a long clip renders as a smaller animation instead of an error.
- A render whose playback stalls now reports the problem instead of sitting at
  0% forever, and an empty render is reported rather than written out as a
  broken file.
- A clip that will not report its length no longer leaves Studio stuck on
  "Loading video".
- A new preview card no longer appears offset when pinned cards are on screen.
- The pinned-card list is written atomically, so an unclean shutdown cannot
  lose every pin.
- The recording capture loop survives a bad frame instead of freezing on it.
- Motion capture no longer double-logs events after a failed start, and a
  recording stopped while paused reports its true length.
- Temporary files created by dragging a capture out are cleaned up on quit.

**Update card**

- Shows which version is being installed, with a "What's new" link to the
  release notes.

## Earlier releases

Summarized from the commit history.

- **0.1.14** Quality-of-life improvements across capture, previews, the editor
  and recording.
- **0.1.13** Fixed IPC listener leaks, hardened input validation, improved
  reliability.
- **0.1.12** Fixed an auto-updater race condition, added a download stall
  timeout.
- **0.1.11** Fixes from a comprehensive code review.
- **0.1.10** CLI capture mode, lazy-loaded auto-updater, redesigned update
  toast.
- **0.1.9** Replaced executeJavaScript with IPC messaging, added the MIT
  license, overhauled the docs.
- **0.1.8** Welcome window, shape tools, pixelated redaction, start on startup,
  stream resilience.
- **0.1.7** Record as MP4 where supported.
- **0.1.6 and earlier** Initial releases and the release pipeline.
