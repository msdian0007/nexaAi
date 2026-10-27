import { spawnSync } from "node:child_process";

const operation = process.argv[2];
if (!new Set(["backup", "restore-drill"]).has(operation)) {
  console.error("Use: node scripts/production-ops.mjs backup|restore-drill");
  process.exit(2);
}

const compose = [
  "compose", "-f", "docker-compose.production.yml",
  "-f", "docker-compose.production.ops.yml", "--env-file", ".env.production",
];
function run(args, extraEnvironment = {}) {
  // Inherit secrets from Compose's env file without printing their values.
  const result = spawnSync("docker", [...compose, ...args], {
    stdio: "inherit",
    env: { ...process.env, ...extraEnvironment },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (operation === "backup") {
  run(["run", "--rm", "database-export"]);
  run(["run", "--rm", "restic-backup"]);
} else {
  run(["run", "--rm", "restic-restore"]);
  run(["run", "--rm", "restore-drill"], { ALLOW_RESTORE_DRILL: "yes" });
}
