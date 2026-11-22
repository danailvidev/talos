import { describe, expect, test } from "bun:test";
import { loadEnvFile, parseEnvFile } from "../src/secrets/env-file.ts";

describe("parseEnvFile", () => {
  test("reads plain assignments", () => {
    const parsed = parseEnvFile("GITLAB_TOKEN=glpat-abc123\nJIRA_EMAIL=me@example.com");
    expect(parsed.get("GITLAB_TOKEN")).toBe("glpat-abc123");
    expect(parsed.get("JIRA_EMAIL")).toBe("me@example.com");
  });

  test("ignores comments and blank lines", () => {
    const parsed = parseEnvFile("# a comment\n\n  \nGITLAB_TOKEN=x\n");
    expect([...parsed.keys()]).toEqual(["GITLAB_TOKEN"]);
  });

  test("accepts the `export` form, since the file is often sourced by a shell", () => {
    expect(parseEnvFile("export GITLAB_TOKEN=x").get("GITLAB_TOKEN")).toBe("x");
  });

  test("strips surrounding quotes", () => {
    const parsed = parseEnvFile(`A="double"\nB='single'`);
    expect(parsed.get("A")).toBe("double");
    expect(parsed.get("B")).toBe("single");
  });

  test("keeps a # inside quotes, because API keys contain them", () => {
    // Trimming here would truncate the token and produce a 401 that says nothing
    // about why.
    expect(parseEnvFile(`A="tok#en"`).get("A")).toBe("tok#en");
  });

  test("drops a trailing comment from an unquoted value", () => {
    expect(parseEnvFile("A=value # notes").get("A")).toBe("value");
  });

  test("preserves = inside a value", () => {
    // Base64 padding and connection strings both rely on this.
    expect(parseEnvFile("A=a=b=c").get("A")).toBe("a=b=c");
  });

  test("skips lines that are not assignments", () => {
    const parsed = parseEnvFile("not an assignment\n=novalue\n9BAD=x\nGOOD=y");
    expect([...parsed.keys()]).toEqual(["GOOD"]);
  });

  test("an empty value is kept, not dropped", () => {
    // The store treats empty as unset; the parser should not decide that.
    expect(parseEnvFile("A=").get("A")).toBe("");
  });
});

describe("loadEnvFile", () => {
  const path = `/tmp/talos-env-test-${process.pid}.env`;

  test("applies values to the environment and reports the names", async () => {
    await Bun.write(path, "GITLAB_TOKEN=from-file\n");
    const env: Record<string, string | undefined> = {};

    const result = await loadEnvFile(path, env);

    expect(result.found).toBe(true);
    expect(result.applied).toEqual(["GITLAB_TOKEN"]);
    expect(env.GITLAB_TOKEN).toBe("from-file");
  });

  test("overrides a variable already set in the environment — the file wins", async () => {
    await Bun.write(path, "GITLAB_TOKEN=from-file\n");
    const env: Record<string, string | undefined> = { GITLAB_TOKEN: "from-shell" };

    const result = await loadEnvFile(path, env);

    // The file is what the operator edits, so it decides. A token exported in a
    // shell profile months ago must not quietly beat the one in config/.env: the
    // symptom is a 401 about a token the operator cannot see.
    expect(env.GITLAB_TOKEN).toBe("from-file");
    expect(result.applied).toEqual(["GITLAB_TOKEN"]);
    expect(result.skipped).toEqual([]);
  });

  test("reports which names it overrode, so the override is not silent", async () => {
    await Bun.write(path, "GITLAB_TOKEN=from-file\nJIRA_EMAIL=me@example.com\n");
    const env: Record<string, string | undefined> = { GITLAB_TOKEN: "from-shell" };

    const result = await loadEnvFile(path, env);

    // Only the name that actually differed: winning a contest nobody entered is
    // not worth a log line.
    expect(result.overrode).toEqual(["GITLAB_TOKEN"]);
  });

  test("an identical value is applied but not reported as an override", async () => {
    await Bun.write(path, "GITLAB_TOKEN=same\n");
    const env: Record<string, string | undefined> = { GITLAB_TOKEN: "same" };

    const result = await loadEnvFile(path, env);

    expect(result.overrode).toEqual([]);
    expect(result.applied).toEqual(["GITLAB_TOKEN"]);
  });

  test("an empty entry defers to the environment instead of clearing it", async () => {
    // Copying example.env produces a file full of empty entries. Treating those as
    // authoritative would delete every token a CI runner legitimately injected.
    await Bun.write(path, "GITLAB_TOKEN=\n");
    const env: Record<string, string | undefined> = { GITLAB_TOKEN: "from-shell" };

    const result = await loadEnvFile(path, env);

    expect(env.GITLAB_TOKEN).toBe("from-shell");
    expect(result.skipped).toEqual(["GITLAB_TOKEN"]);
    expect(result.applied).toEqual([]);
  });

  test("an empty entry with nothing in the environment stays unset", async () => {
    await Bun.write(path, "GITLAB_TOKEN=\n");
    const env: Record<string, string | undefined> = {};

    const result = await loadEnvFile(path, env);

    // Not set to "": the secret store's "is it configured" check reads emptiness,
    // and an empty string would report a missing token as present.
    expect(env.GITLAB_TOKEN).toBeUndefined();
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  test("a missing file is not an error — the environment may already be set", async () => {
    const result = await loadEnvFile("/tmp/talos-definitely-absent.env", {});
    expect(result.found).toBe(false);
    expect(result.applied).toEqual([]);
  });

  test("reports names only, so nothing here can leak a token into a log", async () => {
    await Bun.write(path, "GITLAB_TOKEN=glpat-secret\n");
    const result = await loadEnvFile(path, {});
    expect(JSON.stringify(result)).not.toContain("glpat-secret");
  });
});
