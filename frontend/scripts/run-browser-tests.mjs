// Own the Vite process explicitly so Windows test runs always return after the
// last browser case. Playwright connects to this server but does not manage it.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const vite = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
const playwright = fileURLToPath(new URL("../node_modules/@playwright/test/cli.js", import.meta.url));
const server = spawn(process.execPath, [vite, "--host", "127.0.0.1", "--port", "4173", "--strictPort"], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  stdio: ["ignore", "inherit", "inherit"],
  windowsHide: true,
});

async function ready() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error("Vite test server exited before it was ready.");
    try {
      const response = await fetch("http://127.0.0.1:4173", { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* Startup is still in progress. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Vite test server did not become ready.");
}

let result = 1;
try {
  await ready();
  const runner = spawn(process.execPath, [playwright, "test", "--workers=2", ...process.argv.slice(2)], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, NEXAAI_PLAYWRIGHT_EXTERNAL_SERVER: "1" },
  });
  const [code] = await once(runner, "exit");
  result = code ?? 1;
} catch {
  console.error("Browser test runner could not complete.");
} finally {
  if (server.exitCode === null) {
    server.kill();
    await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
}
process.exitCode = result;
