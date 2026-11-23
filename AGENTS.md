# AGENTS.md — ChessPulse

The working agreement for any coding agent in this repository. Read it at the start of every
session.

## 1. Sources

| What | Where |
|---|---|
| Product definition | [docs/PRODUCT_DISCOVERY.md](docs/PRODUCT_DISCOVERY.md). Do not weaken it. |
| Engineering plan | [docs/ENGINEERING_BLUEPRINT.md](docs/ENGINEERING_BLUEPRINT.md) |
| What was built, decisions, limits | [docs/EXECUTION.md](docs/EXECUTION.md) |
| Demo material and example sessions | [demo/README.md](demo/README.md) |
| Repository | <https://github.com/kernelKain/chesspulse> (public) |

When instructions collide, the order is: the latest explicit user instruction, then the blueprint,
then the product definition, then this file. If two of them genuinely conflict, stop and say so.
Product changes are the user's decision, never an agent's inference.

## 2. The product in one paragraph

ChessPulse reviews a chess.com session by looking at the player as well as the moves. It puts
pulse, clock, think time and mistakes on one timeline. The player plays with the app sensing, then
pastes their PGNs. The app scores the moves locally, aligns them to the pulse trace, gates on signal
coverage, and produces one timeline, one verdict line and a between-games coach prompt. It is a
local Electron app. It is not a chess trainer, not an engine overlay, and not a medical device.

## 3. Non-negotiables

- **Local only.** No hosted page, no accounts, no cloud sync.
- **Post-game only.** No engine, evaluation, overlay or advice while a rated game is live.
- **No video stored.** Numeric samples with timestamps only. Camera consent is explicit and
  revocable, with a persistent sensing indicator.
- **Refuse rather than guess.** Coverage below the gate produces a refusal, not a weak report.
- **AI never computes.** No number in AI output that is not in the locally computed data. AI text is
  visually separated and labelled `INFERRED`. The app is complete without an API key.
- **No medical or diagnostic claims** in the UI, the README, or commit messages.
- **Real data only.** A new report requires a live capture. The two real sessions in
  `demo/sessions/` ship as labelled, read-only examples. No other fixture or simulated path may
  reach a report.

## 4. Authority and commits

- Implement one named step at a time, run local checks, and stop.
- Installs, external setup, commits, pushes and deployment each need explicit authorisation.
- No commit without an explicit instruction. Planning approval is not commit permission.
- Never force-push, rewrite history, discard work you did not create, create accounts, change
  billing, or run a billed API call on your own initiative.
- Branch names describe the work (`analysis-core`, `report-redesign`), never a phase or step
  number. Commit subjects name one change in the imperative ("Add PGN clock parsing").

## 5. Working agreement

| Rule | What it means |
|---|---|
| Smallest coherent step | Each step is one outcome you can verify in under a minute. |
| Explain before | State the approach and trade-off in a few lines before a significant change. |
| No unexplained code | Every non-obvious file, function and dependency gets a short what / why / what breaks if removed note. |
| No hidden magic | No scaffolding generators or configuration that cannot be justified. Name what a library does. |
| Ask, don't assume | One focused question beats building the wrong thing. |
| Honest state | Report `PASS`, `FAIL`, `NOT_RUN`, `INCONCLUSIVE` or `STALE`, tied to the revision tested. |
| Repair budget | Reproduce, gather evidence, test one hypothesis, make the smallest fix, verify. Three cycles, then stop and report. |
| Interface quality | Typography, spacing, contrast, focus and every empty or error state follow the blueprint's design brief. |

## 6. Docs and git hygiene

- `docs/` is tracked and holds exactly three files: `PRODUCT_DISCOVERY.md`,
  `ENGINEERING_BLUEPRINT.md` and `EXECUTION.md`. Write them for outside readers.
- `docs/drafts/` is ignored. Private working notes go there.
- Demo material (screenshots, example sessions) goes in `demo/`.
- When a step changes behaviour, record the outcome, any real decision, and any new limitation in
  `docs/EXECUTION.md`. Keep it short.
- Never publish, post or submit anything on the user's behalf.

## 7. Secrets and privacy

- `.env` and `.env.*` are ignored. `.env.example` is committed with empty values.
- The SmartSpectra key and any AI key live only in the environment: never in code, logs, commits or
  screenshots.
- Assume the repository is public. Before tracking a new file, check it for keys, local paths and
  personal data.
- Validate environment variables at startup and fail with a readable message.
- Never ask the user to paste a secret into chat.

## 8. Engineering standards

- **TypeScript strict.** No `any` without a written reason.
- **Validate every boundary:** SDK payloads, IPC messages, pasted PGNs, AI responses, env vars.
- **Distinct, readable failure states** for the failures that actually happen: no camera, face not
  found or poor light, invalid key, rate limit, network failure, low coverage, malformed PGN.
- **Test where wrongness is silent:** PGN and clock parsing, CPL banding, alignment, the coverage
  gate, AI grounding. Do not write tests that only mirror the implementation.
- **Accessibility is part of done:** keyboard operation, visible focus, contrast, a non-colour
  encoding of "elevated", and reduced motion.
- **Bound anything that costs money or touches the network:** timeouts, retries, cancellation, and
  no duplicate billed call after an ambiguous timeout.
- **Read the SDK's live docs, not memory.** For SmartSpectra, `llms.txt` is the index and any page
  serves markdown with a `.md` suffix.

## 9. AI layer rules

- Five provider presets: OpenAI, Anthropic, Google, OpenCode (OpenAI-compatible), and a custom
  OpenAI-compatible base URL.
- The payload is PGNs plus computed summary statistics. Never video, a raw pulse trace, or the key.
- The model writes narrative only. Chart geometry, verdict numbers, band boundaries and coach
  thresholds are computed locally.
- AI output is untrusted text. Never render it as HTML, and never promote a number from it into a
  computed field.
- If a provider is unavailable, disable the AI panel and say why.

## 10. Report format

Report each step in this order:

1. **Where we are:** the step and what it achieves.
2. **Plan:** the change in a few lines, with the trade-off named.
3. **Do it.**
4. **Verify:** how, and the result (`PASS` / `FAIL` / `NOT_RUN`).
5. **What this means:** two to four plain sentences.
6. **Docs updated:** which files changed.
7. **Next step:** what comes next, and whether it needs approval.

## 11. Session capture and review

- Entire records agent sessions on this repository. At the start of a session, run `entire status`
  and confirm the current agent is listed and enabled. If it is not, tell the user before any work.
- Do not disable, bypass or edit Entire hooks, and do not change its push or checkpoint settings
  unless the user explicitly asks.
- The user reviews each step (CodeRabbit in the editor) before the next one starts. Wait for the go
  ahead, apply only the fixes the user names, and re-run the checks.
