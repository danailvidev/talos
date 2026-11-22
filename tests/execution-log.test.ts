import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { TaskExecutor } from "../src/core/executor.ts";
import { EMPTY_RESULT, type Task } from "../src/core/task.ts";
import { createExecutionLogCapture } from "../src/logging/capture.ts";
import { createLogger } from "../src/logging/logger.ts";
import { migrate } from "../src/persistence/migrations.ts";
import { SqliteTaskSink } from "../src/persistence/sqlite-task-sink.ts";
import { SqliteStateStore } from "../src/persistence/sqlite-state-store.ts";
import { EnvSecretStore } from "../src/secrets/secret-store.ts";

const noParams = z.object({}).loose();

describe("execution log capture", () => {
  test("records logger lines for a run, in order, with the step binding", async () => {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    migrate(db);

    const sink = new SqliteTaskSink(db);
    const logger = createLogger({
      destination: new PassThrough(),
      pretty: false,
      level: "info",
      tee: [createExecutionLogCapture(sink)],
    });

    const executor = new TaskExecutor({
      logger,
      state: new SqliteStateStore(db),
      secrets: new EnvSecretStore({}),
      sink,
      generateExecutionId: () => "exec-1",
    });

    const task: Task<{}> = {
      id: "logged",
      name: "logged",
      kind: "task",
      paramsSchema: noParams,
      async run(ctx) {
        await ctx.step("work", async () => {
          ctx.logger.info({ item: 7 }, "doing work");
        });
        return EMPTY_RESULT;
      },
    };

    await executor.run(task);
    await Bun.sleep(20);

    const lines = sink.logs("exec-1");
    expect(lines.map((l) => l.message)).toContain("task logged started");
    expect(lines.map((l) => l.message)).toContain("doing work");
    expect(lines.map((l) => l.message)).toContain("step work succeeded");
    expect(lines.find((l) => l.message === "doing work")).toMatchObject({
      level: "info",
      meta: { item: 7 },
    });
    expect(lines.find((l) => l.message === "step work succeeded")?.step).toBe("work");

    db.close();
  });

  test("ignores lines that are not part of a task run", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    migrate(db);
    const sink = new SqliteTaskSink(db);
    const stream = createExecutionLogCapture(sink);

    stream.write('{"level":"info","msg":"booting"}\n');
    expect(sink.logs("exec-1")).toEqual([]);
    db.close();
  });

  test("drops an oversized unterminated record and resumes at the next line", async () => {
    const received: Array<{ executionId: string; message: string }> = [];
    const stream = createExecutionLogCapture({
      appendLog: (executionId, line) => received.push({ executionId, message: line.message }),
    });

    stream.write("x".repeat(1024 * 1024 + 1));
    stream.write('\n{"executionId":"exec-1","level":"info","msg":"recovered"}\n');
    await new Promise<void>((resolve, reject) => stream.end((error?: Error | null) => error ? reject(error) : resolve()));

    expect(received).toEqual([{ executionId: "exec-1", message: "recovered" }]);
  });
});
