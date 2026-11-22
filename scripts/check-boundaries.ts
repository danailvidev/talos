const violations: string[] = [];
const importPattern = /(?:import|export)\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;

for await (const path of new Bun.Glob("{src,web/src}/**/*.{ts,tsx}").scan({
  cwd: ".",
  onlyFiles: true,
})) {
  const source = await Bun.file(path).text();

  // The response cache is reachable only through `api/cached.ts`, whose spec makes
  // the per-user scope a required field. A route that reached past it would be
  // free to write a key with no user in it, which serves one developer's private
  // repositories to another — silently, and invisibly with one user logged in.
  if (path !== "src/api/cached.ts" && source.includes("responseCache.fetch(")) {
    violations.push(`${path}: reads responseCache directly — use cached() from api/cached.ts`);
  }

  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1]!;

    if (path.startsWith("src/core/")) {
      if (
        specifier.includes("/app.") ||
        specifier.includes("/api/") ||
        specifier.includes("/infrastructure/") ||
        (specifier.includes("/persistence/") && !specifier.endsWith("/persistence/state-store.ts"))
      ) {
        violations.push(`${path}: core imports '${specifier}'`);
      }
    }

    if (
      path.startsWith("src/tasks/") &&
      (specifier.includes("/persistence/") ||
        specifier.includes("/api/") ||
        specifier.includes("/app."))
    ) {
      violations.push(`${path}: task imports '${specifier}'`);
    }

    if (path.startsWith("web/src/") && specifier.includes("/src/")) {
      violations.push(`${path}: frontend imports backend runtime '${specifier}'`);
    }
  }
}

if (violations.length > 0) {
  console.error(["Architecture boundary check failed:", ...violations.map((v) => `  ${v}`)].join("\n"));
  process.exit(1);
}

console.log("Architecture boundary check passed.");
