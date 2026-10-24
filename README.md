# talok-ext

A Chrome extension for reading GitHub repos without distractions. No GitHub header, tabs,
buttons or sidebars — just the file list on the left and the file content in the middle. Made for
repos full of study notes or docs that are meant to be read in order.

## Features

- **Reading mode** — markdown rendered with comfortable typography (serif, limited line length),
  light/dark theme following the system.
- **Side-by-side split** — open two files next to each other on the same page, each scrolling on its own.
- **Reading order** — Previous / Next at the end of every file. Numbered notes
  (`EVM 01 - …`, folder `EVM 01 - Detail`) are sorted the way you'd read them; README always comes first.
- **Remembers progress** — reopens the last file at its scroll position; files read to the bottom
  get a ✓ in the file list.
- **Reading history** — the start page lists recently opened repos with the last file and how many
  files you've read. Click the repo name at the bottom of the file list to get back there.
- **Links between files** in markdown stay inside the reader, including links to headings.
- **Syntax highlighting** for common languages plus Solidity and Yul.
- **Mermaid diagrams** (` ```mermaid ` blocks) drawn with [Pele](https://github.com/obsidianmd/pele), in the
  reader's light/dark colors.
- YAML frontmatter is hidden, dotfiles (`.github`, `.gitignore`) are not listed.
- Private repos are supported through an optional GitHub token.

## Install

1. Clone this repo.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the repo folder.

No build step or `npm install`; third-party libraries are already in `vendor/`.

## Usage

Open any repo on github.com, then click the extension icon or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>.
The tab turns into the reader. When opened from a specific file or folder page, the reader opens
that file/folder directly.

Clicking the icon on any non-GitHub page opens a form where you can enter `owner/repo` or a GitHub URL.

### Shortcuts

| Key | Action |
| --- | --- |
| <kbd>←</kbd> <kbd>→</kbd> | Previous / next file |
| <kbd>s</kbd> | Open / close side-by-side split |
| <kbd>1</kbd> <kbd>2</kbd> | Focus left / right pane |
| <kbd>Shift</kbd>+click | Open a file or link in the other pane |
| <kbd>b</kbd> | Hide / show the file list |
| <kbd>/</kbd> | Search files |
| <kbd>+</kbd> <kbd>-</kbd> | Font size |
| <kbd>t</kbd> | Theme: auto / light / dark |
| <kbd>g</kbd> | Open the current file on GitHub |
| <kbd>?</kbd> | Show shortcuts |

Cmd/Ctrl+click on a file opens it in a new tab.

## Web version

The same reader also runs as a static website, without the extension and without a backend: the
browser fetches straight from GitHub, which allows cross-origin requests.

```sh
./build-web.sh   # writes dist/
```

Deploy `dist/` to any static host that serves `index.html` for unknown paths. `wrangler.jsonc`
deploys it to Cloudflare Workers as static assets in single-page-application mode, on the custom
domain `reader.afrijal.dev` (change `name` and `routes` for your own):

```sh
./build-web.sh && npx wrangler deploy
```

URLs mirror GitHub: replace `github.com` with the site's host, e.g.
`https://reader.example.com/owner/repo/blob/main/README.md`. Public repos need no login; for
private repos, click **Token** at the bottom of the file list. On the web the token is kept in the
site's `localStorage`.

The web version is also a PWA: install it from the browser ("Install app" / "Add to Home Screen").
The app itself works offline, and files you've already opened stay readable offline. Once installed
on Android, sharing a GitHub link to Reader opens that repo in the reader.

## GitHub token (optional)

Without a token the reader uses GitHub's public API: one request per repo for the file list (cached
for 10 minutes), while file contents come from `raw.githubusercontent.com`. The anonymous API limit
is 60 requests/hour.

For private repos or a higher limit, create a
[fine-grained token](https://github.com/settings/personal-access-tokens/new) with
**Contents: read-only** permission (step-by-step guide: [`token.html`](token.html), linked from the
extension options and the web Token dialog) and paste it into the extension options (right-click the icon → **Options**).
The token is only stored in your browser's `chrome.storage.local`.

## Layout

```
manifest.json        Manifest V3
background.js        Icon click → turn the github.com URL into a reader URL
reader.html/css/js   Reader page (file list, rendering, split view, routing)
options.html/js      Token settings
token.html           Guide to creating a fine-grained GitHub token
build-web.sh         Builds the web version into dist/
web/                 Web-only files: service worker, web app manifest, icons
wrangler.jsonc       Cloudflare deploy config for the web version
vendor/              marked, DOMPurify, highlight.js, highlightjs-solidity
```

## Third-party

- [marked](https://github.com/markedjs/marked) 15.0.12 — MIT
- [DOMPurify](https://github.com/cure53/DOMPurify) 3.2.6 — Apache-2.0 / MPL-2.0
- [highlight.js](https://github.com/highlightjs/highlight.js) 11.11.1 — BSD-3-Clause
- [highlightjs-solidity](https://github.com/highlightjs/highlightjs-solidity) 2.0.6 — MIT
