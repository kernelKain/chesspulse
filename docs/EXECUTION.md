# ChessPulse — Execution

What was built in each phase, the decisions that shaped it, how it was verified, and what is still
limited. The plan behind it is in [ENGINEERING_BLUEPRINT.md](ENGINEERING_BLUEPRINT.md) and the
product definition in [PRODUCT_DISCOVERY.md](PRODUCT_DISCOVERY.md).

---

## 1. Phase outcomes

Each phase lists its branch, what it delivered, and what it left open.

### Phase 0 — Proofs (`proofs`)

**Delivered.** The SDK's Electron sample ran on this Linux/Wayland machine. Real chess.com PGNs
were inspected, the engine was benchmarked, the clock anchor was checked, and the repository was
scaffolded with strict TypeScript.

**Findings.**
- Real exports carry `[%clk]` on every ply. They did not carry `EndTime`, `UTCDate` or `UTCTime`.
- Stockfish 19 lite (single-threaded WASM) scored positions at depth 8 in 3 ms mean, 10 ms p95.
- The monotonic-to-wall conversion drifted 0.87 ms over 120 seconds, against a 1 second limit.
- The first seated pulse run (5 minutes) reached 26% coverage. The SDK reported the chest out of
  frame and a low frame rate.

**Left open.** A full seated session at 70% coverage.

### Phase 1 — Foundation (`foundation`)

**Delivered.** A sandboxed window with a preload bridge, CSP and permission handler. A session
store with atomic headers. A session controller with baseline and coverage. A sensing screen with
the live pulse strip, fed by the SDK running in the main process.

**How capture ended up working.** Three input paths were tried and measured:

| Input path | Result on this machine |
|---|---|
| Page camera, frames sent to the SDK (`useCustomInput` + `sendFrame`) | Frames accepted, 0 pulse readings |
| SDK-owned camera (`useCamera`) | Pulse readings flowed |
| SDK-owned camera plus a subscription to its video output | Pulse readings flowed, and the preview works |

The SDK owns the camera, and the preview is a 320 px tap on its video output. The page never
requests media.

**Left open.** Capture only receives frames while the window is on screen. A minimised window
produces a thin session, and the coverage gate refuses it.

### Phase 2 — Analysis core (`analysis-core`)

**Delivered.** A PGN parser (moves, clocks, timestamps, endings), an engine worker with
per-position failure marking, CPL, bands, accuracy, the verdict function, alignment, and a report
builder CLI that refuses below the coverage gate.

**Left open.** Placement from timestamps could not be used on real exports. This was resolved in
Phase 6 by placing games from the player's own marks.

### Phase 3 — Report experience (`report`)

**Delivered.** The paste screen with validation states, the timeline with its encodings and
states, band bars, the verdict line, a table view with a keyboard readout, the game list with
endings, and a narrow layout.

**Left open.** No real session at 70% coverage existed yet, so the full report was checked against
real low-coverage data and real PGNs only.

### Phase 4 — Coach and AI (`coach-and-ai`)

**Delivered.** "Game ended" and "Next game started" controls. A coach line that fires once per
marked gap when the trailing-minute median stays above baseline + 10 bpm. A five-provider AI
adapter with grounding validation. A reading screen with `INFERRED` panels and disabled, error and
cancel states.

**Left open.** A real coach threshold crossing between two real games has not been observed.

### Phase 5 — Hardening (`hardening`)

**Delivered.** A whole-project review produced a register of 32 defects. All were closed. The fixes
were grouped by workstream:

- **Data safety.** A failed build no longer deletes the previous report. Report and PGNs are bound
  by a digest. Automatic stops (storage failure, 90-minute limit) are visible. Shutdown drains the
  last batch.
- **Analysis correctness.** Mate scores map onto the centipawn scale, so a move that allows mate is a
  blunder. Illegal pasted moves are refused before any build. Engine failures are bounded and
  counted. Builds can be cancelled without writing. Engine depth was raised to 12. Lookups are
  linear-time. AI text with medical or mental-state claims is rejected. Coach memory is bounded.
- **Backend quality.** Typed error codes across IPC, one channel table, redacted logs, a doctor
  command, versioned storage, and AppImage packaging.
- **Experience and UI.** One navigation model, a first-run explainer, a setup screen, sensing
  controls, a sessions list (reopen, delete, export), design tokens, a component vocabulary,
  keyboard help, and plain copy.
- **Verification.** Test discovery from build output, jsdom component tests, Electron tests against
  the built app, a bug bash, and evidence scripts that never copy raw data.

**Left open.** The real-world checks (seated session, limit stop on real hardware, live AI reading,
clean-machine AppImage) were not run in this phase.

### Phase 6 — Review experience (`review-experience`)

**Delivered.** A chess and pulse palette in which the elevated state is encoded by colour, pattern
and word. A logo and a Home screen with a 3D board tile. Setup and Paste as visual panels with a
light meter. Games placed by the player's marks, with a picker when marks and games disagree. The
review in three stages (pulse, engine, reading). Readings with a hand or object over the face are
marked and excluded. The refusal names its most frequent framing cause.

**Left open.** The occlusion flag depends on the SDK's validation codes. If those codes stay "ok"
with a hand over the mouth, nothing is marked.

### Phase 7 — Report redesign (`report-redesign`)

**Delivered.**
- Only the sensed player's moves are scored. The player is the one name present in every counted
  game. When that is ambiguous, the paste screen asks once.
- Per-game summaries, session totals and engine identity are stored in the report.
- The report was recomposed as a centred shell: summary header, Pulse & Play Timeline, Move Quality
  tabs (overall and per game, linked to the timeline), and an AI Session Explainer with suggested
  questions.
- PGN clocks are read with their time zone.
- The AI provider is configured only from `.env`. A live OpenCode Go reading was grounded and
  rendered.
- Two real sessions ship as read-only examples on Home (section 3).

## 2. Key decisions

| Area | Decision | Why |
|---|---|---|
| Baseline and coverage | A sample counts when `stable` is true and confidence ≥ 50. The baseline is the median of those samples in the first 60 s. Each usable sample covers time until the next one, up to 1 s. | A weak sample is not a zero, and a hole lowers coverage honestly. |
| Coverage gate | Coverage is recomputed from samples before any engine work. Under 70% the result is a refusal. | A thin trace must not produce a weak report. |
| Elevated band | Fixed at baseline + 10 bpm, chosen before seeing any data. | The bands cannot be fitted to the result. |
| Accuracy and blunders | The published [Lichess accuracy formula](https://lichess.org/page/accuracy). A blunder is a drop of at least 30 win-percent points. A band needs five scored moves to print a percentage. | A known, checkable formula, and no number from too little data. |
| Engine determinism | `ucinewgame` before every position; only the score at the requested depth is kept. | A reused hash changed repeated scores. |
| Engine depth | Raised from 8 to 12 after a rule fixed in advance: ≤ 400 ms mean and ≤ 5% blunder-flag change. Measured 41 ms mean, 0 of 18 flags changed. | A depth change is measured, not chosen by feel. |
| Mate | Mate in N maps to ±(10,000 − 100N). Terminal positions are scored locally. | A move into forced mate must count as a blunder. |
| Illegal moves | Every pasted game is replayed at paste time. One illegal move blocks the batch and names the game and move. | Silent truncation looked like a complete report. |
| Game placement | Games are placed by the player's own marks, not PGN header times. | Real exports do not reliably carry `EndTime`. |
| Player scope | Only the sensed player's moves are scored. | Counting the opponent's moves mixed two players into one accuracy. |
| Camera ownership | The SDK owns the camera in the main process; the preview taps its output. The key never reaches the page. | The page-camera path produced no readings, and the key stays in one process. |
| SDK telemetry | Turned off (`enableTelemetry: false`). | A local-first app should not send session summaries. |
| Storage | JSON and NDJSON files, atomic writes, a digest pairing report and PGNs, schema versions. | Inspectable, deletable by folder, no native module. |
| IPC errors | A closed set of error codes, each mapped to one fixed sentence. | Electron drops custom error fields, and raw text could leak internals or model output. |
| AI grounding | The model may cite only numbers present in the computed statistics. PGN text is never an allowlist source. Medical and mental-state claims are rejected. Replies render as text. | A PGN could otherwise inject a number, and model text is untrusted. |
| AI transport | Native fetch with each provider's documented request shape. 30 s timeout. One retry only on a server error or failed connection. Redirects are refused. | No SDK dependency, bounded cost, no duplicate call after an ambiguous timeout. |
| Example sessions | Two real sessions ship read-only under `demo/sessions/`. They are listed apart from the player's own and never written. | A new user can see both gate outcomes without a camera, and a new report still needs a live capture. |
| Licence | GPL-3.0-or-later. | The app ships Stockfish, which is GPL-3.0. |

## 3. Example sessions

Both examples are real sessions captured with ChessPulse. They are listed under **Example
sessions** on Home, apart from **Recent sessions**.

| Example | Session | Outcome |
|---|---|---|
| Failed the coverage gate (red) | 3 blitz games (3+2), 16:51 elapsed, 9% coverage, no report | The chest was out of frame in 84% of framing checks. The session's own PGNs were never saved, so opening it leads to the paste screen. Pasting any three chess.com games with clock times produces the refusal, which names that cause. |
| Passed the coverage gate (green) | 10 bullet games (1+0), 22:19 elapsed, 88% coverage, report saved | Opens the full report: summary, timeline, Move Quality and the AI Session Explainer. |

The passing session's report was rebuilt with the current version, so it includes player scope,
per-game summaries and engine identity.

## 4. Verification state

| Area | State |
|---|---|
| Typecheck, unit, component and storage tests | `PASS`: 658 tests in 73 files |
| Contrast and copy checks | `PASS` |
| Real seated session at ≥ 70% coverage with a saved report | `PASS`: the 88% example session |
| Coverage refusal on real data | `PASS`: the 9% example session |
| Live AI reading, grounded | `PASS`: OpenCode Go |
| Real coach threshold crossing between two real games | `NOT_RUN` |
| Automatic 90-minute limit stop on real hardware | `NOT_RUN` (covered by unit and disposable-build tests) |
| Packaged AppImage on a clean machine | `NOT_RUN` |

## 5. Known limitations

- **Platform.** Linux is the only tested platform. Development runs may need
  `--no-sandbox` when Electron's setuid sandbox helper is not installed.
- **Framing.** The SDK reports no pulse when the chest is out of frame. Sitting back and lighting
  the face from the front matter more than any setting.
- **Window visibility.** Capture needs the window on screen. Minimising it starves the camera, and
  the gate refuses the session.
- **Network.** Sensing needs a connection, because the SDK checks the API key and subscription with
  Presage's server.
- **Marks.** Game boundaries are the player's own marks. The app cannot detect a wrong mark, and
  marks are held in memory until the session stops.
- **Scoring depth.** Depth 12 was benchmarked on short opening fixtures for speed. Accuracy is not
  calibrated against deeper analysis of real games.
- **AI checks.** Grounding is conservative and lexical. It stops invented numbers and named claim
  classes, but it does not judge whether the narrative is good coaching.
- **Scope of claims.** Results describe one session. They show where mistakes and raised pulse
  coincided, not why.
