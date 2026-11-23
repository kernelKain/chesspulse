# ChessPulse — Engineering Blueprint

This is the engineering plan: the system model, the stack, the contracts, the design brief, the
checks, and the phases. The product it implements is defined in
[PRODUCT_DISCOVERY.md](PRODUCT_DISCOVERY.md). What each phase delivered, the key decisions, and the
known limits are in [EXECUTION.md](EXECUTION.md).

---

## 1. Engineering summary

```text
Product      A local-only Electron app that reviews a chess.com session with a physiological
             layer. It senses pulse while you play, then aligns that trace with engine
             evaluation, clock and think time from pasted PGNs.
Core loop    consent -> 60 s baseline -> play with live sensing -> stop -> paste PGNs ->
             validation and clock parsing -> coverage gate -> local engine pass ->
             centipawn loss and accuracy -> alignment -> accuracy by band + verdict line ->
             optional AI reading -> one decision: queue again or stop
Constraints  Node/TypeScript in Electron (the SDK has no browser build); Linux with a webcam;
             no hosting; post-game analysis only; no spend required to run it
```

## 2. Mental model

### 2.1 Core concepts

| Concept | Meaning | Why it matters here |
|---|---|---|
| Electron main vs renderer | Main is a Node process with OS access. The renderer is a sandboxed Chromium page. IPC is the only bridge. | The SDK, the API key and the engine live in main. The page receives numbers only. |
| Sample vs metric | The SDK emits periodic pulse estimates, each with a confidence value. | Aggregation drops weak samples. A missing sample is not a zero. |
| Coverage | The share of session time covered by usable samples. | Below the gate, the app refuses to report. |
| Baseline | The player's median pulse over the first 60 seconds. | Every band is relative to it, so no absolute state claim is made. |
| Clock domains | Monotonic SDK time, wall clock, PGN timestamps, per-move `[%clk]`. | Alignment joins streams that were never designed to be joined. |
| Centipawn loss (CPL) | How much worse a move is than the engine's best, in hundredths of a pawn. | Turns a move list into a per-move error series. |
| Band | A pulse range relative to baseline: settled, or elevated (baseline + 10 bpm). | The unit of comparison. Accuracy by band is the thesis. |
| Idempotent rebuild | The same inputs produce the same report. | Analysis can be rerun without sensing again, and tests are meaningful. |

### 2.2 The system in one paragraph

One Electron app. The main process opens the camera through the SmartSpectra Node SDK, receives
confidence-tagged pulse samples, appends them to a local store, and streams them to the page for the
live strip. After the session stops, the page sends pasted PGNs to main. Main parses each game
(moves, clocks, timestamps, result), checks coverage, runs a local Stockfish WASM engine over the
player's positions, converts evaluation swings into centipawn loss and accuracy, and places each
game on the session clock using the player's own game-end marks. A pure analysis layer aggregates
accuracy by pulse band and produces the numbers behind the verdict line and the charts. Nothing
leaves the machine except, if the player configures a key and asks, PGNs plus summary statistics to
an AI provider for narrative text.

### 2.3 Data flow

```text
camera ──► SDK (main) ──► samples {tUs, bpm, confidence, stable} ──► session store
                                                                          │
PGN paste ──► parse (moves, clocks, timestamps, result) ──► coverage gate ┤
                                                                          ▼
                                       engine pass ─► CPL / accuracy ─► align ─► band ─► aggregate
                                                                          │
                                     ┌────────────────────────────────────┼────────────────┐
                                     ▼                                    ▼                ▼
                              timeline series                       verdict line     coach threshold
                                     └──────────► renderer (charts, copy) ◄────────────────┘
                                                                          │
                              optional: PGN + summary statistics ──► AI provider ──► INFERRED text
```

### 2.4 Trade-offs

| Trade-off | Choice and reason |
|---|---|
| Live responsiveness vs stability | The coach reads a trailing-minute median, so it reacts in tens of seconds, not instantly. The UI says so. |
| Drop weak samples vs keep them | Drop them from aggregation, keep them in the raw trace, and let coverage fall. Hiding them would inflate apparent quality. |
| Timestamps vs player marks | Games are placed by the player's own "Game ended" and "Next game started" marks. Real chess.com exports do not reliably carry `EndTime`, so header times are not trusted for placement. |
| WASM engine vs native binary | WASM removes architecture and bundling failures at a speed cost. A depth-12 pass over the player's moves stays fast enough. |
| Database vs files | Plain JSON and NDJSON files: inspectable, deletable by folder, no native module. |

## 3. Scope and acceptance criteria

### 3.1 Must-have items

| ID | Item | Why it is required |
|---|---|---|
| M1 | Consent screen, persistent sensing indicator, revocable camera | Without it the product is covert monitoring. |
| M2 | Live pulse strip during play | The visible live signal. |
| M3 | 60 s baseline | Every band is relative to it. |
| M4 | Sample store with coverage detection | Makes refusal possible and the trace inspectable. |
| M5 | PGN paste with order checks, clock parsing, ending classification, aborted games excluded | A wrong order or a misread clock silently corrupts the report. |
| M6 | Engine pass, CPL, accuracy, banding | The domain computation. |
| M7 | Timeline merge, placement confidence, gap analysis | The core invention. |
| M8 | Accuracy by band | The chart that tests the thesis. |
| M9 | Game endings on the timeline | Ties outcome to state. |
| M10 | Between-games recovery coach | The live response that stays within fair play. |
| M11 | AI layer: five-provider adapter, narrative, `INFERRED` panels | Optional for the player; must degrade to a complete product without a key. |
| M12 | Local storage, with each layer usable when a later layer fails | The report must stand without the AI. |
| M13 | README with a consent and data-handling section | Storage, sharing, retention, deletion, SDK telemetry and the AI service, stated plainly. |

### 3.2 Acceptance criteria

| AC | Condition | Observable result | Check |
|---|---|---|---|
| AC-01 | Fresh install | The camera opens only after an explicit consent action. An indicator shows while sensing. Revoking stops capture at once. | manual + unit |
| AC-02 | A completed session | No image or video file exists in the data folder or the repo. | script |
| AC-03 | Seated session, ordinary light | The report prints total coverage. | live |
| AC-04 | First 60 s | Baseline stored with the session, shown on the report, used for bands. | unit |
| AC-05 | Coverage below the gate | Refusal with the measured coverage, the threshold, and one remedy. No bands, no verdict. | unit |
| AC-06 | PGNs out of order | Ordering error per game; no partial report. | unit |
| AC-07 | PGN with `[%clk]` | Per-move think time from clock deltas. | unit |
| AC-08 | Placement | Games placed from the player's marks; a mismatch asks the player to match marks to games; no marks shows one block with a banner. | unit |
| AC-09 | Aborted or abandoned game | Classified, excluded from accuracy, counted in the summary. | unit |
| AC-10 | A full session of games | The engine pass finishes in bounded time and yields per-move CPL. | bench |
| AC-11 | Same PGNs and config, built twice | Identical report (determinism). | integration |
| AC-12 | A band with fewer than five scored moves | Labelled insufficient, not plotted as a number. | unit |
| AC-13 | Any built report | The verdict line is one sentence from a pure function. No AI call in its path. | unit |
| AC-14 | Pulse stays above threshold between games | The coach line fires once per gap with its numbers visible. | unit + live |
| AC-15 | No AI key | Every computed layer is complete; the AI panel is disabled with the reason. | manual |
| AC-16 | Any AI reply | No number absent from the computed statistics; no medical or mental-state claim; labelled `INFERRED`; rendered as text, never HTML. | unit |
| AC-17 | Normal use without a key | No outbound call except the SDK's key and subscription check. | audit |
| AC-18 | Fresh clone | The README path produces a running app; `.env.example` lists every variable with empty values. | manual |
| AC-19 | No camera, invalid key, rate limit, no face | Distinct human-readable states, each with a recovery action, no stack traces. | manual |
| AC-20 | Report provenance | A new report always comes from a real captured session. The two shipped examples are real sessions, labelled and read-only. No fixture path to a report exists in app code. | inspection + unit |
| AC-21 | Report at narrow and wide widths | Pulse, CPL, clock and endings readable on one axis. Elevated is distinguishable without colour. Everything reachable by keyboard. | manual + layout test |
| AC-22 | README | Covers storage, sharing, retention, deletion, SDK telemetry and the optional AI service. | inspection |
| AC-23 | Bullet (1+0) PGN without `EndTime` | Handled without a crash and without false confidence. | unit |

## 4. Stack and architecture

### 4.1 Language and runtime

| Option | Evidence | Verdict |
|---|---|---|
| **Node/TypeScript + Electron** | Official `@smartspectra/node-sdk` with pure FFI via koffi (no `node-gyp`, no `electron-rebuild`) and a maintained Electron sample. | **Chosen** |
| Java, Go, Python | No official binding. Each would need bespoke FFI against the C ABI plus a desktop shell before any product work. | Rejected on cost |

### 4.2 Dependencies

| Need | Choice | Licence | Why |
|---|---|---|---|
| App shell | `electron` 45 | MIT | Hosts the SDK with a UI. |
| Pulse | `@smartspectra/node-sdk` 3.5.0 | Vendor licence | The measurement layer. |
| Engine | `stockfish` 19.0.1, lite single-threaded WASM | GPL-3.0 | Portable. The multi-threaded build needs cross-origin isolation, which a normal Electron window lacks. |
| Chess rules | `chess.js` 1.4.0 | BSD-2 | Legal move replay, SAN parsing, FEN output. |
| Boundary validation | `zod` 4 | MIT | Runtime validation with inferred types at every trust boundary. |
| UI | `react` 19 + `vite` | MIT | Renderer only. |
| Packaging | `electron-builder` 26 | MIT | Linux AppImage with the SDK runtime as `extraResources`. |
| Test DOM | `jsdom`, `playwright-core` (dev only) | MIT / Apache-2.0 | Component tests and tests against the built Electron app. |
| Storage | none: JSON and NDJSON files | — | No native module, inspectable without the app. |
| Charts | none: hand-written SVG | — | Several encodings on one axis need full control. |
| Styling | plain CSS with custom properties | — | One token file, no framework. |

Deliberately absent: any HTTP server, database, state-management library, auth, or analytics.

### 4.3 Process architecture

```text
┌─ main process (Node) ───────────────────────────────────────────────┐
│ session controller · SDK capture (useCamera) · preview tap           │
│ session store (~/.local/share/chesspulse) · example sessions (demo/) │
│ analysis (pure functions) · engine worker (worker_threads, UCI)      │
│ AI adapter (native fetch, key from .env) · file log (redacted)       │
└───────────────▲───────────────────────────────┬─────────────────────┘
                │ contextBridge IPC, schema-validated, one channel table
┌───────────────┴───────────────────────────────▼─────────────────────┐
│ renderer (React; sandboxed; contextIsolation; no Node integration)   │
│ home · setup · sensing · games (paste) · review · sessions · help    │
└─────────────────────────────────────────────────────────────────────┘
```

The SDK owns the camera in the main process. The page never requests media. A downscaled preview
is a tap on the SDK's own video output, so the camera cannot be held twice and renderer throttling
cannot starve capture.

### 4.4 Module map

| Module | Responsibility | Must not |
|---|---|---|
| `src/main/session.ts`, `capture.ts` | Start and stop, anchors, baseline, coverage, sample ingest | Compute analysis |
| `src/main/store.ts` | Session files, atomic writes, session index | Interpret values |
| `src/main/examples.ts` | Read-only example sessions and the root each session id reads from | Write to disk |
| `src/main/engine.ts`, `engine-worker.ts` | Worker lifecycle, UCI, per-position evaluation | Know about pulse |
| `src/main/analysis/*` | PGN parsing, positions, alignment, bands, metrics, verdict | Touch the filesystem |
| `src/main/report.ts` | Coverage gate, build orchestration, artifact commit | Call AI |
| `src/main/coach.ts` | Between-games threshold from live pulse | Give advice during a game |
| `src/main/ai/*` | Provider adapters, grounding, prompt | Compute any number |
| `src/shared/contracts.ts`, `channels.ts`, `errors.ts` | Schemas, IPC table, error codes | Contain domain logic |
| `src/renderer/*` | Screens, states, charts, copy | Compute domain numbers |

### 4.5 Data contracts

```ts
type MonoUs = number; // SDK monotonic microseconds

interface PulseSample { tUs: MonoUs; bpm: number; confidence: number; stable: boolean }
interface SessionAnchor { monoUs: MonoUs; epochMs: number } // recorded at start and stop

interface SessionMeta {
  schemaVersion: 1;
  id: string;                 // sortable ULID
  startedAtEpochMs: number;
  startAnchor: SessionAnchor; stopAnchor?: SessionAnchor;
  baselineBpm?: number; baselineWindow?: { fromUs: MonoUs; toUs: MonoUs };
  coverage?: { usableUs: number; totalUs: number; pct: number; confidenceFloor: number };
  stopReason?: 'user' | 'sdkError' | 'crash' | 'storage' | 'limit';
  marks?: { atUs: MonoUs; kind: 'end' | 'next' }[];   // the player's game boundaries
  framing?: { total: number; counts: Record<string, number> };
}

interface Refusal {
  ok: false;
  reason: string;             // e.g. 'low_coverage', 'order', 'no_games', 'illegal_move', 'cancelled'
  measured?: number; threshold?: number; remedy: string;
}
```

Rules that hold for every contract:

- **Validation.** zod at every boundary (IPC, PGN text, AI JSON, env). Reject, never coerce.
- **Time.** Storage is monotonic microseconds. Wall clock exists only through the anchors.
- **Limits.** Session ≤ 90 minutes (a guard, not a target), PGN batch ≤ 20 games, paste ≤ 2 MB.
- **Idempotency.** Rebuilding from the same session and PGNs gives the same report. No partial
  report is written.
- **Pairing.** `report.json` carries a SHA-256 digest of the exact PGNs in `games.json`. A
  mismatch is treated as stale.
- **Durability.** Samples are appended and synced per batch. Headers and reports are written
  atomically (temp file, sync, rename, directory sync).
- **Versions.** Session and report files carry schema versions. A newer file is refused with a
  clear message, not silently replaced.

### 4.6 IPC surface

All channels are declared once in `src/shared/channels.ts` with a request schema and a fallback
error code. Errors cross IPC as a closed set of codes, mapped to one fixed sentence each.

| Group | Invoke channels (renderer → main) | Events (main → renderer) |
|---|---|---|
| App and setup | `cp:app:state`, `cp:setup:status`, `cp:consent:set`, `cp:preview:start`, `cp:preview:stop` | `cp:preview`, `cp:validation`, `cp:sdk:error` |
| Session | `cp:session:start`, `cp:session:stop`, `cp:coach:gap`, `cp:session:marks` | `cp:sample:batch`, `cp:coach:message`, `cp:session:started`, `cp:session:ended` |
| Report | `cp:pgn:validate`, `cp:report:build`, `cp:report:cancel` | `cp:report:progress` |
| Library | `cp:sessions:list`, `cp:session:open`, `cp:session:delete`, `cp:report:export` | — |
| AI | `cp:insight:request`, `cp:insight:cancel`, `cp:insight:config` | — |
| Support | `cp:diagnostics:copy` | — |

There is no HTTP server, port or socket.

### 4.7 Storage

`~/.local/share/chesspulse/sessions/<id>/` holds `meta.json`, `samples.ndjson`, `games.json` and
`report.json`. A session is deleted by deleting its folder, which the Sessions screen does.

The two example sessions use the same layout under `demo/sessions/` in the repository, copied to
`resources/demo/sessions/` in a packaged build. The app reads them and never writes to them: delete
is refused, and a build that would pass the coverage gate is rejected before scoring.

### 4.8 Early proofs

Each proof ran before the work that depended on it.

| ID | Claim | Pass line | Result |
|---|---|---|---|
| P1 | The SDK yields a usable trace for a seated player | ≥ 70% coverage | Failed at first (5 min, 26%, chest not visible). Later met by a real 22-minute session at 88%. |
| P2 | Real chess.com exports carry `[%clk]` and `EndTime` | `[%clk]` per move | `[%clk]` present on every ply when exported with timestamps. `EndTime` not reliable, so placement uses the player's marks. |
| P3 | WASM Stockfish is fast enough in Node/Electron | ≤ 150 ms per position | Depth 8: 3 ms mean, 10 ms p95. Later depth 12: about 41 ms mean on fixtures. |
| P4 | Electron opens the camera on this Wayland machine | Window, permission, frames | Passed. Development needs `--no-sandbox` when the setuid helper is not installed. |
| P5 | Monotonic-to-wall conversion is correct | Within 1 s over 25 min | 0.87 ms drift over 120 s. |
| P6 | One AI provider answers | Valid grounded reply | Passed on OpenCode Go with a grounded reading. |
| P7 | The licence covers the bundled engine | Coherent licence | The app is GPL-3.0-or-later. |

## 5. Experience plan

### 5.1 The journey

```text
entry      open the app -> Home (start a session, recent sessions, example sessions)
setup      consent, key check, framing preview with light meter, time control
sensing    live strip; "Game ended" / "Next game started" marks; coach line between games
games      paste PGNs -> one validation card per game -> choose the player if needed
review     three stages: pulse, engine, reading -> summary, Pulse & Play Timeline,
           Move Quality, optional AI Session Explainer
```

There is no marketing page, no tour and no login. A short first-run explainer can be skipped.

### 5.2 Design brief

- **Audience and task.** One player, alone, shortly after a bad session. They want to know whether
  it was a state problem or a chess problem, and whether to queue again.
- **Hierarchy.** One primary action per screen. On the report: the summary and verdict first, then
  the timeline, then move quality, then the AI reading.
- **Character.** A lab readout: calm, clinical, unpatronising. No confetti, streaks, emoji or
  motivational copy.
- **Type.** Inter for UI. JetBrains Mono, with tabular figures, for numbers that change. Scale
  12 / 14 / 16 / 20 / 28 / 40. Spacing 4 / 8 / 12 / 16 / 24 / 32 / 48. Radii 4 and 8. One 1 px
  border weight.
- **Theme.** Dark only. The app is used at night next to a chess board.

### 5.3 Palette

Every colour is a role with one meaning, defined in `src/renderer/tokens.css`. A script checks
every pair for contrast.

| Token | Value | Use |
|---|---|---|
| `--bg` / `--surface` / `--line` | `#0e1012` / `#161a1d` / `#262c31` | Background, panels, hairlines |
| `--text` / `--muted` | `#e9e7e3` / `#98a0a6` | Primary and secondary text |
| `--board-light` / `--board-dark` | `#d8d0c0` / `#55636b` | Logo and Home board tile only |
| `--pulse` | `#5ac8d8` | The measured pulse trace and "sensing now". Never a judgement. |
| `--elevated` | `#e0663a` | The elevated state only, always with a hatch pattern and the word "Elevated" |
| `--ok` / `--warn` / `--danger` | `#6f8f7b` / `#c9a227` / `#d06b5e` | Passed, low confidence, failed |

### 5.4 Screens and states

| Screen | States |
|---|---|
| Home | first run, recent sessions, example sessions, empty, read error |
| Setup | consent off, key missing, framing (face, chest, light), ready |
| Sensing | waiting for face, validating, sensing, low quality, no camera, SDK error, coach line |
| Games | empty, partial, out of order, clockless, illegal move, player choice, mark mismatch, valid |
| Review | building with progress, cancelled, refused (named cause), built, no marks banner, rebuild needed |
| Reading | no key, ready, thinking, provider error, withheld (ungrounded) |

### 5.5 Copy

The verdict line is a pure function over computed values:

> 8 blunders, 5 of them in the eleven minutes your pulse stayed 18 bpm above baseline. Accuracy 71%
> settled, 54% elevated. Between games 2 and 3 you waited four minutes and never came down.

The refusal names the measured coverage, the gate, and the most frequent framing cause:

> **No report for this session.** Coverage was 9%; a review needs 70%. Sit back so your upper chest
> is in view.

The AI panel header reads `INFERRED`, written by a model from the numbers above and not measured.
Errors state what happened, what it means, and one action.

### 5.6 The timeline

| Channel | Mark |
|---|---|
| Pulse | line in `--pulse`; elevated stretches in `--elevated` with a hatch |
| Baseline | dashed hairline, labelled once |
| Moves | tick strip, height = CPL (capped); mate shown as "Mate" |
| Think time | dot per move |
| Endings | glyph and label: resignation, timeout, checkmate, abandoned |
| Games | alternating background bands, `G1…Gn` |

Designed states: empty, low coverage (trace drawn, refusal in place of bands, gaps never
interpolated), built, and placed without marks (one block with a banner).

Accessibility is structural. Colour is never the only carrier of meaning. The chart is focusable,
arrow keys step through it with a text readout, and a table view shows the same numbers as rows.
Reduced motion removes transitions.

### 5.7 Responsive behaviour

| Width | Behaviour |
|---|---|
| ≥ 1100 px | centred single column; timeline at full width |
| 700–1100 px | lower rails compress; ending labels shorten to glyph and tooltip |
| < 700 px | panels stack; no horizontal scrolling |

Names and results wrap rather than truncate.

## 6. Security, reliability and verification

### 6.1 Data classes

| Data | Lives | Leaves the machine |
|---|---|---|
| Camera frames | SDK memory in main, never written | No |
| Pulse samples | `samples.ndjson` | No |
| PGNs and usernames | `games.json` | Only to the AI provider, when the player asks for a reading |
| Report | `report.json` | No, unless the player exports it (no samples in the export) |
| API keys | `.env`, main process memory | Only to their issuer |
| AI reply | memory | n/a |

The renderer runs with `contextIsolation: true`, `nodeIntegration: false`, a sandboxed bundled
preload, and a strict CSP. Navigation away from the app page is blocked.

### 6.2 Credentials and logging

- Keys are read in main from the environment, validated at startup, and never sent over IPC.
- The log redacts secret values, rotates at 512 KB, and never holds PGNs, samples or keys.
- Errors shown to the player never include a stack trace or a file path.

### 6.3 Reliability rules

| Operation | Bound | Retry | Failure behaviour |
|---|---|---|---|
| SDK start | SDK default timeout | player-initiated only | typed error state, camera released |
| Engine position | 5 s | worker crash retried up to twice per build | position counted as failed; report states how many |
| Report build | cancellable | none | refusal or completed report; never a partial write |
| AI call | 30 s | once, only on a server error or failed connection; never after a timeout | panel shows the error; nothing else changes |
| Session | 90 minutes | — | automatic stop with a visible reason |

### 6.4 Verification

- Unit tests where wrongness is silent: PGN and clock parsing, CPL and banding, alignment, the
  coverage gate, AI grounding, storage atomicity.
- Component tests (jsdom) and tests against the built Electron app (Playwright).
- `npm run check:contrast` and `npm run check:copy` guard colour pairs and terminology.
- `npm run doctor` checks Node, `.env`, the key, the camera, Stockfish and the data folder.
- A check that cannot run is reported as `NOT_RUN` with the reason; it is never counted as a pass.

## 7. Phases

Each phase has one branch, named for the work. Commit subjects name one change in the imperative.
Each phase merged into `main` through a reviewed pull request.

### Phase 0 — Proofs

**Branch:** `proofs`. **Goal:** turn the riskiest assumptions into facts before building.

| Step | Outcome |
|---|---|
| S1 | Dependencies installed; the SDK's Electron sample runs |
| S2 | Camera confirmed in Electron on this machine |
| S3 | A seated pulse session logged and its coverage measured |
| S4 | Real chess.com PGNs inspected for clocks and timestamps |
| S5 | Engine speed bench |
| S6 | Monotonic-to-wall clock anchor checked |
| S7 | Repository scaffold: strict TypeScript, Vite, build target, contracts |

### Phase 1 — Foundation

**Branch:** `foundation`. **Goal:** a window that senses and stores pulse safely.

| Step | Outcome |
|---|---|
| S8 | Window shell, preload bridge, CSP, permission handler |
| S9 | Session store with atomic headers |
| S10 | Session controller: start, stop, baseline, coverage |
| S11 | Sensing screen with the live strip and the SDK capture bridge |

### Phase 2 — Analysis core

**Branch:** `analysis-core`. **Goal:** a verdict line printed from a terminal command.

| Step | Outcome |
|---|---|
| S12 | PGN parser: moves, clocks, timestamps, endings |
| S13 | Engine worker with per-position evaluation and failure marking |
| S14 | CPL, bands, accuracy and the verdict function |
| S15 | Alignment, confidence and gap analysis |
| S16 | Report builder CLI with the refusal path |

### Phase 3 — Report experience

**Branch:** `report`. **Goal:** the report on screen, built from real data.

| Step | Outcome |
|---|---|
| S17 | Paste screen with validation states |
| S18 | Timeline with its encodings and states |
| S19 | Band bars, verdict line, table view, keyboard readout |
| S20 | Game list, endings, narrow layout |
| S21 | Walkthrough with real data and fixes |

### Phase 4 — Coach and AI

**Branch:** `coach-and-ai`. **Goal:** the live between-games line and the optional AI layer.

| Step | Outcome |
|---|---|
| S22 | Between-games coach from live pulse |
| S23 | Five-provider adapter with grounding validation |
| S24 | Reading screen with `INFERRED` panels and disabled and error states |

### Phase 5 — Hardening

**Branch:** `hardening`. **Goal:** close every defect from a whole-project review and bring the app
to a consistent standard. Work is grouped into workstreams.

| Workstream | Steps | Outcome |
|---|---|---|
| Data safety | S29–S32 | No lost reports, paired artifacts, visible automatic stops, drained shutdown |
| Analysis correctness | S33–S39 | Mate-aware scoring, illegal-move refusal, bounded engine failures, depth 12, linear-time lookups, AI claim filter, bounded coach memory |
| Backend quality | S40–S45 | Typed IPC errors, one channel table, redacted logs, doctor, versioned storage, packaging |
| Experience flow | S46–S51 | One navigation model, first-run explainer, setup, sensing controls, sessions list, games and review flow |
| UI system | S52–S56 | Tokens, components, timeline review, responsive and keyboard behaviour, plain copy |
| Verification | S57–S60 | Test infrastructure, bug bash, evidence tooling, phase close |

### Phase 6 — Review experience

**Branch:** `review-experience`. **Goal:** a clearer review and a visual identity.

| Step | Outcome |
|---|---|
| S61 | Chess and pulse palette; elevated encoded by colour, pattern and word |
| S62 | Logo and Home with a 3D board tile |
| S63 | Visual panels for Setup and Paste |
| S64 | Games placed by the player's marks, with a picker on mismatch |
| S65 | The review in three stages: pulse, engine, reading |
| S66 | Readings with a hand or object over the face are marked and excluded |
| S67 | The refusal names its most frequent cause |

### Phase 7 — Report redesign

**Branch:** `report-redesign`. **Goal:** a report that reads in one pass and scores only the
player's own moves.

| Step | Outcome |
|---|---|
| A1 | Report information architecture and wireframes |
| A2 | Only the sensed player's moves are scored |
| A3 | Per-game summaries and engine identity stored in the report |
| A4 | The AI provider is configured from `.env`; OpenCode Go reachable |
| B1 | Centred report shell and summary header |
| B2 | Pulse & Play Timeline recomposed |
| B6 | Move Quality tabs with per-game facts and links to the timeline |
| B7 | AI Session Explainer with suggested questions |
| — | PGN clocks read with their time zone |
| — | Two real sessions shipped as read-only examples on Home |

## 8. Run and package

| Item | Command or rule |
|---|---|
| Check | `npm run typecheck`, `npm test` |
| Build and run | `npm run build && npm start` (`npm run dev` for the dev server) |
| Health check | `npm run doctor` |
| Package | `npm run dist` (Linux AppImage; SDK runtime and example sessions as `extraResources`) |
| Variables | `SMARTSPECTRA_API_KEY`, `CP_AI_PROVIDER`, `CP_AI_KEY`, `CP_AI_MODEL`, `CP_AI_BASE_URL`, all in `.env` |
| Hosting | None. Distribution is the public repository. |
