# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [2.0.0] - 2026-10-21

The first public, open-source release: a rewrite of the private 1.0 prototype.

### Added
- Saves standard (non-fragmented) MP4 files, with complete sample tables and edit
  lists, so downloads open cleanly in video editors as well as players.
- Audio-only downloads (`.m4a`).
- Subtitles and captions: the main track or every language, as WebVTT or SubRip.
- Paste a Vimeo link into the popup to add it, and a right-click
  *Download Vimeo video* menu item on Vimeo links and players.
- A *Downloads* tab listing every download across tabs, with progress, speed,
  time remaining, cancel, retry, “show in folder” and “clear finished”.
- Toolbar badge with the number of active downloads.
- Settings page: default quality, folder, filename template with tokens,
  save dialog, metadata tags, simultaneous downloads, subtitles.
- Approximate file sizes for each quality.
- Metadata tags (title, creator, public Vimeo link) written into assembled files.
- Keyboard shortcut <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> to open the popup.
- Dark mode.
- Detection of `lite-vimeo`, Plyr and other lazy embeds that only store a video ID.
- DRM-protected videos are identified up front and labelled, instead of failing
  on download.
- Unit tests, an end-to-end test suite, CI, and reproducible release builds.

### Changed
- Much narrower permissions: access to Vimeo hosts only, plus `activeTab` to scan
  the page you’re on when you click the icon. 1.0 could read every website. A content
  security policy also restricts every network request to Vimeo.
- Videos merely linked from a page are looked up without your Vimeo cookies. Your
  sign-in is only used for videos you pick yourself.
- Long videos no longer have a 1 GB limit: streams are assembled in temporary disk
  storage (OPFS) instead of memory.
- Video parts are downloaded in parallel, which is several times faster.
- Expired download links are refreshed automatically, once, mid-download, using the
  same refresh link Vimeo’s player uses. Embeds that have been open for hours no
  longer fail.
- Pages are scanned in Chrome’s isolated world, so page scripts can’t tamper with
  the scanner, and every request is checked against a Vimeo-only host allowlist.
- Videos appear in the popup as soon as they’re found and fill in as they’re checked.

### Fixed
- Thumbnails were missing because Vimeo changed its player config.
- Titles containing `~`, invisible formatting characters or long emoji sequences
  could make Chrome reject the download (“Invalid filename”).
- Showcase, channel and event pages were mistaken for videos.

### Removed
- MPEG-TS stream support and the bundled mux.js library. Vimeo only serves
  fragmented MP4 streams now.

## [1.0.0]

Private prototype.

[Unreleased]: https://github.com/grantzerlaut/vimeo-grab/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/grantzerlaut/vimeo-grab/releases/tag/v2.0.0
[1.0.0]: https://github.com/grantzerlaut/vimeo-grab/releases/tag/v2.0.0
