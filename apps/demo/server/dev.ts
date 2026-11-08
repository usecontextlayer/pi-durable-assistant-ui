import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer as createViteServer } from "vite";
import { openLocalPiHost, type OpenLocalPiHostOptions } from "./host.js";
import { createApiServer } from "./http.js";
import { readServerEnvironment } from "./env.js";

const root = fileURLToPath(new URL("../", import.meta.url));

export async function startDemoServer(options: OpenLocalPiHostOptions & { port?: number }) {
  const piHost = await openLocalPiHost(options);
  const server = createApiServer(piHost, {
    fallback: (request, response, next) => vite.middlewares(request, response, next),
  });
  const vite = await createViteServer({
    root,
    server: { middlewareMode: true, ws: { server } },
    appType: "spa",
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 5173, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    piHost,
    server,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await vite.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await piHost.close();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const demo = await startDemoServer({
    ...readServerEnvironment(),
  });
  console.log(`Pi Durable + Assistant UI: ${demo.url}`);
  console.log(`Pi data: ${demo.piHost.paths.dataDirectory}`);
  console.log(`Provider: ${demo.piHost.defaultAgent.model?.provider}`);
  process.once("SIGINT", () => void demo.close().then(() => process.exit(0)));
  process.once("SIGTERM", () => void demo.close().then(() => process.exit(0)));
}
