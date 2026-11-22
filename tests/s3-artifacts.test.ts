import { describe, expect, test } from "bun:test";
import { GetObjectCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { S3E2eArtifactStore } from "../src/infrastructure/e2e/artifacts.ts";

describe("S3 E2E artifacts", () => {
  test("lists only bounded supported evidence under the execution prefix", async () => {
    const client = {
      send: async (command: unknown) => {
        expect(command).toBeInstanceOf(ListObjectsV2Command);
        return {
          Contents: [
            { Key: "talos/e2e/run-1/screenshot.png", Size: 12 },
            { Key: "talos/e2e/run-1/unsupported.bin", Size: 10 },
            { Key: "talos/e2e/run-2/other.log", Size: 10 },
          ],
        };
      },
    } as unknown as S3Client;
    const store = new S3E2eArtifactStore({
      bucket: "artifacts",
      prefix: "talos/e2e",
      client,
    });

    expect(await store.list("run-1")).toEqual([
      {
        name: "screenshot.png",
        kind: "screenshot",
        bytes: 12,
        contentType: "image/png",
      },
    ]);
  });

  test("downloads an object without exposing unsafe paths", async () => {
    const client = {
      send: async (command: unknown) => {
        expect(command).toBeInstanceOf(GetObjectCommand);
        return {
          ContentLength: 3,
          ContentType: "text/plain",
          Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
        };
      },
    } as unknown as S3Client;
    const store = new S3E2eArtifactStore({
      bucket: "artifacts",
      prefix: "talos/e2e",
      client,
    });

    expect((await store.open("run-1", "browser.log"))?.body).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    await expect(store.open("run-1", "../secret.log")).rejects.toThrow(
      "Invalid E2E artifact name",
    );
  });
});
