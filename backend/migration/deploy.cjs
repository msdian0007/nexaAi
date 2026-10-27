require("dotenv/config");
const { spawnSync } = require("node:child_process");

try {
  const url = new URL(process.env.DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname ||
      !url.username || !url.pathname || url.pathname === "/") throw new Error();
} catch {
  console.error("Migration configuration is invalid. Check DATABASE_URL.");
  process.exit(1);
}

const result = spawnSync(process.execPath,
  ["node_modules/prisma/build/index.js", "migrate", "deploy", "--config", "prisma7.config.ts"],
  { stdio: "inherit" });
if (result.error) console.error("Migration runner could not start.");
process.exitCode = result.status ?? 1;
