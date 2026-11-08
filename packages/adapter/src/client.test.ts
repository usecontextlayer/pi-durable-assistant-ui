import { createServer, type RequestListener, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import type { ConversationId, ConversationView } from "@earendil-works/pi-durable";
import { createHttpPiDurableClient, type HttpPiDurableWatchFrame, type PiDurableConnectionState } from "./client.js";

async function server(handler: RequestListener) {
  const listener = createServer(handler);
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  return {
    baseUrl: `http://127.0.0.1:${(listener.address() as AddressInfo).port}`,
    close: async () => {
      listener.closeAllConnections();
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    },
  };
}

it("rejects a refused EventSource connection instead of retrying acquisition", async () => {
  let requests = 0;
  const host = await server((_request, response) => {
    requests++;
    response.writeHead(403);
    response.end("Forbidden");
  });
  try {
    const client = createHttpPiDurableClient({ baseUrl: host.baseUrl, reconnectDelayMs: 5 });
    await expect(client.watch(1 as ConversationId, { signal: AbortSignal.timeout(1000) })).rejects.toThrow("Pi watch connection closed.");
    expect(requests).toBe(1);
  } finally {
    await host.close();
  }
});

it("reports open once per connection and ends an acquired watch when reconnect is refused", async () => {
  let requests = 0;
  let response!: ServerResponse;
  let subscriptionId!: number;
  const view: ConversationView = { conversation: { id: 1 as ConversationId }, entries: [], docs: { "pi.agent": { maxTurns: 1 } } };
  const send = (frame: HttpPiDurableWatchFrame) => response.write(`data: ${JSON.stringify({ subscriptionId, frame })}\n\n`);
  const host = await server((request, candidate) => {
    requests++;
    if (requests > 1) {
      candidate.writeHead(403);
      candidate.end("Forbidden");
      return;
    }
    response = candidate;
    const subscriptions = JSON.parse(new URL(request.url!, "http://localhost").searchParams.get("subscriptions")!);
    subscriptionId = subscriptions[0].subscriptionId;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    send({ type: "view", view });
  });
  const controller = new AbortController();
  try {
    const connection: PiDurableConnectionState[] = [];
    const client = createHttpPiDurableClient({ baseUrl: host.baseUrl, reconnectDelayMs: 5 });
    const watch = await client.watch(1 as ConversationId, { signal: controller.signal, onConnection: (state) => connection.push(state) });
    watch.start(async () => {});
    send({ type: "ops", ops: [["s", ["docs", "pi.agent", "maxTurns"], 2]] });
    await expect.poll(() => watch.value.docs).toEqual({ "pi.agent": { maxTurns: 2 } });
    expect(connection.filter((state) => state === "connected")).toHaveLength(1);
    response.end();
    await expect(watch.closed).resolves.toMatchObject({ kind: "failed", error: expect.objectContaining({ message: "Pi watch connection closed." }) });
    expect(connection.at(-1)).toBe("closed");
    expect(requests).toBe(2);
  } finally {
    controller.abort();
    await host.close();
  }
});
