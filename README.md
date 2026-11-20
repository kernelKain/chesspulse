# ChessPulse

ChessPulse is a local desktop app for reviewing a chess.com session after you play. It keeps a pulse trace beside the clock and the moves, then asks whether a bad stretch was a state problem or a chess problem.

It is not a chess trainer, not an engine overlay, and not a medical device. It makes no diagnosis.

The app does not watch a rated game. There is no engine, evaluation, or advice while a game is live. You play on chess.com. ChessPulse looks at the session afterwards.

## Run

Requirements: Node 22, npm, and a display.

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

The SmartSpectra key and any model key belong in `.env` only. `.env.example` lists the names and stays empty. The current window does not call the camera SDK or a model.

## Consent and data

The camera stays off until you press **Allow the camera**. Revoking consent stops an open session. Video is granted only to the main frame of this app's own built page, not to every file on disk, and only for the camera, not the microphone or the screen. The dev page is `http://127.0.0.1:5173`, so it can record consent and still cannot open the camera.

A session is a folder of numbers: `meta.json` and `samples.ndjson`. No image or video file is written. The folder is under `$XDG_DATA_HOME/chesspulse` or `~/.local/share/chesspulse`. Deleting that folder deletes the session. Nothing in the app is uploaded, and there is no account.

## Current limits

The sensing screen draws pulse samples the main process has stored. It breaks the line when samples are more than one second apart. The SDK is not connected yet, so starting a session does not produce a live trace. Pasting games, the engine, and the report are not in this build.
