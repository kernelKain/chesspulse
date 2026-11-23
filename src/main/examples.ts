// What: the read-only example sessions that ship with the app, and the root each session id reads from.
// Why: a new user can open one real captured session that passed the coverage gate and one that was
//      refused, without a camera. The examples live outside the player's data folder, so they are
//      never listed as the player's own, never deleted, and never rewritten by a report build.
// Removed: the app would start empty, and the only way to see a report would be a full capture.
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SESSION_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Resolves the data root for one session id: an example's folder or the player's data folder. */
export type SessionRoot = (sessionId: string) => string;

export interface ExampleLibrary {
  /** A data root with the same layout as the player's: `<root>/sessions/<id>/`. */
  root: string;
  ids: ReadonlySet<string>;
}

/**
 * The shipped example root. Development runs read `demo/` in the checkout; a packaged build reads the
 * copy electron-builder places under `resources/demo/` (package.json `extraResources`).
 */
export function exampleRoot(app: { isPackaged: boolean; getAppPath(): string }, resourcesPath: string): string {
  return app.isPackaged ? path.join(resourcesPath, 'demo') : path.join(app.getAppPath(), 'demo');
}

/**
 * Lists example ids by scanning folders, never by writing an index. The root may be read-only, and a
 * missing or unreadable folder means "no examples", not a startup failure.
 */
export function readExampleLibrary(root: string): ExampleLibrary {
  const ids = new Set<string>();
  let names: string[];
  try {
    names = readdirSync(path.join(root, 'sessions'));
  } catch {
    return { root, ids };
  }
  for (const name of names) {
    if (!SESSION_ID.test(name)) continue;
    try {
      if (statSync(path.join(root, 'sessions', name, 'meta.json')).isFile()) ids.add(name);
    } catch {
      // A folder without meta.json is not a session.
    }
  }
  return { root, ids };
}

export function isExampleSession(library: ExampleLibrary, sessionId: string): boolean {
  return library.ids.has(sessionId);
}

/** Example ids read from the example root; every other id reads from the player's data folder. */
export function sessionRootFor(library: ExampleLibrary, dataRoot: () => string): SessionRoot {
  return (sessionId) => (library.ids.has(sessionId) ? library.root : dataRoot());
}
