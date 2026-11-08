import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { PiUploadResult } from "@usecontextlayer/pi-durable-assistant-ui";

export interface LocalPaths {
  dataDirectory: string;
  databasePath: string;
  workspacePath: string;
}

export interface ServerEnvironment {
  dataDirectory: string;
  provider: "faux" | "anthropic";
  modelId?: string;
  enableAnthropic: boolean;
  port: number;
}

export function readServerEnvironment(source: NodeJS.ProcessEnv = process.env): ServerEnvironment {
  if (source === process.env) {
    const envFile = fileURLToPath(new URL("../../../.env.local", import.meta.url));
    if (existsSync(envFile)) process.loadEnvFile(envFile);
  }
  const provider = source.PI_PROVIDER ?? "faux";
  if (provider !== "faux" && provider !== "anthropic") throw new Error(`Unknown PI_PROVIDER: ${provider}; use faux or anthropic.`);
  const port = Number(source.PORT ?? 5173);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be an integer from 0 through 65535.");
  return {
    dataDirectory: source.PI_DATA_DIRECTORY ?? fileURLToPath(new URL("../../../.data/", import.meta.url)),
    provider,
    modelId: source.PI_MODEL,
    enableAnthropic: Boolean(source.ANTHROPIC_API_KEY),
    port,
  };
}

export async function prepareLocalPaths(dataDirectory: string): Promise<LocalPaths> {
  const directory = resolve(dataDirectory);
  const databasePath = resolve(directory, "pi.sqlite");
  const workspacePath = resolve(directory, "workspace");
  await mkdir(dirname(databasePath), { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  return { dataDirectory: directory, databasePath, workspacePath };
}

export function createExecutionEnvironments(paths: LocalPaths) {
  const instances = new Map<string, NodeExecutionEnv>();
  return {
    get(cwd?: string) {
      const path = resolve(cwd ?? paths.workspacePath);
      let instance = instances.get(path);
      if (!instance) {
        instance = new NodeExecutionEnv({ cwd: path });
        instances.set(path, instance);
      }
      return instance;
    },
    async close() {
      await Promise.all([...instances.values()].map((instance) => instance.cleanup(BACKGROUND_CONTEXT)));
    },
  };
}

const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface LocalUploadResult extends PiUploadResult {
  contentType: string;
  size: number;
  path: string;
  url: string;
}

export async function storeUploadedFile(
  paths: LocalPaths,
  file: { name: string; contentType: string; data: Uint8Array },
): Promise<LocalUploadResult> {
  const name = basename(file.name).replace(/[\r\n]/g, "") || "attachment";
  const storedName = `${randomUUID()}-${name}`;
  const path = join(paths.workspacePath, "uploads", storedName);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, file.data, { flag: "wx" });
  return {
    name,
    contentType: file.contentType,
    size: file.data.byteLength,
    path,
    url: `/api/files/${encodeURIComponent(storedName)}`,
    content: imageTypes.has(file.contentType)
      ? [{ type: "image", data: Buffer.from(file.data).toString("base64"), mimeType: file.contentType }]
      : [{ type: "text", text: `Uploaded file: ${name}\nThe file is available to the native file tools at ${path}` }],
  };
}

export async function readUploadedFile(paths: LocalPaths, storedName: string) {
  if (basename(storedName) !== storedName || !/^[\da-f-]{36}-.+$/i.test(storedName)) return undefined;
  try {
    const data = await readFile(join(paths.workspacePath, "uploads", storedName));
    const contentType = ({
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".txt": "text/plain; charset=utf-8",
      ".md": "text/plain; charset=utf-8",
      ".json": "application/json",
    } as Record<string, string>)[extname(storedName).toLowerCase()] ?? "application/octet-stream";
    return { data, contentType };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
