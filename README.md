# ChessPulse

ChessPulse is a local desktop app for reviewing a chess.com session after you play. It keeps a pulse trace beside the clock and the moves, then asks whether a bad stretch was a state problem or a chess problem.

It is not a chess trainer, not an engine overlay, and not a medical device. It makes no diagnosis.

The app does not watch a rated game. There is no engine, evaluation, or advice while a game is live. You play on chess.com. ChessPulse looks at the session afterwards.

## Run

Requirements: Node 22, npm, a display, and a camera for sensing.

```bash
npm install
cp .env.example .env
npm test
npm run dev
```

`npm test` is the unit suite. `npm run test:consent` is separate: it builds `dist/` and `dist-electron/` first, then opens Electron. It is not part of `npm test` and does not run without that build.

`npm run dev` opens the window against the local page at `http://127.0.0.1:5173`. `npm run build` then `npm start` opens the built page from disk.

If Electron aborts because the sandbox helper is not setuid, start the built app with `--no-sandbox`. That flag is a development workaround.

```bash
npx electron --no-sandbox .
```

The SmartSpectra key and any model key belong in `.env` only. `.env.example` lists the names and stays empty. The main process reads `.env` at startup; a value already exported by the shell wins. Sensing needs `SMARTSPECTRA_API_KEY`; the window does not call a model.

## Consent and data

The camera stays off until you press **Allow the camera**. Revoking consent releases the camera and stops an open session. The main process opens the camera through the SmartSpectra SDK and does all measuring there; the page receives a small preview bitmap and the measured numbers, never the key. Nothing is recorded.

A session is a folder of numbers: `meta.json` and `samples.ndjson`. No image or video file is written. The folder is under `$XDG_DATA_HOME/chesspulse` or `~/.local/share/chesspulse`. Deleting that folder deletes the session. Nothing in the app is uploaded, and there is no account.

## Current limits

The sensing screen draws pulse samples as the session stores them, and breaks the line when samples are more than one second apart. It also shows a mirrored camera preview and the measured light level.

Framing matters more than anything else. The player must be the only face in frame, facing the camera, with the **upper chest visible** — the SDK reports "Place more of the chest in view" and produces no pulse until that is true. Sit back until your shoulders and chest are in the preview. In a dim room the preview is brightened for framing only; the measured frames are unchanged, so a genuinely dark room still lowers confidence and coverage. A lamp in front of you is the fix.

The capture path has not yet been verified against a real seated session reporting usable coverage. Without a camera or a valid key, starting a session stops with the specific reason (no camera, rejected key, no credit, network failure). Pulse, not breathing, is the only metric requested.

Pasted games, local Stockfish scoring, and the report are in this build. The between-games coach line and the optional AI reading panels are not.
