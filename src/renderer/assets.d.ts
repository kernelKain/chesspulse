// What: the shape TypeScript sees when the renderer imports a bundled asset by URL.
// Why: Vite resolves `*.svg?url` to a string at build time; tsc needs that shape declared.
// Removed: the renderer would stop typechecking the moment it imports the logo.
declare module '*.svg?url' {
  const url: string;
  export default url;
}
