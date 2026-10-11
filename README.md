# xan

Trim and shrink videos, or run them through Smoothie for motion blur and smoothing. Drop a clip in, set where it starts and ends, pick a size, export.
It is a desktop app (Electron) that uses ffmpeg, which is bundled, so there is nothing else to install.

Your original video is never changed. Exports are saved next to it (or in a folder you choose) as new files ending in `_compressed.mp4`.

## Run it

**Windows, prebuilt:** unzip the folder and double-click `xan.exe`.
Windows may say "Windows protected your PC" because the app is not code-signed: click **More info**, then **Run anyway**.

**From the source folder:**

1. Install Node.js (the "LTS" version from https://nodejs.org).
2. Double-click `Start xan.bat`. The first start downloads ffmpeg and Electron (a few minutes, once).

Or in a terminal: `npm install`, then `npm start`.

**Make your own installer:** double-click `Build Windows installer.bat` (or run `npm run dist`). The installer and a portable exe appear in `dist/`.

**Updates:** the installed version updates itself from GitHub. Set it up once and publish new versions with one double-click: see [UPDATES.md](UPDATES.md).

## Using it

1. **Drop** one or more videos onto the window (or click **Open**). Dragging a video onto `xan.exe` works too.
2. **Trim.** The coloured bar under the video is the part that will be exported.
   - Drag the edges of a segment, or play/scrub to a spot and press **I** (start) and **O** (end).
   - Type exact times in the Segments list if you want frame-precise cuts.
   - **+** adds another segment, the scissors split the segment at the playhead.
3. **Pick a target** in the Compression panel:
   - **Fit under 10 / 25 / 50 MB, or a custom size.** xan works out the bitrate for the clip's length and checks the result; if it lands over, it encodes again a little smaller.
   - **High quality / Balanced / Smallest file.** Constant quality: the file is as big as it needs to be.
   - Optional: H.265 (about 35% smaller, but older devices and some apps can't play it), a lower resolution or frame rate, audio options.
4. **Export.** Several segments become separate videos, or one video if you choose **Merge cuts** (top right).

Sizes use 1 MB = 1,000,000 bytes, so a "10 MB" file shows as about 9.5 MB in Windows Explorer.

### Smoothie (motion blur and smoothing)

Smoothie is its own page, separate from compressing. Add a clip (drop it on the page or press **Add clips**), pick your effects, press **Render**. You get `<name>_smoothie.mp4` next to the original, at a quality you choose (near lossless up to balanced). Nothing is squeezed to a size; for that, use **Trim & Compress**.

While anything renders, a **live preview** picture of the frames being made is shown in the progress window.

| Card | What it does in xan |
| --- | --- |
| Frame blending | Blends many frames into one for motion blur: for example 240 fps footage down to a smooth 60 fps. Intensity and weighting work like Smoothie's. |
| Interpolation | Makes new in-between frames (ffmpeg's built-in interpolation, so it is slow). Can be combined with frame blending. |
| Timescale | Input and output speed, with the audio following along. |
| Color grading, LUT | Brightness, saturation, contrast, and a .cube or .3dl LUT with opacity. |
| Flowblur | Blur that follows the motion. xan's own version: the real Smoothie uses RSMB, a paid plugin xan can't include, so it will not look identical. |
| Pre-interpolation | AI frame interpolation with RIFE (2x, 3x, 4x...) before everything else. Needs a graphics card with Vulkan support and a one-time download of about 13 MB (press **Download** in its card). Uses temporary picture files, so it needs free disk space. |
| Artifact masking | A black and white picture the size of your video. Black = the original frames show through, so a HUD or crosshair is not smeared by interpolation or flowblur. Switch it on per effect with "Use the mask". |

Save as many **configs** as you like. **Import** reads a `recipe.ini` from the real Smoothie; **Export** writes one back (settings xan can't use, such as tuning and algorithm, are kept as they were).

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| Space | Play / pause |
| I / O | Segment start / end at the playhead |
| + | Add a segment at the playhead |
| S | Split the segment at the playhead |
| Delete | Remove the selected segment |
| Left / Right | Back / forward 1 s (Shift: 5 s) |
| , / . | Back / forward one frame |
| Up / Down | Previous / next segment |
| Home / End | Start / end of the video |
| M | Mute the preview |
| Ctrl+O | Open video(s) |
| Ctrl+E | Export |
| F1 | Show shortcuts |

## Good to know

- **Speed.** Under **Compression > Encoder**, *Automatic* uses your graphics card (NVIDIA, AMD or Intel) when it can encode video, which is several times faster than the processor, and falls back to the processor by itself if the card can't do a clip. Pick *Processor only* for the best quality per MB. On the processor, *CPU speed* matters most: *Slow* can take several times longer than *Balanced*, and H.265 is slower than H.264.

- **The window scales.** The whole interface zooms to fit the window, from a small window up to a large screen.

- **Previews.** Videos the built-in player can't show reliably (HEVC from many GPU recorders, 10-bit, and so on) get a small low-res preview copy automatically. The export always uses your original.
- **Merge cuts** carries the first audio track only. Separate files keep every audio track unless you pick otherwise.
- **Size estimates** for the constant-quality presets are rough: it depends on how busy the footage is.
- Very small targets for long clips are refused up front instead of producing an unwatchable file.

## Development

```
npm test         # encoder tests against real ffmpeg, plus the release script against a fake GitHub
npm run test:ui  # launches the app and drives it (needs a display; add --no-sandbox in containers)
```

| File | What it does |
| --- | --- |
| `main.js`, `preload.js` | Electron main process and the safe bridge to the page |
| `lib/ffmpeg.js` | Probing, planning output files, the ffmpeg commands, progress, live preview, cancel |
| `lib/rife.js`, `lib/remotezip.js` | Downloading and running RIFE (only the parts needed are fetched from the project's zip) |
| `shared/smoothie.js` | The Smoothie recipe format and how each setting becomes an ffmpeg filter |
| `scripts/release.js` | Pushes the source to GitHub, builds the installer and publishes it to GitHub Releases (`Publish update.bat`) |
| `shared/core.js` | Presets, bitrate and size maths, time formatting (used by both sides) |
| `renderer/` | The interface (`common.js` shared bits, `app.js` the editor, `smoothie-page.js` the Smoothie page) |

Set `FFMPEG_PATH` / `FFPROBE_PATH` to use your own ffmpeg instead of the bundled one.
