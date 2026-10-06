# Rain Radar Denmark on the web

**Will it rain here, and when?** DMI's live rain radar over Denmark, a
90-minute radar nowcast, and the chance of rain at your place, for phones and
computers.

It is the web version of the
[Rain Radar Denmark Omarchy widget](https://github.com/diegogardini/omarchy-rain-radar-denmark-widget):
the same nowcast, chances and place search, from the same code. The method,
and how well it works, is explained in
[How does it work?](https://diegogardini.github.io/denmark-rain-nowcast/) and
[the full research report](https://diegogardini.github.io/denmark-rain-nowcast/report.html).

## How it works

Everything runs in the visitor's browser: it lists DMI's latest radar scans,
downloads them, reads DMI's HDF5 files (`site/radar.js`, the browser twin of the
widget's Python converter), builds the nowcast and the chances with the widget's
own models, and draws the map and the graph.

- **The page** (`site/`) is static and served by GitHub Pages.
- **The widget's models** (`lib/*.js` on the site: nowcast, chances, places,
  colours, map) are not copied into this repository: the Pages build takes
  them from the widget repository at its latest release tag.
- **A Cloudflare Worker** (`worker/`) lets the browser download DMI's scan
  files, which DMI serves without the header browsers need. It only accepts
  DMI scan names and caches each scan, so DMI sends each one once, however
  many people look.

Cost: GitHub Pages and the Cloudflare Workers free tier (100,000 requests a
day).

## Develop

With the widget repository checked out next to this one
(`../omarchy-rain-radar-denmark-widget`, or set `WIDGET_DIR`):

```bash
python3 tools/dev-server.py 8765     # http://localhost:8765/ (proxies DMI's scans like the Worker)
node --test tests/*.test.cjs         # the browser converter against the widget's Python one
bash tools/build.sh _site            # the folder GitHub Pages publishes
```

Useful links: `?place=Odense` opens a place; `?at=2026-07-30T18:43:00Z`
replays a past moment (DMI keeps 180 days of scans).

## Deploy

- **Worker:** `cd worker && npx wrangler login && npx wrangler deploy`, then put
  its address in `site/config.js`.
- **Pages:** Settings > Pages > Source: "GitHub Actions". Every push to `main`
  deploys (`.github/workflows/pages.yml`), and so does a daily run, which picks
  up new widget releases.

## License and data

Code: [MIT](LICENSE). Radar data: [DMI](https://www.dmi.dk/), under its
[open data terms](https://www.dmi.dk/friedata/). Map outlines (Natural Earth,
public domain) and Danish places (© OpenStreetMap contributors,
[ODbL](https://opendatacommons.org/licenses/odbl/)) come with the widget's
models; see its
[MAP-SOURCES.md](https://github.com/diegogardini/omarchy-rain-radar-denmark-widget/blob/main/MAP-SOURCES.md).
