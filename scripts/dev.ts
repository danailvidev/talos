#!/usr/bin/env bun
/**
 * Local development on one URL: http://127.0.0.1:4317
 *
 * Vite owns that port (hot reload). The API listens on 4318 and is reached
 * only through Vite's `/api` proxy — never open 4318 in a browser. The
 * production server binds 4317 and serves the built UI.
 */
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const web = join(root, "web");

const UI_PORT = 4317;
const API_PORT = 4318;

freePorts([UI_PORT, API_PORT, 5317, 5318, 5319]);

const api = Bun.spawn(
  ["bun", "--watch", "run", "src/server.ts"],
  {
    cwd: root,
    env: { ...Bun.env, PORT: String(API_PORT) },
    stdout: "inherit",
    stderr: "inherit",
  },
);

const ui = Bun.spawn(["bun", "run", "dev"], {
  cwd: web,
  stdout: "inherit",
  stderr: "inherit",
});

let stopping = false;
let stopCode: number | undefined;
const stop = (signal: "SIGINT" | "SIGTERM") => {
  const code = signal === "SIGINT" ? 130 : 143;
  if (stopping) {
    api.kill("SIGKILL");
    ui.kill("SIGKILL");
    process.exit(code);
  }
  stopping = true;
  stopCode = code;
  api.kill();
  ui.kill();
};

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

const [apiCode, uiCode] = await Promise.all([api.exited, ui.exited]);
process.exit(stopCode ?? (apiCode !== 0 ? apiCode : uiCode));

/** Drop anything still bound so Vite never hops to another port. */
function freePorts(ports: number[]): void {
  for (const port of ports) {
    Bun.spawnSync(["fuser", "-k", `${port}/tcp`], { stdout: "ignore", stderr: "ignore" });
  }
  Bun.sleepSync(400);
}
