// What: answers Paste screen validation requests over IPC using the main-process parser.
// Why: keeps PGN parsing and order enforcement in main so renderer and report builder never diverge.
// Removed: the Paste screen could not validate games or enforce chronological order.
import { pasteValidationSchema } from '../shared/contracts.js';
import { validatePasteBatch } from './analysis/paste.js';
import { registerInvokeChannel } from './ipc-registry.js';

export function registerPasteHandler(): void {
  registerInvokeChannel('pasteValidate', (_event, payload) =>
    pasteValidationSchema.parse(validatePasteBatch(payload.slots)),
  );
}
