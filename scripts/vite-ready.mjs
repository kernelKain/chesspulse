// What: resolves only after the Vite process reports its own bound URL.
// Why: a free TCP connection, or a still-running npx process, can belong to another server.
// Removed: Electron could open against the wrong port or a server that failed to bind.
export function watchViteReady(vite, readyText, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = '';
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    vite.stdout?.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes(readyText)) finish();
    });
    vite.once('exit', (code) => {
      finish(new Error(`The renderer server exited before it was ready (code ${code ?? 'none'}).`));
    });
    setTimeout(() => {
      finish(new Error('The renderer server did not report that it bound port 5173.'));
    }, timeoutMs);
  });
}
