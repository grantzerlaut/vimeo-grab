# Privacy policy

_Last updated: 21 October 2026_

Vimeo Grab is a browser extension that runs entirely on your computer. Its authors
don’t operate any servers for it and receive no data from it.

## What it does not do

- No analytics, telemetry, crash reporting, advertising or tracking.
- No accounts and no sign-in.
- It never sends information about you, your browsing or your downloads to its
  authors or to any third party.
- It doesn’t sell or share data, because it doesn’t collect any.

## What it reads, and when

Only when you act (click the toolbar icon, press the keyboard shortcut, or use the
right-click menu) does the extension read the current tab: its address and title,
its frames (including embedded Vimeo players), link and attribute values, inline
scripts, and the list of resources the page loaded. It looks for Vimeo video links
and player data in them and nothing else. It doesn’t run on pages otherwise.

## Who it talks to

Only Vimeo. The extension’s code and its content security policy both restrict
network requests to `vimeo.com`, `www.vimeo.com`, `player.vimeo.com`,
`captions.vimeo.com` and `*.vimeocdn.com`. Direct MP4 files for some older videos are saved by Chrome from
Vimeo’s Akamai address `vod-progressive.akamaized.net`.

- **Opening the popup** asks Vimeo about every video found on the page (up to 60),
  so it can show titles, thumbnails and qualities. Vimeo therefore learns the IDs of
  those videos and your IP address, as it would if you played them.
- **Your Vimeo cookies** are sent only for videos you choose yourself: a link you
  paste or right-click, or the vimeo.com page you’re on. That’s what lets private
  videos you’re allowed to watch work. Videos that are merely linked from a page are
  looked up without cookies.
- **No Referer or other identity is invented.** For embeds that only play on a
  particular website, the extension reads the player that website already loaded;
  it never tells Vimeo it’s somewhere it isn’t.

Vimeo’s own [privacy policy](https://vimeo.com/privacy) applies to those requests.

## What it stores

| Data | Where | How long |
| --- | --- | --- |
| Your settings (quality, folder, filename template…) | `chrome.storage.local` on this device | Until you change them or remove the extension |
| Videos found on recently scanned tabs (up to 10), with the page address and title | `chrome.storage.session` (memory) | Until the tab navigates or closes, or you close the browser |
| The list of downloads (up to 100), with each video’s page address | `chrome.storage.session` (memory) | Until you close the browser or clear finished downloads |
| Video being assembled | The extension’s private temporary storage (OPFS) | Deleted as soon as the file is saved, or the next time the browser starts |
| Downloaded files | Your Downloads folder, via Chrome | Yours to keep or delete; Chrome lists them in its download history |

Videos the extension assembles from streams (nearly all Vimeo videos today) contain
the title, creator and public Vimeo link in their metadata tags, unless you turn
that off in the settings. Direct MP4 files are saved exactly as Vimeo serves them. The private part of an
unlisted video’s link is never written into the file.

Nothing is synced to your Google account.

## Removing data

Remove the extension from `chrome://extensions` to delete its settings and any
temporary files. Downloaded videos stay in your Downloads folder until you delete them.

## Changes

Changes to this policy are recorded in this file’s history on GitHub.

## Contact

Questions: open an issue at <https://github.com/grantzerlaut/vimeo-grab/issues>.
