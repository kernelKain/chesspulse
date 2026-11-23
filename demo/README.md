# Demo material

Everything here comes from real sessions captured with ChessPulse. Nothing is simulated.

## Example sessions

`sessions/` holds two real sessions in the app's own storage layout. The app lists them on Home
under **Example sessions**, separate from your own sessions, and never changes or deletes them.

| Folder | Session | Outcome |
|---|---|---|
| `01M829E6SVWDNHB7XH84E4TAZB` | 10 bullet games (1+0), 22:19 elapsed, 88% coverage | Passed the coverage gate. Opens the full report. |
| `01M82X8MPPR67CS08YQGKP5QR1` | 3 blitz games (3+2), 16:51 elapsed, 9% coverage | Failed the coverage gate. The chest was out of frame for most of the session, so the report is withheld. |

Each folder contains `meta.json` (session header and game marks), `samples.ndjson` (timestamped pulse
numbers with confidence, no images), and, for the passing session, `games.json` (the pasted PGNs)
and `report.json` (the computed report). The PGNs include public chess.com usernames and game links.

## Screenshots

`screenshots/` shows the app during and after those two sessions: Home, setup, PGN paste and
validation, the withheld blitz review, and the bullet session's report, timeline, Move Quality and
AI Session Explainer.

## Article images

`article/` holds the images for the Dev.to submission (`docs/drafts/devto-article.md`).

| File | What it shows |
|---|---|
| `cover.png` | Cover image, 2000 x 840 |
| `three-layers.png` | The three layers from pulse to report |
| `architecture.png` | Main process, renderer and the IPC bridge |
| `data-flow.png` | From a session to a report |
| `entire-analytics.png` | Entire analytics for the last seven days (screenshot) |

The diagram SVGs next to the PNGs are the source. Each PNG is a headless Chrome render of its SVG.
