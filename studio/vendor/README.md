# Vendored muxers

Two third-party files, checked in rather than installed, because the renderer
loads plain `<script>` tags and there is no bundler in this project.

| File | Package | Version | License |
|---|---|---|---|
| `mp4-muxer.js` | [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) | 5.2.2 | MIT |
| `webm-muxer.js` | [webm-muxer](https://github.com/Vanilagy/webm-muxer) | 5.1.4 | MIT |

They are the UMD builds, unmodified, exposing the globals `Mp4Muxer` and
`WebMMuxer`.

## Why these are here

Studio's fast export encodes frames with the browser's own `VideoEncoder`
(WebCodecs), which hands back raw H.264 / VP9 chunks. Something still has to
write those chunks into an MP4 or WebM container, and a container writer is the
one part of the pipeline that is genuinely not worth hand-rolling: the box
layout, timescales and cue points are fiddly and get silently wrong in ways that
only some players notice.

The alternative was bundling ffmpeg, which would roughly double the installer
for a job these 140 KB do.

## Updating

Both packages are marked deprecated upstream in favour of
[Mediabunny](https://github.com/Vanilagy/mediabunny), which was not adopted here
because it is 658 KB and MPL-2.0 against this project's MIT. They are pinned and
stable; if they ever need replacing, `exportFast` in `studio/video.js` is the
only caller.

To refresh: `npm pack mp4-muxer@<version>`, take `build/mp4-muxer.js`, and copy
the LICENSE alongside it.
