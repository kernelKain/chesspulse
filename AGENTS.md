# AGENTS.md — ChessPulse

Working agreement for any coding agent working in this repository (Cursor, OpenCode,
Claude Code, or otherwise). **Read this file at the start of every session.** It is the
contract; the blueprint is the plan.

---

## 1. Authoritative sources

| What | Where | Status |
|---|---|---|
| Product contract | `docs/PRODUCT-DISCOVERY.md` — packet v1.0 / product v0.4, approved 2026-11-19 | **APPROVED** — do not weaken |
| Engineering plan | `docs/ENGINEERING_BLUEPRINT.md` | **DRAFT** until approved on its own terms |
| This file | `AGENTS.md` | living |
| Repository of record | <https://github.com/kernelKain/chesspulse> (public) | verified public |

Precedence when instructions collide: latest explicit user instruction → approved blueprint
decisions → product packet → defaults in this file. If two of these genuinely conflict, **stop
and say so**; do not pick one silently. Product changes are the user's decision, never an
agent's inference.

`docs/` is gitignored, so the packet and blueprint exist only on this machine. That is
deliberate. Do not "helpfully" un-ignore them.

---

## 2. The product in one paragraph

ChessPulse reviews a chess.com session the way a coach would — by looking at the player, not
only the moves — putting pulse, clock, think time and blunder rate on one timeline. A blitz or
rapid player (roughly 700–2000) plays with the app sensing; afterwards they paste their PGNs;
the app aligns local engine evaluation to the physiological trace, gates on signal coverage, and
produces one timeline, one verdict line, and a between-games coach prompt. It is a local-first
Electron app. It is **not** a chess trainer, **not** an engine overlay, and **not** a medical
device.

---

## 3. Non-negotiables

- **Local-only.** No hosted page, no public URL, no accounts, no cloud sync. (Packet amendment A3.)
- **Post-game only.** No engine, evaluation, overlay or advice while a rated game is live. The
  fair-play line is this product's ethics core and must appear in the README and the article.
- **No video stored.** Numeric samples with timestamps only. Camera consent is explicit,
  revocable, and paired with a persistent sensing indicator.
- **Refuse rather than guess.** Coverage below the gate produces a refusal, not a weak report.
- **AI never computes.** No number may appear in AI output that cannot be traced to locally
  computed data. AI panels are visually separated and labelled `INFERRED`. The app is a complete
  product without an API key.
- **No medical or diagnostic claims** anywhere: UI, README, article, video, commit messages.
- **No demo mode and no fixture path** to the report. A report requires a real captured session.

---

## 4. Authority and commits

- Default **A1**: implement one named step at a time, run local checks, stop. Git, external
  setup, installs and deployment each need separate authorisation.
- Commit mode **ASK**: no commit without an explicit instruction that names the step.
- Never, on your own initiative: commit, push, merge, deploy, install system packages, create
  accounts, change billing, or run a billed API experiment.
- Never force-push, rewrite history, or discard work you did not create.
- Planning approval is **not** commit permission.
- **Branch names say what the work is** — `proofs`, `analysis-core`, `report` — never a phase or
  step number. **Commit subjects name one change in the imperative** — "Add PGN clock parsing",
  not "phase-2 step 3". Numbers in Git history are a liability: they tell a reader nothing and
  go stale the moment a plan changes.

Prompt 2 runs at A1 with commit mode ASK. Blueprint §4 records that decision.

---

## 5. Working agreement

| Rule | What it means here |
|---|---|
| One phase at a time | The phase plan lives in the blueprint. Do not invent, reorder or merge phases; if a phase is wrong, say so and propose a change. |
| Smallest coherent step | Each step is one meaningful outcome, verifiable in under a minute; otherwise split it. |
| Explain before, not after | State approach and trade-off in 3–5 lines before a significant change. No 400-line diff followed by an explanation. |
| No unexplained code | Every non-obvious file, function and dependency gets a short *what / why / what breaks if removed* note. |
| Teach-back gate | Learning notes after each meaningful step. The four blueprint checkpoints are the explain-back gates. An unanswered checkpoint pauses the next phase. Minor edits are not blocked on a quiz. |
| No hidden magic | No scaffolding generators, no configuration the user cannot justify in an interview. If a library does heavy lifting, name the specific thing it does. |
| Ask, don't assume | One focused question beats building the wrong thing. Use reversible defaults for trivia only. |
| Honesty about state | "Untested", "works on my machine" and "I could not verify this" are acceptable. Invented success is not. |
| Verify then report | Report `PASS` / `FAIL` / `NOT_RUN` / `INCONCLUSIVE` / `STALE` tied to the revision actually tested. |
| Repair budget | Reproduce → gather evidence → test one hypothesis → smallest fix → verify. Three focused cycles, then stop and report. |
| Interface is part of the argument | Typography, spacing, contrast, focus and every boring state are held to the blueprint's design brief (§7). "Works but looks templated" is not done. |

---

## 6. Docs and git hygiene

- **All documentation lives in `docs/`.** It is gitignored in full. Assets get subfolders:
  `docs/images/`, `docs/video/`, `docs/diagrams/`, `docs/drafts/`, `docs/phases/`.
- **Never bulk-un-ignore `docs/`.** Publishing a document is one deliberate negation line that
  the user approves.
- Maintained during Prompt 2:
  - `docs/ENGINEERING_BLUEPRINT.md` — stack, contracts, phases, acceptance criteria.
  - `docs/decisions.md` — one entry per real decision: context, options, choice, consequences.
  - `docs/phases/phase-NN.md` — what was built, how it works, how to run it, what's shaky.
- Owned by Prompt 3 (amendment P2-A). Do not draft these during Prompt 2:
  - `docs/project-qa.md` — interview-style Q&A.
  - `docs/video/script.md` — demo script with timing cues.
  - `docs/drafts/devto-article.md` — the DEV.to article.
- **`README.md` is the only documentation intended for publication.** What it is, how to run it,
  screenshots of a real captured report, article link. Honest and minimal.
- Tracked root files stay limited to: `README.md`, `AGENTS.md`, `.gitignore`, `.env.example`,
  `package.json` + lockfile, source, `LICENSE`.
- No media loose in `docs/` or the repository root.

**Stage split.** Prompt 2 writes the technical phase notes and decision entries above. Prompt 3
writes the DEV.to article, the demo script, interview Q&A, X posts, and submission material.
Prompt 2 does not start those drafts. **Never publish, post or submit.** The user submits.

---

## 7. Secrets

- `.env` and `.env.*` are ignored; `.env.example` is committed with empty values.
- The SmartSpectra API key and any AI provider key live only in the environment. Never in code,
  logs, commits, screenshots, the article or the demo video.
- Assume the repository is public at all times.
- Validate environment variables at startup and fail with a human-readable message, not a stack
  trace.
- Never ask the user to paste a secret value into chat.

---

## 8. Engineering standards

- **TypeScript strict.** No `any` without a written reason in a comment.
- **Validate every boundary:** SDK payloads, IPC messages, pasted PGNs, AI responses, env vars.
- **Distinct, human-readable failure states** for the failures that actually happen: no camera,
  face not found / poor lighting, invalid key, rate limit, network failure during gating, low
  coverage, PGN with no `EndTime`.
- **Test where wrongness is silent:** PGN and clock parsing, centipawn-loss banding, timeline
  alignment, the coverage gate, and AI grounding checks. Do not write tests that merely mirror
  the implementation.
- **Accessibility is part of done:** keyboard operation, visible focus, contrast, a non-colour
  encoding of the "elevated" band, and reduced-motion behaviour.
- **Bound anything that costs money or touches the network:** timeouts, retries, cancellation,
  and no duplicate billed calls after an ambiguous timeout.
- **Read the SDK's live docs, not memory.** For SmartSpectra: `llms.txt` is the index, and any
  page serves markdown by appending `.md`. The SDK moves; stale syntax is a self-inflicted
  failure.

---

## 9. AI layer rules

- Provider adapter with five presets: OpenAI, Anthropic, Google, OpenCode (OpenAI-compatible),
  and a custom OpenAI-compatible base URL.
- Payload is PGN plus computed summary statistics. Never video, never a raw pulse trace, never
  the key.
- The model writes narrative, inferred-state notes and captions only. Chart geometry, verdict
  numbers, band boundaries and coach thresholds are computed locally.
- AI output is untrusted text: never inject it as HTML, and never promote a number from it into
  a computed field.
- If a provider is unavailable, the app degrades honestly (AI panel disabled with a reason),
  not silently.

---

## 10. Demo and publishing

- The video must show a **real captured session** end to end: the report at the end is the same
  session shown earlier — same date, same games, same trace. No fixtures, no demo mode, no
  re-enactment presented as live. Prompt 2 captures that session and keeps the evidence.
- Stock or AI-generated visuals are acceptable **only** for non-evidentiary segments (intro,
  transitions, concept illustration), and must be disclosed. They may never stand in for a
  session, a trace, a report or a "live" moment.
- Demo-script planning and production guidance belong to Prompt 3 (`docs/video/script.md`).
  The user records the voiceover.
- **Never publish, post, or submit on the user's behalf.**
- The consent and data-handling section in the README is a Prompt 2 deliverable, not an appendix.

---

## 11. Report in this order, every turn

1. **Where we are** — phase/step, and what this achieves.
2. **Plan** — the change in a few lines, with the trade-off named.
3. **Do it.**
4. **Verify** — how, and the actual result (`PASS` / `FAIL` / `NOT_RUN`).
5. **What this means** — 2–4 sentences the user could say aloud.
6. **Docs updated** — which `docs/` files changed.
7. **Next step** — what's next, and whether it needs approval.

Tight prose, structure over paragraphs. Assume intelligence, not familiarity with this SDK.

---

## 12. Inherited from the external "SmartSpectra Vitals Web App" brief

That brief was supplied as a source of working conventions, not as this project's definition.
What crossed over, and what did not:

| Adopted | Not adopted, and why |
|---|---|
| Phase-gated delivery with approval per phase | Its **product definition** (vitals web app, general-wellness positioning) — ChessPulse's approved packet governs. |
| Teach-back gate; no unexplained code; explain before | Its **browser-only measurement architecture question** — already settled: the SDK has no browser build, so Electron/Node hosts it. |
| `docs/` ignored; decisions log; Q&A file; phase notes | Its **prompt-compiler rules** (2048-byte cap, 15 s / 60 s buffers, pulse/HRV/breathing-only payloads) — those fit its insight feature, not ChessPulse's post-game narrative layer. |
| Secrets only via env; `.env.example` committed | Its **OpenRouter** default — conflicts with packet amendments A1/A2 (five providers including OpenCode). The packet wins. |
| TypeScript strict; validate boundaries; a11y as done | Its **frontend-first phase order** — conflicts with the packet's proof-first order (real session report before polish). The blueprint wins. |
| Demo script; never publish on the user's behalf | Its **6-phase frontend-first ladder** — replaced by the blueprint's proof-first phases, where the report is built from real data before any polish. |
| Article and demo production owned by Prompt 3 (blueprint amendment P2-A) | Its **"I will not appear on camera"** — only compatible if the demo never needs the player's face; flagged to the user rather than assumed. |
