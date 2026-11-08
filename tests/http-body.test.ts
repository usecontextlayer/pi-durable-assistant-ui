import { once } from "node:events";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { expect } from "vitest";
import { createApiServer } from "../apps/demo/server/http.js";
import { openLocalPiHost } from "../apps/demo/server/host.js";
import { createLocalPiDurableClient } from "../apps/demo/server/local-client.js";
import { test } from "./support/fixtures.js";

test("HTTP preserves a title when a UTF-8 character spans request chunks", async ({ dataDirectory }) => {
  const host = await openLocalPiHost({ dataDirectory });
  const client = createLocalPiDurableClient(host);
  const server = createApiServer(host);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const conversation = await client.createConversation();
    const title = "Résumé ☕ 日本";
    const bytes = Buffer.from(JSON.stringify({ title }));
    const split = bytes.indexOf(Buffer.from("☕")) + 1;
    const outgoing = request({
      hostname: "127.0.0.1",
      port: (server.address() as AddressInfo).port,
      path: `/api/conversations/${conversation.id}/metadata`,
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
    });
    const responseReady = once(outgoing, "response");
    // Deliver the remaining bytes only after the server receives the first chunk.
    server.once("request", (incoming) => incoming.once("data", () => outgoing.end(bytes.subarray(split))));
    outgoing.write(bytes.subarray(0, split));
    const [response] = await responseReady;
    response.setEncoding("utf8");
    let body = "";
    for await (const chunk of response) body += chunk;
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(body).title).toBe(title);
    expect((await client.getMetadata(conversation.id)).title).toBe(title);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await host.close();
  }
});
