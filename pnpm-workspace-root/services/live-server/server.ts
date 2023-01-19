import {
  PresenceDelete,
  PresenceHeartbeat,
  PresenceUpdates,
  PresenceUpsert,
  PubMsgs,
} from "@workspace/common/types";
import { mkApp } from "@workspace/typed-http2-handler";
import fs from "node:fs";
import {z} from "zod";
import http2 from "node:http2";
import { initRedis, redisClient } from "./redis.js";
import { SsePubSub } from "./sse-pub-sub.js";

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
  key: fs.readFileSync("../../certs/localhost.direct.key"),
  cert: fs.readFileSync("../../certs/localhost.direct.crt"),
};

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "*",
};

const server = http2.createSecureServer(options);

server.on("error", (err) => console.error(err));

const app = mkApp(server);

app.handle({
  method: "OPTIONS",
  pathRegExp: "^.*$",
  handler: ({ stream }) => {
    stream.respond({ ...corsHeaders, ":status": 204 });
  },
});

const ssePubSub = new SsePubSub();
await ssePubSub.init();

await initRedis();

// Channel

app.handle({
  method: "POST",
  pathRegExp: "^/channel/(?<channelName>.+?)/pub$",
  bodySchema: PubMsgs,
  handler: async ({ stream, params, bodyData }) => {
    await ssePubSub.publish(params.channelName, JSON.stringify(bodyData));
    stream.respond(corsHeaders);
    stream.end();
  }
});

app.handle({
  method: "GET",
  pathRegExp: "^/channel/(?<channelName>.+?)/sub$",
  handler: async ({ stream, params }) => {
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
});

// Presence

app.handle({
  method: "GET",
  pathRegExp: "^/presence/get$",
  querySchema: z.object({channelId: z.string(), clientId: z.string()}),
  handler: async ({ stream, queryData }) => {
    const ch = `presence:${queryData.channelId}`;
    const obj = await redisClient.HGETALL(ch);
    const updates: PresenceUpdates = Object.entries(obj).map(
      ([clientId, str]) => ({
        type: "upsert",
        channelId: queryData.channelId,
        clientId,
        data: JSON.parse(str),
      })
    );
    stream.respond({ ...corsHeaders, "content-type": "application/json" });
    stream.end(JSON.stringify(updates));
  }
});

// app.handleWithData(
//   "POST",
//   "^/presence/heartbeat$",
//   PresenceHeartbeat,
//   async ({ stream, data }) => {
//     const ch = `presence:${data.channelId}`;

//     await redisClient
//       .MULTI()
//       .HSET(ch, data.clientId, JSON.stringify(data.data))
//       .EXPIRE(ch, 5)
//       .EXEC();

//     await ssePubSub.publish(ch, JSON.stringify([data]));

//     stream.respond(corsHeaders);
//     stream.end();
//   }
// );

app.handle({
  method: "POST",
  pathRegExp: "^/presence/pub$",
  bodySchema: PresenceUpsert,
  handler: async ({ stream, bodyData }) => {
    const ch = `presence:${bodyData.channelId}`;

    await redisClient
      .MULTI()
      .HSET(ch, bodyData.clientId, JSON.stringify(bodyData.data))
      .EXPIRE(ch, 5)
      .EXEC();

    await ssePubSub.publish(ch, JSON.stringify([bodyData]));

    stream.respond(corsHeaders);
    stream.end();
  }
});

app.handle({
  method: "GET",
  pathRegExp: "^/presence/sub\?",
  querySchema: z.object({channelId: z.string(), clientId: z.string()}),
  handler: async ({ stream, queryData }) => {
    const ch = `presence:${queryData.channelId}`;

    await ssePubSub.subscribe(ch, stream);

    stream.respond({
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });

    stream.on("close", async () => {
      ssePubSub.unsubscribe(ch, stream);
      redisClient.HDEL(ch, queryData.clientId);
      const update: PresenceDelete = {
        type: "delete",
        channelId: queryData.channelId,
        clientId: queryData.clientId,
      };
      ssePubSub.publish(ch, JSON.stringify([update]));
    });
  },
});

// Stats

app.handle({
  method: "GET",
  pathRegExp: "^/stats$",
  handler: ({ stream }) => {
    stream.respond({ ...corsHeaders, "content-type": "application/type" });

    const result: Record<string, number> = {};
    for (const [key, val] of ssePubSub.activeChannels.entries()) {
      result[key] = val.size;
    }

    stream.end(JSON.stringify(result));
  },
});

const port = process.env.PORT ? parseInt(process.env.PORT) : 8001;
server.listen(port);
console.log(`Listening on port ${port}`);
