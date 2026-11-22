
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire("/opt/talos/package.json");
const bundledChromium = require("playwright").chromium.executablePath();
const { PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const config = JSON.parse(await readFile("/run/talos/config.json", "utf8"));
const workspace = "/workspace";
const artifacts = "/artifacts";
const secrets = "/run/talos-secret";

// Credentials arrive as files rather than -e values and are deleted once read.
const takeSecret = async (name) => {
  const path = join(secrets, name);
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  } finally {
    await rm(path, { force: true });
  }
};
const gitlabToken = (await takeSecret("gitlab-token")) ?? "";
const agentEnv = JSON.parse((await takeSecret("agent-env.json")) ?? "{}");

const logEvent = (event, status, extra = {}) =>
  console.log(JSON.stringify({ type: "talos", event, status, ...extra }));
const run = (command, args, options = {}) => new Promise((resolveRun, reject) => {
  const child = spawn(command, args, { stdio: options.stdio ?? "inherit", ...options });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) resolveRun();
    else reject(new Error(command + " exited " + (code ?? signal)));
  });
});

process.on("SIGTERM", () => process.exit(143));
process.on("SIGINT", () => process.exit(130));

const uploadArtifacts = async () => {
  if (!config.artifactUpload) return;
  const client = new S3Client({
    ...(config.artifactUpload.region ? { region: config.artifactUpload.region } : {}),
  });
  let total = 0;
  for (const name of (await readdir(artifacts)).sort()) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) continue;
    const path = join(artifacts, name);
    const info = await stat(path);
    if (!info.isFile() || info.size > 25 * 1024 * 1024 || total + info.size > 100 * 1024 * 1024) {
      continue;
    }
    total += info.size;
    await client.send(new PutObjectCommand({
      Bucket: config.artifactUpload.bucket,
      Key: config.artifactUpload.prefix.replace(/\/+$/, "") + "/" + name,
      Body: await readFile(path),
      ContentType: name.endsWith(".png")
        ? "image/png"
        : name.endsWith(".json") || name.endsWith(".jsonl")
          ? "application/json"
          : "application/octet-stream",
      Metadata: { "talos-created-at": new Date().toISOString() },
    }));
  }
  logEvent("artifacts-upload", "done", { count: (await readdir(artifacts)).length });
};

try {
  await mkdir(artifacts, { recursive: true });
  const archiveUrl =
    config.gitlabApiUrl.replace(/\/+$/, "") +
    "/projects/" + encodeURIComponent(config.project) +
    "/repository/archive.tar.gz?sha=" + encodeURIComponent(config.sha);
  logEvent("checkout", "started", { project: config.project, branch: config.branch, sha: config.sha });
  const archivePath = "/tmp/repository.tar.gz";
  const headerPath = "/tmp/gitlab-archive-headers";
  await writeFile(
    headerPath,
    "PRIVATE-TOKEN: " + gitlabToken + "\nAccept: application/octet-stream\n",
    { mode: 0o600 },
  );
  try {
    await run("curl", [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--header", "@" + headerPath,
      "--output", archivePath,
      archiveUrl,
    ]);
  } finally {
    await rm(headerPath, { force: true });
  }
  await mkdir(workspace, { recursive: true });
  await run("tar", ["-xzf", archivePath, "--strip-components=1", "-C", workspace]);
  await rm(archivePath, { force: true });
  logEvent("checkout", "done", { sha: config.sha });

  await mkdir(join(workspace, ".talos"), { recursive: true });
  for (const name of await readdir("/mr-input")) {
    await cp(join("/mr-input", name), join(workspace, ".talos", name));
  }

  logEvent("vpn-preflight", "started", { url: config.runtime.startUrl });
  try {
    await run("curl", [
      "--silent",
      "--show-error",
      "--max-time", "20",
      "--output", "/dev/null",
      config.runtime.startUrl,
    ]);
  } catch {
    throw new Error(
      "QA URL is unreachable from the E2E container. Connect the Talos host to the corporate VPN and retry. " +
        "If the host can reach it but the container cannot, the VPN client is likely blocking Docker " +
        "bridge forwarding; set TALOS_E2E_NETWORK=host.",
    );
  }
  logEvent("vpn-preflight", "done");

  const mcpConfig = {
    mcpServers: {
      playwright: {
        command: "/opt/talos/node_modules/.bin/playwright-mcp",
        args: [
          "--headless",
          "--no-sandbox",
          "--executable-path", bundledChromium,
          "--isolated",
          "--output-dir", artifacts,
          "--save-session",
          ...(config.hasPlaywrightSecrets
            ? ["--secrets", "/run/talos-secret/playwright-secrets.env"]
            : []),
        ],
      },
    },
  };
  await writeFile("/run/talos/mcp.json", JSON.stringify(mcpConfig));

  logEvent("agent", "started");
  await run("/opt/talos/node_modules/.bin/claude", [
    "-p", config.prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--strict-mcp-config",
    "--mcp-config", "/run/talos/mcp.json",
    "--tools", "Read,Grep,Glob,mcp__playwright__*",
    "--allowedTools", "Read,Grep,Glob,mcp__playwright__*",
    "--permission-mode", "dontAsk",
    ...(config.model ? ["--model", config.model] : []),
    ...(config.effort ? ["--effort", config.effort] : []),
  ], { cwd: workspace, env: { ...process.env, ...agentEnv } });
  logEvent("agent", "done");
} catch (error) {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
} finally {
  // Playwright needs the secrets file for the duration of the MCP session, but
  // it must not remain in the pod's emptyDir while a completed Job awaits GC.
  await rm("/run/talos-secret/playwright-secrets.env", { force: true });
  try {
    await uploadArtifacts();
  } catch (error) {
    console.error("artifact upload failed: " + (error?.stack ?? String(error)));
    process.exitCode = 1;
  }
}
