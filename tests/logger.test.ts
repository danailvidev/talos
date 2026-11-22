import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createLogger } from "../src/logging/logger.ts";

/** Collects newline-delimited JSON written by a logger. */
function capture() {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (c) => chunks.push(String(c)));
  return {
    stream,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    text: () => chunks.join(""),
  };
}

describe("logger redaction", () => {
  test("redacts secrets by key path", async () => {
    const out = capture();
    const logger = createLogger({ destination: out.stream, pretty: false });

    logger.info({ token: "super-secret-token", user: "alice" }, "auth");
    await Bun.sleep(5);

    const [line] = out.lines();
    expect(line?.token).toBe("[redacted]");
    expect(line?.user).toBe("alice");
  });

  test("redacts nested authorization headers", async () => {
    const out = capture();
    const logger = createLogger({ destination: out.stream, pretty: false });

    logger.info({ req: { headers: { authorization: "Bearer abc123xyz" } } }, "call");
    await Bun.sleep(5);

    expect(out.text()).not.toContain("abc123xyz");
  });

  test("scrubs known secret values interpolated into messages", async () => {
    const out = capture();
    const secret = "glpat-AbCdEf123456";
    const logger = createLogger({
      destination: out.stream,
      pretty: false,
      secretValues: [secret],
    });

    logger.info(`requesting https://gitlab.com?private_token=${secret}`);
    await Bun.sleep(5);

    expect(out.text()).not.toContain(secret);
    expect(out.text()).toContain("[redacted]");
  });

  test("scrubs secret values nested in objects and arrays", async () => {
    const out = capture();
    const secret = "xoxb-0987654321";
    const logger = createLogger({
      destination: out.stream,
      pretty: false,
      secretValues: [secret],
    });

    logger.info({ config: { headers: [`Bearer ${secret}`] } }, "sending");
    await Bun.sleep(5);

    expect(out.text()).not.toContain(secret);
  });

  test("leaves short values alone, since they are placeholders not credentials", async () => {
    const out = capture();
    const logger = createLogger({
      destination: out.stream,
      pretty: false,
      secretValues: ["abc"],
    });

    logger.info("abc is a common substring appearing in normal text");
    await Bun.sleep(5);

    expect(out.text()).toContain("abc is a common substring");
  });

  test("preserves error messages while scrubbing secrets inside them", async () => {
    const out = capture();
    const secret = "glpat-SecretValue99";
    const logger = createLogger({
      destination: out.stream,
      pretty: false,
      secretValues: [secret],
    });

    logger.error({ err: new Error(`failed with token ${secret}`) }, "boom");
    await Bun.sleep(5);

    const text = out.text();
    expect(text).not.toContain(secret);
    expect(text).toContain("failed with token");
  });

  test("tees NDJSON to an extra destination", async () => {
    const out = capture();
    const extra = capture();
    const logger = createLogger({
      destination: out.stream,
      pretty: false,
      tee: [extra.stream],
    });

    logger.info({ executionId: "e1" }, "hello");
    await Bun.sleep(15);

    expect(extra.lines()[0]?.msg).toBe("hello");
    expect(extra.lines()[0]?.executionId).toBe("e1");
    expect(out.lines()[0]?.msg).toBe("hello");
  });
});
