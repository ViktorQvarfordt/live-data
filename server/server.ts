import http2 from "node:http2";
import fs from "node:fs";
import * as db from "./db";
import { Replicator } from "./replicator";
import { Json, PresenceDelete, PresenceUpdates, PresenceUpsert } from "./types";
import { z } from "zod";
import { mkApp } from "./web";
import { initRedis, redisClient } from "./redis";

const options = {
  key: fs.readFileSync("./key.pem"),
  cert: fs.readFileSync("./cert.pem"),
};

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "*",
};

const server = http2.createSecureServer(options);

server.on("error", (err) => console.error(err));

const app = mkApp(server);

app.handle("options", "^.*$", ({ stream }) => {
  stream.respond({ ...corsHeaders, ":status": 204 });
});

const InsertResult = z.object({
  serialId: z.string(), // pg represents bigint as string since javascript numbers cannot represent all bigints
  timestamp: z.string(),
});

const RowSpec = z.object({
  entityType: z.string(),
  entityId: z.string(),
  data: Json,
});

const Row = z.intersection(InsertResult, RowSpec);

const channelNameToEntityTypes: Record<string, string[]> = {
  chan1: ["chatMessage"],
};

async function main() {
  const replicator = new Replicator();

  await replicator.init();

  await initRedis();

  app.handle(
    "get",
    "^/channel/(?<channelName>.+?)/get$",
    async ({ stream, params }) => {
      const entityTypes = channelNameToEntityTypes[params.channelName];
      if (!entityTypes) throw new Error("IllegalStateException");

      // SELECT DISTINCT ON is not very fast by default, it can be optimized:
      // https://wiki.postgresql.org/wiki/Loose_indexscan
      // https://www.timescale.com/blog/how-we-made-distinct-queries-up-to-8000x-faster-on-postgresql/
      const entities = await db.getAll(
        Row,
        db.sql`
        SELECT DISTINCT ON (entity_id) *
        FROM event_log WHERE
        entity_type = ANY (${entityTypes})
        ORDER BY entity_id, serial_id DESC;
      `
      );

      stream.respond({ ...corsHeaders, "content-type": "application/json" });
      stream.end(JSON.stringify(entities));
    }
  );

  app.handle(
    "get",
    "^/channel/(?<channelName>.+?)/sub$",
    async ({ stream, params }) => {
      await replicator.subscribe(params.channelName, stream);

      stream.respond({
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });

      stream.on("close", () =>
        replicator.unsubscribe(params.channelName, stream)
      );
    }
  );

  app.handleWithData(
    "post",
    "^/channel/(?<channelName>.+?)/pub$",
    RowSpec,
    async ({ stream, params, data }) => {
      const result = await db.getExactlyOne(
        InsertResult,
        db.sql`
          INSERT INTO event_log (entity_type, entity_id, data) VALUES (
            ${data.entityType},
            ${data.entityId},
            ${data.data}
          )
          RETURNING serial_id, timestamp
        `
      );

      const augmentedData = { ...result, ...data };

      await replicator.publish(
        params.channelName,
        JSON.stringify([augmentedData])
      );

      stream.respond(corsHeaders);
      stream.end("ok");
    }
  );

  // PRESENCE

  app.handle(
    "get",
    "^/presence/(?<channelName>.+?)/get$",
    async ({ stream, params }) => {
      const obj = await redisClient.HGETALL(`presence/${params.channelName}`);
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

  app.handle(
    "get",
    "^/presence/(?<channelName>.+)/sub/(?<clientId>.+)$",
    async ({ stream, params }) => {
      const ch = `presence/${params.channelName}`;
      
      await replicator.subscribe(ch, stream);

      stream.respond({
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });

      stream.on("close", async () => {
        replicator.unsubscribe(ch, stream)
        redisClient.HDEL(ch, params.clientId);
        const update: PresenceDelete = { type: 'delete', clientId: params.clientId }
        replicator.publish(ch, JSON.stringify([update]))
      });
    }
  );

  app.handleWithData(
    "post",
    "^/presence/(?<channelName>.+)/pub$",
    PresenceUpsert,
    async ({ stream, params, data }) => {
      const ch = `presence/${params.channelName}`;

      await redisClient.HSET(ch, data.clientId, JSON.stringify(data.data));
      await replicator.publish(ch, JSON.stringify([data]));

      stream.respond(corsHeaders);
      stream.end("ok");
    }
  );

  const port = process.env.PORT ? parseInt(process.env.PORT) : 8000;
  server.listen(port);
  console.log(`Listening on port ${port}`);
}

main();
