import http2 from "node:http2";
import fs from "node:fs";
import { SsePubSub } from "./sse-pub-sub.js";
import { PresenceDelete, PresenceUpdates, PresenceUpsert } from "./types.js";
import { initRedis, redisClient } from "./redis.js";
import { z } from "zod";
import { mkApp } from "@workspace/typed-http2-handler";

const state = { isShutdown: false };

async function shutdown(): Promise<void> {
  if (state.isShutdown) {
    console.log("Please wait until graceful shutdown is complete");
    return;
  }
  state.isShutdown = true;
  try {
    // TODO: Iterate over all open presence streams and delete the corresponding data from redis
    process.exit(0);
  } catch (e) {
    console.error("Failed to shutdown server gracefully", e);
    process.exit(1);
  }
}

process.on("SIGTERM", () => {
  console.log("SIGTERM received, entering shutdown");
  void shutdown();
});

process.on("SIGINT", () => {
  console.log("SIGINT received, entering shutdown");
  void shutdown();
});

const options = {
  key: fs.readFileSync("./localhost.direct.key"),
  cert: fs.readFileSync("./localhost.direct.crt"),
};

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "*",
};

const server = http2.createSecureServer(options);

server.on("error", (err) => console.error(err));

const app = mkApp(server);

app.handle("OPTIONS", "^.*$", ({ stream }) => {
  stream.respond({ ...corsHeaders, ":status": 204 });
});

const ssePubSub = new SsePubSub();
await ssePubSub.init();

await initRedis();

// Channel

app.handleWithData(
  "POST",
  "^/channel/(?<channelName>.+?)/pub$",
  z.string(),
  async ({ stream, params, data }) => {
    await ssePubSub.publish(params.channelName, data);
    stream.respond(corsHeaders);
    stream.end("ok");
  }
);

app.handle(
  "GET",
  "^/channel/(?<channelName>.+?)/sub$",
  async ({ stream, params }) => {
    await ssePubSub.subscribe(params.channelName, stream);

    stream.respond({
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });

    const handler = () => ssePubSub.unsubscribe(params.channelName, stream);

    stream.on("close", handler);
    stream.on("error", handler);
    stream.on("end", handler);
    stream.on("aborted", handler);
    stream.on("finish", handler);
    stream.on("drain", handler);
    stream.on("unpipe", handler);
  }
);

// Presence

app.handle(
  "GET",
  "^/presence/(?<channelName>.+?)/get$",
  async ({ stream, params }) => {
    const ch = `presence:${params.channelName}`;
    const obj = await redisClient.HGETALL(ch);
    const updates: PresenceUpdates = Object.entries(obj).map(
      ([clientId, str]) => ({
        type: "upsert",
        clientId,
        data: JSON.parse(str),
      })
    );
    stream.respond({ ...corsHeaders, "content-type": "application/json" });
    stream.end(JSON.stringify(updates));
  }
);

app.handleWithData(
  "POST",
  "^/presence/(?<channelName>.+)/pub$",
  PresenceUpsert,
  async ({ stream, params, data }) => {
    const ch = `presence:${params.channelName}`;

    await redisClient.HSET(ch, data.clientId, JSON.stringify(data.data));
    await ssePubSub.publish(ch, JSON.stringify([data]));

    stream.respond(corsHeaders);
    stream.end("ok");
  }
);

app.handle(
  "GET",
  "^/presence/(?<channelName>.+)/sub/(?<clientId>.+)$",
  async ({ stream, params }) => {
    const ch = `presence:${params.channelName}`;

    await ssePubSub.subscribe(ch, stream);

    stream.respond({
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });

    stream.on("close", async () => {
      ssePubSub.unsubscribe(ch, stream);
      redisClient.HDEL(ch, params.clientId);
      const update: PresenceDelete = {
        type: "delete",
        clientId: params.clientId,
      };
      ssePubSub.publish(ch, JSON.stringify([update]));
    });
  }
);

// Stats

app.handle("GET", "^/stats$", ({ stream }) => {
  stream.respond({ ...corsHeaders, "content-type": "application/type" });

  const result: Record<string, number> = {};
  for (const [key, val] of ssePubSub.activeChannels.entries()) {
    result[key] = val.size;
  }

  stream.end(JSON.stringify(result));
});

const port = process.env.PORT ? parseInt(process.env.PORT) : 8001;
server.listen(port);
console.log(`Listening on port ${port}`);
