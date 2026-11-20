// What: the isolated preload. It will later expose a typed bridge and nothing else.
// Why: the page must not receive Node, files, or keys.
// Removed: a later screen could not send a validated message to main.
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('chesspulse', {});
