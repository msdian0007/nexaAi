const required = process.argv.includes("--required");
const value = process.env.VITE_API_BASE_URL?.trim();

if (!value && !required) process.exit(0);
try {
  if (!value) throw new Error();
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || !url.pathname.endsWith("/api/v1")) throw new Error();
  console.log("Frontend API URL is valid.");
} catch {
  console.error("VITE_API_BASE_URL must be an absolute HTTP(S) URL ending in /api/v1.");
  process.exitCode = 1;
}
