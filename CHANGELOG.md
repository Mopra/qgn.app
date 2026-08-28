# Changelog

The top section is what ships in the next release. CI publishes it as the
release notes on GitHub, and the in-app update card links straight to it.

## 0.1.17

**Redaction can no longer be undone by stacking marks**

A pixelate block drawn over a solid one re-sampled the original image rather
than what was already painted, which put the hidden content back on screen in
pixelated but often still readable form. Pixelation now samples what is
underneath it, so redactions stack the way you would expect. If you have
shared a screenshot whose sensitive area was pixelated over a black block, it
is worth checking.

**Three more things that failed quietly**

- A recording whose microphone or system audio would not open no longer records
  in silence and tells you nothing. The control bar carries a warning badge for
  the whole take and a toast fires once, while the recording can still be redone.
- Saving in Markup mode with nothing to write back over (an imported file, or
  a Studio opened empty from the tray) used to copy to the clipboard and close
  the window without writing anything. It now lands as a new capture.
- Dismissing a failed update could still trigger the install it had just failed
  to download. A download that dies partway now reports it too, instead of only
  one that never starts.

**The capture overlay**

- Releasing the mouse settles the selection instead of taking it. Drag the
  edges and corners, drag inside to move it, nudge it with the arrow keys, then
  confirm with <kbd>Enter</kbd>, a double-click, or the Capture button.
  <kbd>Esc</kbd> drops the selection before it cancels the overlay. Switch it
  back to capturing on release in Settings.
- Click a window to capture exactly that window. Hovering shows what you would
  get, and edges snap to nearby windows while you drag (hold <kbd>Alt</kbd> to
  ignore them).
- A pixel loupe follows the cursor with a live coordinate and colour readout,
  for when the edge you want is one pixel wide.
- <kbd>Shift</kbd> constrains to a square, and <kbd>Space</kbd> now grabs the
  whole screen when recording, not only when capturing.

**Recent captures**

Every capture is kept in a small ring, so a preview card that timed out is no
longer gone. The tray has a Recent captures menu that puts any of the last
twelve back on screen as an ordinary card. It can be switched off in Settings,
which also forgets what is already stored.

**Studio: marks are editable after you place them**

Pick the pointer (<kbd>V</kbd>) and click a mark to select it. Drag it to move,
drag a handle to resize or scale it, recolour it from the row below, and delete
it with <kbd>Del</kbd>. Double-click a text label to fix a typo. Fixing one mark
no longer means undoing everything drawn after it.

**Studio: zoom and pan**

The preview was locked to fit-to-window, which on a 4K capture put two or three
source pixels behind every screen pixel. <kbd>Ctrl</kbd> + wheel zooms about the
cursor, the wheel pans, middle-drag pans, and <kbd>Ctrl 0</kbd> fits again.

**Clips render faster than real time**

MP4 and WebM exports went through a recorder that ran at playback speed: a
three-minute clip took three minutes. They now drive the encoder directly and
finish several times faster, with the same trim, zoom keyframes, cursor and
annotations. The old path is still there as a fallback.

**Crop is adjustable now**

Cropping used to be a one-shot marquee: whatever rectangle you dragged was
applied the moment you let go, so getting the framing right meant undoing and
trying again.

Picking the crop tool (R) now puts a rect over the whole image straight away,
and nothing is cut until you say so:

- Drag any side or corner to resize it, or drag inside it to move it. Start a
  drag outside it to draw a fresh one.
- A live pixel readout in the tool rail shows the size as you drag, next to an
  Apply button.
- Apply with the button, <kbd>Enter</kbd>, or a double-click on the rect.
  <kbd>Esc</kbd> puts the rect back to full size; a second <kbd>Esc</kbd>
  leaves the tool.
- Thirds guides and a dimmed surround show what you are keeping.

After a crop the rect re-arms over what's left, so trimming twice is just two
drags. Same tool in both Markup and Compose, on stills and clips.

## 0.1.16

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
