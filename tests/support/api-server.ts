import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createHttpPiClient } from "../../packages/adapter/src/client.js";
import { openLocalPiHost, type OpenLocalPiHostOptions } from "../../apps/demo/server/host.js";
import { createApiServer } from "../../apps/demo/server/http.js";

export async function startApiServer(dataDirectory: string, options: Omit<OpenLocalPiHostOptions, "dataDirectory" | "provider"> = {}) {
  const piHost = await openLocalPiHost({ dataDirectory, provider: "faux", tokensPerSecond: 100_000, ...options });
  const server = createApiServer(piHost);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}/api`;

  return {
    piHost,
    baseUrl,
    client: createHttpPiClient({ baseUrl }),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await piHost.close();
    },
  };
}
