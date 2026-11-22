import { lstat, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { ConfigError } from "../../core/errors.ts";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

export type E2eArtifactKind = "screenshot" | "trace" | "log";

export interface E2eArtifact {
  name: string;
  kind: E2eArtifactKind;
  contentType: string;
  bytes: number;
}

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_EXECUTION_BYTES = 100 * 1024 * 1024;

export interface E2eArtifactRepository {
  prepare(executionId: string): Promise<string>;
  list(executionId: string): Promise<E2eArtifact[]>;
  open(
    executionId: string,
    name: string,
  ): Promise<{ body: Uint8Array; artifact: E2eArtifact } | null>;
  discard(executionId: string): Promise<void>;
  purge(before: Date, limit?: number): Promise<number>;
}

export class E2eArtifactStore implements E2eArtifactRepository {
  constructor(readonly root: string) {}

  async prepare(executionId: string): Promise<string> {
    const path = this.executionPath(executionId);
    await rm(path, { recursive: true, force: true });
    await mkdir(path, { recursive: true, mode: 0o700 });
    return path;
  }

  async list(executionId: string): Promise<E2eArtifact[]> {
    const directory = this.executionPath(executionId);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return [];
    }
    const artifacts: E2eArtifact[] = [];
    let total = 0;
    for (const name of names.sort()) {
      const kind = artifactKind(name);
      if (!kind) continue;
      const path = this.filePath(executionId, name);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      if (info.size > MAX_FILE_BYTES || total + info.size > MAX_EXECUTION_BYTES) {
        await rm(path, { force: true });
        continue;
      }
      total += info.size;
      artifacts.push({
        name,
        kind,
        bytes: info.size,
        contentType: contentType(name),
      });
    }
    return artifacts;
  }

  async open(
    executionId: string,
    name: string,
  ): Promise<{ body: Uint8Array; artifact: E2eArtifact } | null> {
    const safeName = safeArtifactName(name);
    const kind = artifactKind(safeName);
    if (!kind) return null;
    const path = this.filePath(executionId, safeName);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) return null;
      return {
        body: await readFile(path),
        artifact: {
          name: safeName,
          kind,
          bytes: info.size,
          contentType: contentType(safeName),
        },
      };
    } catch {
      return null;
    }
  }

  async discard(executionId: string): Promise<void> {
    await rm(this.executionPath(executionId), { recursive: true, force: true });
  }

  async purge(before: Date, limit = 100): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      if (removed >= limit) break;
      const path = this.executionPath(entry);
      try {
        const info = await stat(path);
        if (info.isDirectory() && info.mtime < before) {
          await rm(path, { recursive: true, force: true });
          removed++;
        }
      } catch {
        // A concurrent run or retention pass may already have removed it.
      }
    }
    return removed;
  }

  private executionPath(executionId: string): string {
    if (!/^[a-zA-Z0-9_.:-]+$/.test(executionId)) {
      throw new ConfigError("Invalid E2E execution id.");
    }
    return join(this.root, executionId);
  }

  private filePath(executionId: string, name: string): string {
    const directory = this.executionPath(executionId);
    const path = resolve(directory, safeArtifactName(name));
    if (!path.startsWith(`${resolve(directory)}${sep}`)) {
      throw new ConfigError("Invalid E2E artifact path.");
    }
    return path;
  }
}

export class S3E2eArtifactStore implements E2eArtifactRepository {
  private readonly client: S3Client;
  private readonly prefix: string;

  constructor(options: {
    bucket: string;
    prefix: string;
    region?: string;
    client?: S3Client;
  }) {
    this.bucket = options.bucket;
    this.prefix = options.prefix.replace(/^\/+|\/+$/g, "");
    this.client = options.client ?? new S3Client({
      ...(options.region ? { region: options.region } : {}),
    });
  }

  readonly bucket: string;

  async prepare(executionId: string): Promise<string> {
    validateExecutionId(executionId);
    // Kubernetes workers write directly to S3. The return value remains for the
    // Docker runner's filesystem-shaped call site and is ignored in K8s mode.
    return `/artifacts/${executionId}`;
  }

  async list(executionId: string): Promise<E2eArtifact[]> {
    const prefix = this.executionPrefix(executionId);
    const response = await this.client.send(new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: prefix,
    }));
    const artifacts: E2eArtifact[] = [];
    let total = 0;
    for (const object of response.Contents ?? []) {
      const key = object.Key;
      if (!key || !key.startsWith(prefix)) continue;
      const name = key.slice(prefix.length);
      if (!name || name.includes("/")) continue;
      const kind = artifactKind(name);
      const bytes = object.Size ?? 0;
      if (!kind || bytes > MAX_FILE_BYTES || total + bytes > MAX_EXECUTION_BYTES) continue;
      total += bytes;
      artifacts.push({ name, kind, bytes, contentType: contentType(name) });
    }
    return artifacts.sort((left, right) => left.name.localeCompare(right.name));
  }

  async open(
    executionId: string,
    name: string,
  ): Promise<{ body: Uint8Array; artifact: E2eArtifact } | null> {
    const safeName = safeArtifactName(name);
    const kind = artifactKind(safeName);
    if (!kind) return null;
    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: `${this.executionPrefix(executionId)}${safeName}`,
      }));
      const bytes = response.ContentLength ?? 0;
      if (!response.Body || bytes > MAX_FILE_BYTES) return null;
      const body = await response.Body.transformToByteArray();
      if (body.byteLength > MAX_FILE_BYTES) return null;
      return {
        body,
        artifact: {
          name: safeName,
          kind,
          bytes: body.byteLength,
          contentType: response.ContentType ?? contentType(safeName),
        },
      };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw error;
    }
  }

  async discard(executionId: string): Promise<void> {
    const prefix = this.executionPrefix(executionId);
    const response = await this.client.send(new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: prefix,
    }));
    const objects = (response.Contents ?? [])
      .flatMap((entry) => entry.Key ? [{ Key: entry.Key }] : []);
    if (objects.length) {
      await this.client.send(new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: { Objects: objects, Quiet: true },
      }));
    }
  }

  async purge(before: Date, limit = 100): Promise<number> {
    const response = await this.client.send(new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: `${this.prefix}/`,
    }));
    const executions = new Map<string, { keys: string[]; newest: Date }>();
    for (const object of response.Contents ?? []) {
      if (!object.Key || !object.LastModified) continue;
      const rest = object.Key.slice(this.prefix.length + 1);
      const executionId = rest.split("/", 1)[0];
      if (!executionId) continue;
      const current = executions.get(executionId) ?? { keys: [], newest: new Date(0) };
      current.keys.push(object.Key);
      if (object.LastModified > current.newest) current.newest = object.LastModified;
      executions.set(executionId, current);
    }
    const expired = [...executions.values()]
      .filter((entry) => entry.newest < before)
      .slice(0, limit);
    for (const entry of expired) {
      for (let offset = 0; offset < entry.keys.length; offset += 1000) {
        await this.client.send(new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: {
            Objects: entry.keys.slice(offset, offset + 1000).map((Key) => ({ Key })),
            Quiet: true,
          },
        }));
      }
    }
    return expired.length;
  }

  private executionPrefix(executionId: string): string {
    validateExecutionId(executionId);
    return `${this.prefix}/${executionId}/`;
  }
}

function safeArtifactName(name: string): string {
  if (!name || basename(name) !== name || name === "." || name === "..") {
    throw new ConfigError("Invalid E2E artifact name.");
  }
  return name;
}

function validateExecutionId(executionId: string): void {
  if (!/^[a-zA-Z0-9_.:-]+$/.test(executionId)) {
    throw new ConfigError("Invalid E2E execution id.");
  }
}

function artifactKind(name: string): E2eArtifactKind | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "screenshot";
  }
  if (
    lower.endsWith(".zip") ||
    lower.includes("trace") ||
    lower.includes("session") ||
    lower.endsWith(".jsonl")
  ) {
    return "trace";
  }
  if (lower.endsWith(".log") || lower.endsWith(".txt") || lower.endsWith(".json")) {
    return "log";
  }
  return undefined;
}

function contentType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".json") || lower.endsWith(".jsonl")) return "application/json";
  if (lower.endsWith(".md")) return "text/markdown; charset=utf-8";
  return "text/plain; charset=utf-8";
}
