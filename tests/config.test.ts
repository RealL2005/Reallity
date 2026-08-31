import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEnvFile } from "../src/config.ts";

const keys = [
  "REALLITY_API_KEY",
  "REALLITY_MODEL",
  "REALLITY_BASE_URL",
  "REALLITY_WORKSPACE",
];

async function withEnvCleanup(fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const key of keys) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }

  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("loadEnvFile parses keys, quotes, comments, and export", async () => {
  await withEnvCleanup(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reallity-env-"));
    const envPath = path.join(root, ".env");
    await writeFile(
      envPath,
      [
        "# comment",
        "REALLITY_API_KEY=sk-test",
        'REALLITY_MODEL="gpt-4.1-mini"',
        "export REALLITY_BASE_URL=https://example.com/v1",
      ].join("\n"),
    );

    try {
      loadEnvFile(envPath);

      expect(process.env.REALLITY_API_KEY).toBe("sk-test");
      expect(process.env.REALLITY_MODEL).toBe("gpt-4.1-mini");
      expect(process.env.REALLITY_BASE_URL).toBe(
        "https://example.com/v1",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("loadEnvFile does not override an existing environment variable", async () => {
  await withEnvCleanup(async () => {
    process.env.REALLITY_MODEL = "already-set";
    const root = await mkdtemp(path.join(tmpdir(), "reallity-env-"));
    const envPath = path.join(root, ".env");
    await writeFile(envPath, "REALLITY_MODEL=from-file\n");

    try {
      loadEnvFile(envPath);

      expect(process.env.REALLITY_MODEL).toBe("already-set");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("loadEnvFile returns an empty object for a missing file", async () => {
  const result = loadEnvFile("/tmp/definitely-not-a-real-reallity-env-file");

  expect(result).toEqual({});
});

test("loadEnvFile ignores empty values", async () => {
  await withEnvCleanup(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reallity-env-"));
    const envPath = path.join(root, ".env");
    await writeFile(envPath, "REALLITY_WORKSPACE=\nREALLITY_MODEL=gpt-test\n");

    try {
      loadEnvFile(envPath);

      expect(process.env.REALLITY_WORKSPACE).toBeUndefined();
      expect(process.env.REALLITY_MODEL).toBe("gpt-test");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
