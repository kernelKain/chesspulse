// What: decides whether a navigation stays inside the window's allowed page.
// Why: a text prefix treats port 51730 as part of port 5173.
// Removed: the window could follow a different origin.
export function allowsNavigation(url: string, devUrl: string | undefined): boolean {
  if (devUrl) {
    try {
      if (new URL(url).origin === new URL(devUrl).origin) return true;
    } catch {
      return false;
    }
  }
  return url.startsWith('file:');
}
