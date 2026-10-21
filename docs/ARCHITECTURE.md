# Architecture

Vimeo Grab is a Manifest V3 extension with three runtime pieces that talk through
`chrome.runtime` messages, plus plain ES modules in `extension/lib/` that hold all
the logic worth testing.

## Pieces

**Service worker** (`background.js`) is the coordinator. It owns all state, stored
in `chrome.storage.session` with one key per record, so a progress update rewrites
one small record (a few kilobytes) rather than everything:

- `page:<tabId>`: the videos found on a tab (`{url, scanId, videos[], notice}`).
  Removed when the tab navigates or closes; at most 10 are kept.
- `job:<id>`: one download (`{phase, attempt, progress, format, filename, video, …}`).
  At most 100 finished jobs are kept.

Every write goes through `serial()`, a promise chain, so each read-check-write
(`updateJob`, `patchJob`, `updatePage`) is atomic. That is what makes the job state
machine safe: a cancelled or finished job ignores late updates, each retry bumps
`attempt` so a leftover run from the previous attempt can't touch the new one, and a
download event is matched to its job only after any pending write of its download id.

The service worker can be stopped by Chrome at any time. Everything it needs to
resume is in storage. While the popup is open, its 1.5 s `POLL` keeps the worker
awake, fills in progress the downloads API doesn't push, and recovers jobs that were
lost (a worker stopped mid-task, or an offscreen page that no longer knows the job,
checked with `STATUS`).

**Offscreen page** (`offscreen/`) does the heavy lifting for HLS streams, because a
service worker can't create `blob:` URLs. It keeps an in-memory queue (1–3 jobs at a
time), reports progress with `JOB_UPDATE` (whose reply says whether the job is still
wanted), and hands the finished file back with `SAVE`. It only accepts commands from
the service worker, which closes it after a quiet minute.

**Popup and options** (`popup/`, `options/`) render from `chrome.storage` and
re-render on `storage.onChanged`. They never hold authoritative state.

## A download, step by step

1. **Scan.** The popup sends `SCAN`. The service worker injects
   `lib/detector.mjs#scanPage` into every frame it may access: the tab itself (via
   `activeTab`) and any `player.vimeo.com` frames (host permission). It runs in the
   isolated world and only reads: attributes, inline scripts, resource timing, and,
   inside Vimeo player frames, the `playerConfig` JSON.
2. **Merge.** `collectCandidates()` deduplicates by video ID, keeping the most
   useful source (player config, then embed, then link…) and any unlisted hash.
3. **Resolve.** For each candidate, in parallel (4 at a time), get a player config
   from the first source that works (`configSources()`):
   - the config the page's own player loaded, if its signed links aren't about to expire;
   - that player's `config_refresh_url`, the signed URL Vimeo's player itself uses
     to renew expired links;
   - `player.vimeo.com/video/ID/config`, then the player HTML.

   Then `parseConfig()` → HLS master playlist → `buildFormats()`. One media playlist
   is fetched to detect DRM before the user clicks. Results stream into
   `page:<tabId>` as they arrive. Cookies are sent only for videos the user named
   (pasted, right-clicked, or the vimeo.com page itself).
4. **Download.** `DOWNLOAD` creates jobs with a chosen format and a sanitised
   filename. Direct MP4s go straight to `chrome.downloads`. HLS jobs go to the
   offscreen page.
5. **Assemble.** `downloadHls()` fetches the media playlists and init segments, then
   all segments with bounded parallelism, yielding them in order
   (`ordered()`). `Mp4Remuxer` copies each fragment's sample bytes into one `mdat`
   and records sample tables. At the end it patches the 64-bit `mdat` size and
   appends a `moov`. Output goes to an OPFS temp file (`OpfsSink`), falling back to
   memory if OPFS is unavailable.
6. **Save.** The offscreen page creates a `blob:` URL for the OPFS file. The service
   worker passes it to `chrome.downloads.download()`. When Chrome reports the
   download complete, the job is marked done, subtitles are saved if enabled, and
   `RELEASE` tells the offscreen page to revoke the URL and delete the temp file.

## Trust and safety

- Everything from web pages and from Vimeo is untrusted input.
- `mediaUrl()` / `downloadUrl()` in `lib/vimeo.mjs` are the only gate to the
  network: https only, a handful of Vimeo hosts only. `fetchResource()` enforces it
  for the request and for where any redirect ended up. The manifest's CSP repeats the
  list as `connect-src`, so the browser enforces it too, on every redirect hop.
- Cookies are opt-in per request (`cookies: true`) and only ever go to `vimeo.com`
  hosts, for videos the user named. CDN requests never carry them.
- The extension never forges headers. Site-restricted embeds work only through the
  config and refresh URL of the player the page itself loaded.
- The service worker only accepts messages from the extension's own pages, and only
  the offscreen page may send `JOB_UPDATE`/`SAVE`/`REFRESH`. The offscreen page only
  accepts messages from the service worker.
- Filenames go through `safeName()`/`safeFolder()`, which match Chrome's own
  filename rules (plus invisible-character and fake-extension checks), so a hostile
  title can't escape the Downloads folder, be rejected, or pass itself off as an
  executable or document when Windows hides the real extension.
- Encryption anywhere (`#EXT-X-KEY`, `encv`/`enca` sample entries, `pssh`, `senc`)
  stops the download with a `ProtectedError`. There is no code path that decrypts.
- Page-supplied data is size-capped (URL length, ID length, items per frame, videos
  per scan), and the remuxer bounds samples per segment, which limits how much a
  hostile page or segment can make the extension hold in memory.

## Testing

- `test/*.test.mjs`: unit tests for every `lib/` module. `test/fixtures/hls` is a
  synthetic stream (H.264 with B-frames + separate AAC) generated by
  `scripts/make-fixtures.sh`, packaged like Vimeo's. The remuxer tests compare
  the output's sample bytes with the input, and decode it with ffmpeg when available.
- `test/e2e/`: Puppeteer drives Chrome for Testing with the real extension against
  live, public Vimeo videos: scan, DRM detection, download and ffprobe validation,
  cancel, pasted links, settings.
