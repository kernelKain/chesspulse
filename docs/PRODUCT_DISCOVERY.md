# ChessPulse — Product Discovery

This document defines the product: who it is for, what it does, what it refuses to do, and the
assumptions it rests on. The engineering plan is in [ENGINEERING_BLUEPRINT.md](ENGINEERING_BLUEPRINT.md),
and what was built is in [EXECUTION.md](EXECUTION.md).

---

## 1. The product in one sentence

ChessPulse reviews a chess.com session the way a coach would, by looking at the player as well as
the moves. It puts pulse, clock, think time and mistakes on one timeline.

It is a local desktop app. It is not a chess trainer, not an engine overlay, and not a medical
device.

## 2. User and problem

- **User.** A chess.com blitz or rapid player, rated roughly 700–2000, who plays sessions of 5–15
  games and already reviews their games.
- **Trigger.** A session ends badly and the player is still at the desk: three losses in twenty
  minutes, a rating slide, a rage rematch.
- **What they do today.** An engine review on chess.com or lichess, a vague self-diagnosis, a break
  taken on feel, or a forum thread about tilt.
- **Root problem.** Tilt shows up in the body, and existing tools only see outcomes. Tools such as
  Chessy, Aimchess and Statmate infer tilt from results: win rate after a loss, worst hours, session
  length. None of them joins engine evaluation to a physiological timeline.
- **What is at stake.** Rating, enjoyment and wasted evenings. Health is not at stake, which is why
  the product makes no medical claim and does not need one.

## 3. Core loop

```text
Trigger      a session ends badly, the player is still at the desk
Input        live camera sensing during play; pasted PGNs afterwards
Mechanism    pulse sampling with confidence gating; local engine scoring;
             alignment of games to the pulse trace; band aggregation; gap analysis
Result       one timeline, one verdict line, a coach prompt between games
Proof        the raw trace shown with the derived bands; alignment confidence printed;
             AI text separated and labelled INFERRED
Next action  queue again or take a real break; the next session tests the rule
```

**Worked example.** A 20-minute blitz session is played with the app sensing, then three PGNs are
pasted. The app places each game on the session clock, scores every move locally, turns evaluation
swings into centipawn loss and accuracy, and groups accuracy by the pulse band at each move. The
result reads like this:

> 8 blunders, 5 of them in the eleven minutes your pulse stayed 18 bpm above baseline. Accuracy 71%
> settled, 54% elevated. Between games 2 and 3 you waited four minutes and never came down.

## 4. Why this is different

The closest tools detect tilt from results and cannot see the player's state. Lichess and chess.com
review moves in depth but have no player layer. ChessPulse works on a different axis rather than
being a better chess engine. The camera earns its place because it adds something the move list
cannot show: the minute the session turned.

The parts that make it more than a pulse display:

- domain computation: engine evaluation, centipawn loss, accuracy;
- time alignment of two streams that were never designed to be joined;
- aggregation gated by signal confidence and coverage;
- comparison against the player's own baseline, never an absolute threshold.

## 5. Role of AI

The model writes narrative text only. It never computes a number, never draws a chart, and never
produces the verdict line. Every number it may cite must already exist in the locally computed
report. Without an API key the app is a complete product.

The optional AI layer supports five providers: OpenAI, Anthropic, Google, OpenCode
(OpenAI-compatible), and a custom OpenAI-compatible base URL.

## 6. Non-negotiables

- **Local only.** No hosted page, no accounts, no cloud sync.
- **Post-game only.** No engine, evaluation, overlay or advice while a rated game is live. This
  fair-play line is the ethical core of the product.
- **No video stored.** Only numeric samples with timestamps. Camera consent is explicit and
  revocable, with a persistent sensing indicator.
- **Refuse rather than guess.** Coverage below the gate produces a refusal, not a weak report.
- **AI never computes.** AI text is visually separated and labelled `INFERRED`.
- **No medical or diagnostic claims** anywhere.
- **Real data only.** A new report always requires a live capture. The app ships two real captured
  sessions as labelled, read-only examples: one that passed the coverage gate and one that was
  refused. They exist so a new user can see both outcomes before setting up a camera. There is no
  fixture or simulated path to a report.

## 7. Scope

### Essential

- Consent screen, persistent sensing indicator, revocable camera.
- Live pulse strip during play.
- A 60-second baseline.
- Sample store with coverage detection.
- PGN paste with order checks, clock parsing, ending classification, and aborted games excluded.
- Local engine pass, centipawn loss, accuracy and banding.
- Timeline merge, alignment and gap analysis.
- Accuracy by pulse band.
- Game endings on the timeline.
- Between-games recovery coach.
- Optional AI layer: provider adapter, narrative, `INFERRED` panels.
- Local storage, with every computed layer usable when the AI layer is off.
- README with a consent and data-handling section.

### Optional, in priority order

Recovery curve, blunder density strip, think-time collapse, scatter plot with a printed caveat,
chess.com public API import, weekly multi-session view, session card export, spoken start and end
markers.

### Excluded

Live board integration, any engine or overlay during a rated game, accounts, cloud sync, a mobile
client, opening preparation, training plans, and social features.

## 8. Adoption

- **First useful result.** A sentence the player could not have written before, such as: "My
  accuracy dropped 14 points while my pulse was 18 bpm above baseline, and I played four more games
  in that state."
- **Setup cost.** One consent action and one baseline minute. A 20-minute session needs under three
  minutes of interaction.
- **Full loop.** Start a session, give consent, sit through the baseline, play, stop, paste PGNs,
  read the report, optionally ask the AI, then decide on the next session.
- **Trust.** The camera needs explicit permission and shows an indicator while on. No video is
  stored. PGNs, engine output and reports stay on the machine. AI is opt-in, uses the player's own
  key, and receives PGNs plus summary statistics only, never video or raw pulse traces.
- **Why a player might stop.** They already know they tilt and want a brake rather than a report.
  Their lighting fails the coverage gate. The camera setup is more friction than their habit
  tolerates.
- **Recurring value.** Weekly, if a report changes one decision. It is a review habit, not a
  subscription product.

## 9. Fallbacks and limits

- A shallow engine pass keeps scoring fast.
- When a PGN lacks timing data, the report says so and states the error bound instead of guessing.
- Game boundaries are marked by the player, not detected by speech or inferred from pulse.
- Coverage below 70% produces a refusal.

## 10. Experience

- **Interface pattern.** A single-column instrument, not a dashboard. The reading order is: what the
  body did, what the moves did, and where they met.
- **Screens.** Start (time control and consent), sensing (deliberately sparse), between games (one
  line), paste (validation feedback), report (timeline first), reading (AI, clearly separated). No
  onboarding tour, no settings page, no login.
- **Character.** Calm, clinical and unpatronising, like a lab readout. No confetti, streaks or
  motivational copy.
- **Distinctive element.** The verdict line: one sentence at the top of the report, built from
  computed numbers, naming the moment the session turned.
- **Hardest part.** The timeline, which carries several encodings on one axis. The risk is
  legibility rather than code, so it was built early and reviewed against real data.

## 11. Evidence and assumptions

| Claim | Status |
|---|---|
| The SmartSpectra SDK has no browser build, so a desktop host (Node/Electron) is required | Verified from the SDK platform list |
| Competitor tools infer tilt from results only | Supported by their public descriptions; not independently tested |
| Chess suits camera sensing: seated, still, face and chest visible | Supported by the SDK's documented working conditions |
| A real session can reach usable coverage | Verified: a 22-minute session reached 88%. A poorly framed session reached 9% and was refused |
| Real chess.com PGNs carry per-move clocks | Verified when the timestamps option is ticked on export. `EndTime` is not reliably present |

**Weakest assumption.** A session-level pulse trace, averaged over windows and broken by gaps, has
to be stable enough for within-session bands to mean something, rather than reflecting lighting and
movement. If it is too noisy, the product degrades to "your pulse was higher in the second half".
The mitigations are built into the product: the 70% coverage gate, the raw trace always visible,
bands relative to the player's own baseline, and no absolute state claims.

## 12. Risks

| Risk | Type | Mitigation |
|---|---|---|
| Signal quality | Output quality | Coverage gate, visible raw trace, relative language |
| Camera friction | Adoption | One baseline minute, no account, clear consent |
| Readers unfamiliar with chess | Understanding | Plain-language labels alongside chess terms |
| Electron or camera failure on Linux | Access | Proven first, before any product work |
| SDK rate limits during a session | Access | Validated early; short test sessions |
| GPL obligations from the bundled engine | Licensing | The app is GPL-3.0-or-later, and Stockfish is credited |
