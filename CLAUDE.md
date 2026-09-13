# booky

Local, single-user Mac tool that turns a streamed audiobook into chapter files.
Flow: paste an HLS url → download once → auto-detect pauses → adjust splits and trims in a
waveform UI → export one AAC file per chapter. Built for Emil and his girlfriend, so the UI
must stay simple enough for a non-developer.

## Stack and conventions

- `booky.py`: the whole backend. A uv single-file script (deps in the header), FastAPI + uvicorn
  on `127.0.0.1:8765`, opens the browser on start. Env: `BOOKY_NO_BROWSER=1` skips the browser,
  `BOOKY_PORT` changes the port, `BOOKY_DEV=1` enables uvicorn reload. Without reload, backend
  edits need a restart of the running app; static files are always served fresh.
- `static/index.html`, `static/app.js`, `static/style.css`: the whole frontend. Vanilla JS,
  no framework, no build step, no npm. Keep it that way.
- All audio work shells out to ffmpeg/ffprobe. Everything is stream copy (`-c copy`): download,
  remux, and chapter cuts. Never re-encode. Cuts land on AAC frame boundaries (~20 ms), fine for speech.
- ffmpeg resolution: system binary if on PATH, otherwise the `static-ffmpeg` package downloads a
  static build on first run. Do not add Homebrew ffmpeg back to `just install`; its dependency
  tree (Qt, OpenCV, ...) broke installs.
- macOS only is acceptable (`open` for Show in Finder, `.command` launcher, Finder alias).
- Long operations (fetch, analyze, export) run as background threads in the in-memory `JOBS`
  dict; the UI polls `/api/job/{id}` and shows the `log` string as status.
- Danish project and chapter names are normal; `safe_name` allows æøå.

## Files on disk

```
projects/<name>/              (gitignored)
  project.json                saved state: url, fetched_at, duration, peak_db, gap, noise, splits, chapters, prefix
  source/source.aac           raw HLS download (ADTS)
  source/master.m4a           remuxed copy; raw ADTS seeks are inaccurate, the mp4 index is exact
  source/peaks.bin            waveform, one uint8 per 1/100 s
  output/<n> <name>.aac       exported chapters, wiped on every export
```

`chapters[i]` belongs to segment `i` whose bounds are `[0, ...splits, duration][i..i+1]`.
`name: null` means "use the default name `chapter`" (the export prefix carries the number).
`start`/`end` are absolute trims inside the segment. `enabled: false` excludes a chapter from
export and greys it out; a missing flag means enabled. Only exported chapters are numbered.

Export filenames are `<n> <name>.aac`, `n` zero-padded only when there are 10+ chapters; the
"number files" checkbox next to Export (`prefix`) turns the number off. `peak_db` is the loudest
sample in dBFS (ffmpeg volumedetect), used to place the silence-threshold line on the waveform
while the silence slider is dragged; it is computed lazily for projects that predate it.

## Save model (important)

- `project.json` is written by fetch/analyze and by **Export only**. Edits (splits, trims, names,
  slider values) live in the browser until exported.
- Dirty = editable state differs from the last loaded/exported snapshot. Leaving a dirty project
  (switching, creating) prompts Export / Discard / Cancel. Discard reverts in memory.
- Export wipes `output/`, writes every chapter, then saves `project.json`.

## Editing rules in the UI

- Splits changing re-derives chapters via `reconcile()`: a chapter survives if one of its
  segment bounds is unchanged; a trim sitting on a moved bound follows it. Re-detect and
  Clear all ask for confirmation when any chapter has a custom name or trim.
- Trimmed audio is dropped, never handed to the neighbouring chapter.
- Clicking a split or a trim handle always moves the playhead there, so space plays from it.
- Each chapter card has one Play button. Playing or clicking inside a chapter timeline arms
  `stopAt` = that chapter's end; playback never rolls into the next chapter. Seeking in the
  main timeline clears it. Opening a modal or focusing a text field pauses playback.
- Zoom is pinch only (ctrl+wheel). Plain vertical scroll scrolls the page; horizontal swipe or
  shift+scroll pans. Zoom buttons and +/- keys zoom around the playhead.
- Every action has a button; shortcuts are printed on the buttons. Undo is a stack of full
  state snapshots. Drags record one undo step, and only if something actually moved.
- Theme: light/dark toggle in the sidebar footer, stored in localStorage. Canvas colours come
  from CSS variables via `readTheme()`; never hardcode colours in `app.js`. Segments get a
  colour from the `HUES` palette by index, used as tint on the main timeline and as the dot and
  left border of the chapter card. Cards are not numbered; numbers exist only in export names.
- The page itself never zooms: pinch, ⌘± and gesture events are swallowed outside the timelines.
- Default detection: gap 3.0 s, silence -35 dB.

## Running and distributing

- `just run` or `uv run booky.py` for development. `.claude/launch.json` starts it for the
  browser pane without opening a system browser.
- `Booky.command` (in the repo) does `git pull --ff-only` then `uv run booky.py`. An alias to it
  lives on the Desktop. Keep the launcher in the repo so it updates itself.
- `just install`: one-time setup on a Mac with Homebrew (`uv`, `just`, dependency sync,
  Desktop alias). Distribution is: clone the repo, run `just install`, double-click the alias.
  Updates arrive via the launcher's `git pull`, so `main` must always be runnable.
- Existing test material: `projects/stine_agurk` (~59 min Danish children's audiobook from
  pubhub.dk). The pubhub HLS urls have not expired so far and download in ~10 s.

## Testing

No test suite. Verify changes in the browser against `stine_agurk`: index/fetch, seek, add and
drag splits, undo, trim handles, name a chapter, export, check `output/` with ffprobe, and the
unsaved-changes guard. Commit and push to `main` when the user says so; Emil's girlfriend pulls
from it on every launch.
