// What: answers Paste screen validation requests over IPC using the main-process parser.
// Why: keeps PGN parsing and order enforcement in main so renderer and report builder never diverge.
// Removed: the Paste screen could not validate games or enforce chronological order.
import { ipcMain } from 'electron';
import { pasteValidationSchema, pgnValidateRequestSchema } from '../shared/contracts.js';
import { validatePasteBatch } from './analysis/paste.js';

export const PASTE_VALIDATE_CHANNEL = 'cp:pgn:validate';

export function registerPasteHandler(): void {
  ipcMain.handle(PASTE_VALIDATE_CHANNEL, (_event, payload: unknown) => {
    const parsed = pgnValidateRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error('Paste entries must be text within the paste size limit.');
    }
    return pasteValidationSchema.parse(validatePasteBatch(parsed.data.slots));
  });
}
