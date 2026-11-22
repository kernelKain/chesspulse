// What: points the SmartSpectra SDK at the native runtime shipped beside the app.
// Why: the SDK loads its shared library before app startup code can run, and a packaged asar
//      cannot serve a dlopen path, so the override must be set by the first imported module.
// Removed: the packaged app would fail at import time with the native runtime "not installed".
import { existsSync } from 'node:fs';
import path from 'node:path';

const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? '';
const packagedLibrary = path.join(resources, 'smartspectra', 'libsmartspectra_capi.so');

if (!process.env.SMARTSPECTRA_CAPI_PATH && existsSync(packagedLibrary)) {
  process.env.SMARTSPECTRA_CAPI_PATH = packagedLibrary;
}
