import { validateRuntimeConfig, type RuntimeRole } from "./runtime";

const role = process.argv[2] as RuntimeRole;
if (!["api", "worker", "migration"].includes(role)) {
  console.error("Choose api, worker or migration configuration.");
  process.exitCode = 1;
} else {
  try {
    validateRuntimeConfig(role);
    console.log(`${role} configuration is valid.`);
  } catch {
    // Environment values and parser details can contain secrets. Startup gets a
    // stable failure while the operator uses the documented setting checklist.
    console.error(`${role} configuration is invalid. Check required settings.`);
    process.exitCode = 1;
  }
}
