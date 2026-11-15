# alphaTab Playground

A development harness for alphaTab. Each demo under `demos/` exercises a specific capability of the
library against the live source under `packages/alphatab/src/`. Editing alphaTab source hot-reloads
the playground via Vite's workspace alias.

The player demos are built from the same packages as the website's player, also resolved to their
live sources: [`@coderline/alphatab-ui`](../ui/) (player and alphaTex editor components, state and
styles) on top of [`@coderline/alphatab-react`](../react/) (the API lifecycle and event hooks) on top
of `@coderline/alphatab`. A change to any of these layers shows up in the playground right away. The
playground is not a reference for end users; for the raw API without a framework, read the demo
specific parts (`src/components/recorder/DrumRecorder.ts`, `src/components/youtube-sync/YoutubeSync.ts`)
and the packages above.

## Running it

From the monorepo root:

```bash
npm run dev
```

This is a shortcut for `npm run dev --workspace=packages/playground` and opens the labs index at
[`http://localhost:5173/`](http://localhost:5173/).

Other scripts (run from `packages/playground/`):

- `npm run typecheck` — `tsc --noEmit` against the playground's tsconfig.
- `npm run lint` — Biome lint.

Every player demo takes `?engine=svg|html5` and `?loglevel=debug|info|warning|error` in its address;
they apply on top of the UI's settings and survive a settings reset. In the browser console,
`window.api` is the demo's `AlphaTabApi` and `window.alphaTab` the alphaTab module. On the Control
demo, CapsLock shows a crosshair following the mouse.

### Optional local Songsterr import

The Control demo keeps its existing track and settings panels, transport, exports, file picker and
drag-and-drop. Its **Import a Songsterr URL** panel can also acquire an authorized public score
through an opt-in local service. This is part of the playground, not a new alphaTab file importer
or a hosted download service.

Use a Node version supported by Vite 8 (for example Node 24), install the locked dependencies with
`npm ci`, and generate the source metadata on a fresh checkout:

```bash
npm run generate-typescript
npm run dev:imports
```

Open `/demos/control/` at the printed `http://127.0.0.1:...` address. To choose a port explicitly:

```bash
npm run dev:imports --workspace=packages/playground -- --port 5177 --strictPort
```

Ordinary `npm run dev` does not register the import endpoint. The URL panel explains how to enable
it, and existing file loading continues without the service. Import mode refuses a non-loopback
binding; it is not intended for deployment to a public server.

A desktop launcher must use this checkout and the `dev:imports` command. Merging this fork does
not update a different checkout or change an existing launcher's command.

Confirm that you own or have permission to use a score before importing its HTTPS Songsterr tab
URL. The local service reads public page metadata and every declared track from a fixed CDN
origin. It never uses the downloader website as an API, sends cookies, follows redirects, retries
through alternate CDNs, or bypasses sign-in, paid access, rate limits or verification. A denied or
missing track fails the whole import instead of silently omitting it. Local files are never sent
to the service.

The revision data becomes a score using this checkout's alphaTab source. Memory-only imports travel
as score JSON and use `ScoreSource.json` through the normal `PlayerStore` path; settings reloads
parse it again. When saving is selected, the worker also exports a real Guitar Pro 7 `.gp` archive
using this checkout's exporter. Percussion uses registered track-local articulations, so an exported
file keeps the same drum sounds instead of confusing legacy percussion IDs with file indices. There is
no GPIF text patch or engine patch.

Track selection, mixing, playback, notation settings and exports remain the Control player's own
implementations. The source revision and conversion warnings are displayed with the score; the
source URL and revision are also kept in the saved score's notices. Reloading the page never
reacquires the URL automatically.

#### Your Guitar Pro folder

In Chrome, Edge or another browser supporting File System Access, use **Choose folder** to connect
`Music\Guitar Pro Tabs` and grant read/write access. The picker lists the same supported score types
as **Open File**, directly in that folder; it does not recursively scan subfolders. Choose a score
and press **Open**. **Refresh** picks up files added outside the app. **Change folder** chooses a
different directory, and **Disconnect** forgets the selection without deleting any scores.

The browser stores only the directory handle in IndexedDB. Selection and permissions belong to
that browser origin, including its port; a new port or a later visit may require **Reconnect**.
Permissions are never requested silently on startup. If folder access is unsupported, the original
file picker and drag-and-drop still work.

**Save a .gp copy in the connected folder** is enabled by default where folder access is supported.
Connect the folder before importing, or turn the checkbox off for a memory-only import. Saving uses
a new sanitized name with a random suffix, checks for existing entries, and never opens an existing
file for replacement. The browser uses an exclusive swap-file writer, closes it, then verifies
the stored bytes with SHA-256 before reporting success. The saved `.gp` is opened through the
original file-import path and appears in the folder picker. It is not JSON renamed to `.gp`.

Folder access and writing happen entirely in the browser. Neither your directory handle, its path,
nor your local score files are sent to the local server or Songsterr. The companion only acquires
the requested public revision and returns converted data. A failure to save leaves the previous
player document unchanged. Cancellation does not delete a save that already committed; if cleanup
of an interrupted new file is blocked, the error identifies the file that may remain.

Conversion is experimental: unhandled fields produce visible warnings, while unsupported timing,
inconsistent track lengths and invalid playback timelines fail explicitly. Use an authorized
Guitar Pro file when you need the original notation fidelity. Automated cases use original
CC0 fixtures and mocked acquisition; they do not establish that a live Songsterr URL remains
accessible or that every upstream notation construct is supported.

The importer admits at most 16 tracks, 2,048 bars per track, 4 voices per measure, 256 beats per
voice, 20,000 total beats and 100,000 generated MIDI events. It bounds page HTML at 2 MiB, each
track response at 4 MiB, all acquired content at 16 MiB and the converted result at 25 MiB. Requests
have an 8-second upstream deadline and a 45-second acquisition/conversion deadline; conversion
runs in a terminable 10-second worker with a 128 MiB V8 old-space limit, not a process-wide RSS
guarantee. One import runs at a time. Cancel, navigation away or opening a local file supersedes
pending URL work; acquisition/conversion errors do not replace the previous score.

The revision mappings retain the upstream
[MIT notice](./licenses/songsterr-downloader-MIT.txt). That code license does not grant rights to
music or authorize access to restricted scores.

Run the focused checks from the monorepo root:

```bash
npm run typecheck --workspace=packages/playground --workspace=packages/ui
npm run test --workspace=packages/playground --workspace=packages/ui -- songsterr score-library store.test.ts score-document-session.test.tsx
```

## Architecture at a glance

```
demos/<feature>/index.html         page shell: "<div id='app'></div>" + module script
demos/<feature>/index.tsx          mountDemo(<FeatureApp />)

src/apps/<Feature>App.tsx          a <PlayerProvider> with the demo's settings and its view
src/player/mount.tsx               mountDemo: React root, UiEnvironment, NavMenu; DevGlobals (window.api)
src/player/environment.ts          the UiEnvironment of the demos, player settings, single-sample documents
src/player/DemoPlayerView.tsx      the shared <PlayerView>: header, track and settings panels, waveform, drops
src/components/recorder/           Drum Recorder: score extension logic, pads, rhythm grid
src/components/youtube-sync/       YouTube Sync: the external-media handler and the video
src/components/NavMenu.ts          demo navigation (vanilla, on every page)
src/components/Crosshair.ts        CapsLock crosshair (vanilla)
src/apps/LabsIndexApp.ts           labs index (vanilla)
src/apps/TestResultsApp.ts         visual test results (vanilla)
src/util/Dom.ts                    html/css tagged templates, parseHtml, injectStyles for the vanilla pages
src/util/Paths.ts                  default file paths
src/styles/common.css              fonts, resets and score cursor colors for every page
src/styles/player.css              full-window layout of the player pages
```

### Player demos

A demo app wraps its view in `<PlayerProvider>` from `@coderline/alphatab-ui`. The provider creates
the `AlphaTabApi` when its host mounts, attaches a `PlayerStore` to it and destroys both on unmount.
Components below it read state through `usePlayerSelector`/`usePlayerState`, act through
`usePlayerControls()`, and reach the API through `useAlphaTabApi()` and `useAlphaTabEvent()` from
`@coderline/alphatab-react`.

- **Settings** come in three layers: the UI's base settings (`applyBaseSettings`), the environment's
  `settingsLayer` (page parameters plus the demo's own layer passed to `mountDemo`, re-applied on
  every settings reset), and the provider's `settings` prop. The prop sets `player.playerMode` and
  `player.soundFont` (see `playerSettings()`), so the playback source is fixed and the SoundFont is
  loaded straight from `/font/`, without the website's SoundFont library and its cache.
- **Documents**: demos that open files use `useScoreDocument` with `singleSampleDocuments(...)`; it
  loads the sample, opens dropped or picked files and re-imports on importer settings changes. The
  alphaTex editor keeps its document in `sessionStorage`. Converted score JSON uses
  `ScoreSource.json` and is deserialized afresh with the current settings on load or reload.
- **Local library**: the Control demo uses browser-granted directory handles, not a filesystem API
  on the local server. `src/library/` handles folder selection, permissions, remembered handles and
  verified new-file saves. File reads share the same cancellable `useScoreDocument.openFile` path as
  the original picker and drops.
- **Layout**: `DemoPlayerView` renders the `PlayerView` composite with a header (file, panel
  toggles, open, export menu), the track panel, the settings panel (every alphaTab setting, persisted
  per demo in `localStorage`), the rendering indicator and the backing-track waveform. Demos add an
  editor panel, content above the workspace or an overlay in score coordinates.
- **Styles** are SCSS modules next to their component; the UI's design tokens come from
  `@coderline/alphatab-ui/styles/tokens.scss`.

### Vanilla pages

The labs index, the visual test results and the shared `NavMenu`/`Crosshair` stay framework-free.
They build their DOM detached with `parseHtml(html\`…\`)`, expose it as `root` and remove it in
`dispose()`. `html` escapes interpolated values; `injectStyles(key, sheet)` adds a component's sheet
once per page. Class names are prefixed with the component's kebab name (`at-nav-menu-…`) since the
sheets are global.

## Adding a new demo

1. `mkdir packages/playground/demos/my-feature`
2. Add `index.html`:
   ```html
   <!doctype html>
   <html lang="en">
     <head>
       <meta charset="utf-8" />
       <title>alphaTab — My Feature</title>
       <link rel="stylesheet" href="../../src/styles/common.css" />
       <link rel="stylesheet" href="../../src/styles/player.css" />
     </head>
     <body>
       <div id="app"></div>
       <script type="module" src="./index.tsx"></script>
     </body>
   </html>
   ```
3. Add `index.tsx` calling `mountDemo(<MyFeatureApp />)` from `src/player/mount`.
4. Build the app in `src/apps/MyFeatureApp.tsx`: a `<PlayerProvider settings={playerSettings()}>`
   with `<DevGlobals />` and a view rendering `<DemoPlayerView demo="my-feature" … />`, or the
   `@coderline/alphatab-ui` components directly.
5. Add the demo to the `DEMOS` array in [`src/util/Demos.ts`](./src/util/Demos.ts) so it shows up on
   the labs index and in the navigation.

## Demos

| Demo | Path | What it exercises |
| --- | --- | --- |
| Control | [`demos/control/`](./demos/control/) | Full player: track panel with mute/solo/volume and visibility, transport with loop/count-in/metronome, all settings (layout, scroll mode, zoom, tempo, output device), exports (Guitar Pro, alphaTex, MIDI, WAV, print), drag-drop, backing-track waveform. |
| Drum Recorder | [`demos/recorder/`](./demos/recorder/) | Programmatic score construction, dynamic system extension, tick-cache updates, MIDI extension/regeneration, `playedBeatChanged`. |
| AlphaTex Editor | [`demos/alphatex-editor/`](./demos/alphatex-editor/) | Monaco with the alphaTex language server next to the live rendering; edits re-render with `reuseViewport`, dropped files are converted with `AlphaTexExporter`. |
| YouTube Sync | [`demos/youtube-sync/`](./demos/youtube-sync/) | `EnabledExternalMedia` player mode driving alphaTab from a YouTube IFrame player. |
| Visual Test Results | [`demos/test-results/`](./demos/test-results/) | Diff viewer for visual regression failures with accept-to-reference flow. |

## Dev-server endpoints

The custom Vite plugin in [`vite.plugin.server.ts`](./vite.plugin.server.ts) adds:

- `/font/*` — serves files from `packages/alphatab/font/` (Bravura, sound fonts).
- `/test-data/*` — serves files from `packages/alphatab/test-data/` (GP files, visual-test
  references and fixtures).
- `GET /test-results/list` — JSON list of failing visual tests by crawling for `*.new.png` files
  under `test-data/`.
- `POST /test-results/accept` — accepts one new reference image (replaces the corresponding
  `.png`). Used by the `Visual Test Results` demo.

In `dev:imports` mode, [`vite.plugin.songsterr.ts`](./vite.plugin.songsterr.ts) additionally registers
`POST /api/import/songsterr`. It requires the exact loopback Host and Origin, a JSON request of
at most 4 KiB, and explicit permission confirmation. Acquisition, conversion and worker isolation
live under `src/songsterr/`; ordinary development and static builds do not enable this endpoint.

## Editing alphaTab source

`@coderline/alphatab`, `@coderline/alphatab-react`, `@coderline/alphatab-ui`, the language server and
the Monaco integration resolve via [`tsconfig.base.json`](../../tsconfig.base.json) paths to their
`src/` folders. Editing any of them triggers a Vite hot update or a full-page reload — no manual
rebuild needed. The workers (alphaTab's, Monaco's and the alphaTex language server) are module
workers loaded from source as well.

If you need to test against a built artifact instead, replace the workspace alias path or import
from the published package name in a single demo.

## Troubleshooting

- **The page reloads once on the first visit of a demo** — Vite found dependencies to pre-bundle
  (e.g. the language server's) and reloads after optimizing them.
- **Settings look stuck after experimenting** — the settings panel persists its overrides per demo
  in `localStorage`; use "Reset all" in the panel.
- **Two React copies / invalid hook call** — `resolve.dedupe` in [`vite.config.ts`](./vite.config.ts)
  keeps the ui and react sources on the playground's React; keep it when changing the config.
