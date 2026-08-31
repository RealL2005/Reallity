import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function loadEnvFile(
  filePath = path.join(process.cwd(), ".env"),
): Record<string, string> {
  if (!existsSync(filePath)) {
    return {};
  }

  const loaded: Record<string, string> = {};
  const source = readFileSync(filePath, "utf8");

  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const withoutExport = line.startsWith("export ")
      ? line.slice("export ".length)
      : line;
    const separator = withoutExport.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = withoutExport.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    const rawValue = withoutExport.slice(separator + 1).trim();
    const value = stripQuotes(rawValue);

    if (value.length === 0) {
      continue;
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
    loaded[key] = value;
  }

  return loaded;
}

export function loadProjectEnvFiles(): Record<string, string> {
  const fromCwd = loadEnvFile(path.join(process.cwd(), ".env"));
  const fromPackage = loadEnvFile(path.join(packageRoot, ".env"));
  return { ...fromPackage, ...fromCwd };
}

function stripQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
