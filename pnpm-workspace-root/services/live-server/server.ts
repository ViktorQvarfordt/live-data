import {
  Json,
  PresenceDelete,
  PresenceHeartbeat,
  PresenceUpsert,
  PubMsg
} from "@workspace/common/types";
import { groupBy } from "@workspace/common/utils";
import * as db from "@workspace/server-common/db";
import { createApp } from "@workspace/server-common/typed-http2-handler";
import fs from "node:fs";
import http2 from "node:http2";
import { z } from "zod";
import { initRedis } from "./redis.js";
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

const app = createApp(server);

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

const ChannelClient = z.object({ channelId: z.string(), clientId: z.string() });

app.handle({
  method: "POST",
  pathRegExp: "^/channel/pub$",
  bodySchema: PubMsg,
  handler: async ({ stream, bodyData }) => {
    await ssePubSub.publish(`channel:${bodyData.channelId}`, {
      clientId: bodyData.clientId,
      domainMessages: bodyData.messages,
    });
    stream.respond(corsHeaders);
    stream.end();
  },
});

app.handle({
  method: "GET",
  pathRegExp: "^/channel/sub$",
  querySchema: ChannelClient,
  handler: async ({ stream, queryData: { channelId, clientId } }) => {
    console.log({clientId})
    const channel = `channel:${channelId}` as const;

    await ssePubSub.subscribe({ channel, clientId, stream });

    stream.respond({
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });

    const handler = () => ssePubSub.unsubscribe({ channel, clientId });

    stream.on("close", handler);
    stream.on("error", handler);
    stream.on("end", handler);
    stream.on("aborted", handler);
    stream.on("finish", handler);
    stream.on("drain", handler);
    stream.on("unpipe", handler);
  },
});

// Presence

app.handle({
  method: "GET",
  pathRegExp: "^/presence/get$",
  querySchema: z.object({ channelId: z.string() }),
  handler: async ({ stream, queryData }) => {
    const states = await db.getAll(
      z.object({
        channelId: z.string(),
        clientId: z.string(),
        createdAt: z.string(),
        updatedAt: z.string(),
        data: Json.default(null),
      }),
      db.sql`
        select * from presence where channel_id = ${queryData.channelId}
      `
    );

    const updates: PresenceUpsert[] = states.map((state) => ({
      type: "upsert",
      channelId: queryData.channelId,
      clientId: state.clientId,
      data: state.data,
      // TODO include timestamps
    }));
    stream.respond({ ...corsHeaders, "content-type": "application/json" });
    stream.end(JSON.stringify(updates));
  },
});

// TODO This can use a shared queue instead. It would be nice to explore that even though this ticker is fine.
setInterval(async () => {
  db.transaction(async () => {
    const updates = await db.getAll(
      PresenceDelete,
      db.sql`
        delete from presence where updated_at < now() - interval '10 seconds'
        returning channel_id, client_id, 'delete' as type
      `
    );

    const updatesByChannel = groupBy(updates, "channelId");

    for (const [channelId, updates] of Object.entries(updatesByChannel)) {
      ssePubSub.publish(`presence:${channelId}`, {
        clientId: null,
        domainMessages: updates,
      });
    }
  });
}, 1000);

app.handle({
  method: "POST",
  pathRegExp: "^/presence/pub$",
  bodySchema: PresenceUpsert,
  handler: async ({ stream, bodyData: update }) => {
    const dataString = JSON.stringify(update.data);

    await db.query(
      db.sql`
        insert into presence (channel_id, client_id, created_at, updated_at, data) values
        (${update.channelId}, ${update.clientId}, now(), now(), ${dataString})
        on conflict (channel_id, client_id) do update
        set updated_at = now(), data = ${dataString}
      `
    );

    await ssePubSub.publish(`presence:${update.channelId}`, {
      clientId: update.clientId,
      domainMessages: [update],
    });

    stream.respond(corsHeaders);
    stream.end();
  },
});

app.handle({
  method: "POST",
  pathRegExp: "^/presence/heartbeat$",
  bodySchema: PresenceHeartbeat,
  handler: async ({ stream, bodyData: update }) => {
    await db.query(
      db.sql`
        insert into presence (channel_id, client_id, created_at, updated_at) values
        (${update.channelId}, ${update.clientId}, now(), now())
        on conflict (channel_id, client_id) do update
        set updated_at = now()
      `
    );

    stream.respond(corsHeaders);
    stream.end();
  },
});

app.handle({
  method: "GET",
  pathRegExp: "^/presence/sub$",
  querySchema: ChannelClient,
  handler: async ({ stream, queryData: { channelId, clientId } }) => {
    const channel = `presence:${channelId}` as const;

    await ssePubSub.subscribe({ channel, clientId, stream });

    stream.respond({
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });

    stream.on("close", async () => {
      ssePubSub.unsubscribe({ channel, clientId });

      await db.query(db.sql`
        delete from presence where
        channel_id = ${channelId} and client_id = ${clientId}
      `);

      const update: PresenceDelete = {
        type: "delete",
        channelId,
        clientId,
      };
      ssePubSub.publish(channel, {
        clientId: update.clientId,
        domainMessages: [update],
      });
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
    for (const [key, val] of ssePubSub.activeChannelStreams.entries()) {
      result[key] = val.size;
    }

    stream.end(JSON.stringify(result));
  },
});

const port = process.env.PORT ? parseInt(process.env.PORT) : 8001;
server.listen(port);
console.log(`Listening on port ${port}`);
