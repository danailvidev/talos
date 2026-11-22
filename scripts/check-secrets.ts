const SECRET_PATTERNS = [
  { name: "GitLab personal access token", pattern: /\bglpat-[A-Za-z0-9_.-]{20,}\b/g },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { name: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: "OpenAI API key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: "Datadog personal access token", pattern: /\bddpat_[A-Za-z0-9_-]{20,}\b/g },
  { name: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
] as const;

const SKIP = [
  ".git/",
  "node_modules/",
  "dist/",
  "coverage/",
  "bun.lock",
  "package-lock.json",
  ".db",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
] as const;

const findings: string[] = [];
const tracked = Bun.spawnSync(["git", "ls-files"], { stdout: "pipe" })
  .stdout.toString().split("\n").filter(Boolean);
for (const path of tracked) {
  if (
    /(^|\/)\.env(?:\.|$)/.test(path) ||
    /(^|\/)config\/\.env/.test(path) ||
    /\.(?:db|sqlite|sqlite3)(?:-|$)/.test(path)
  ) {
    findings.push(`${path}: sensitive runtime file is tracked`);
  }
}

const glob = new Bun.Glob("**/*");

for await (const path of glob.scan({ cwd: ".", onlyFiles: true, dot: true })) {
  if (SKIP.some((part) => path.includes(part))) continue;
  if (path.split("/").at(-1)?.startsWith(".env")) continue;

  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    continue;
  }

  for (const { name, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push(`${path}: possible ${name}`);
  }
}

if (findings.length > 0) {
  console.error(["Secret scan failed:", ...findings.map((finding) => `  ${finding}`)].join("\n"));
  process.exit(1);
}

console.log("Secret scan passed.");
