# Contributing

Thanks for helping. Bug reports, fixes, and small focused features are all welcome.

## Ground rules

- **No DRM circumvention, ever.** Pull requests that decrypt protected streams,
  fetch DRM licences, or otherwise get around access controls won’t be accepted.
- **Vimeo only.** Supporting other sites belongs in a different project.
- **Privacy stays as it is:** no analytics, no remote code, no new hosts. Network
  access goes through the allowlist in `extension/lib/vimeo.mjs`.
- **Keep permissions minimal.** If a change needs a new permission, explain why in
  the pull request.
- **No runtime dependencies or build step.** `extension/` is loaded by Chrome as-is.

## Getting set up

```bash
git clone https://github.com/grantzerlaut/vimeo-grab.git
cd vimeo-grab
npm install
```

Load `extension/` with **Load unpacked** in `chrome://extensions` (Developer mode on).
After editing, click the reload icon on the extension’s card. Reopen the popup to
pick up popup changes. To debug, use *Inspect views: service worker* on the card,
right-click the popup and choose *Inspect*, or find the offscreen page in
`chrome://inspect/#other`.

## Before you open a pull request

```bash
npm run check
```

This runs ESLint, the unit tests and the manifest checks, the same as CI. If ffmpeg is
installed, the MP4 tests also decode the remuxed output.

If you touched scanning, resolving, downloading or the popup, also run the end-to-end
suite, which drives a real Chrome against public Vimeo videos:

```bash
npx puppeteer browsers install chrome
```

```bash
npm run test:e2e
```

## Style

- Modern JavaScript modules, two-space indent, single quotes, semicolons. ESLint
  enforces the basics.
- Pure logic lives in `extension/lib/` and must not use `chrome.*`, so it can be
  unit-tested in Node.
- Treat everything read from web pages and from Vimeo as untrusted.
- User-facing text is plain and specific: say what happened and what to do next.
- Add or update tests with every behaviour change, and note user-visible changes in
  `CHANGELOG.md` under *Unreleased*.

## Reporting bugs

Use the bug report template. The most useful details are the Chrome version, the
extension version (on the settings page), what you clicked, and the exact message you
saw. Please don’t post links to private videos. A public video that shows the same
problem is perfect.

## Releasing (maintainers)

1. Move *Unreleased* in `CHANGELOG.md` to a new version heading.
2. Bump `version` in both `package.json` and `extension/manifest.json`.
3. Commit, then tag `vX.Y.Z` and push the tag. The release workflow runs the checks,
   builds the zip and publishes a GitHub release with it attached.
