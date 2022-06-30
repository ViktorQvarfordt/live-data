import http2 from "node:http2";
import fs from "node:fs";
import * as db from "./db";
import { Replicator } from "./replicator";
import { Json, PresenceDelete, PresenceUpdates, PresenceUpsert } from "./types";
import { z } from "zod";
import { mkApp } from "./web";
import { initRedis, redisClient } from "./redis";

const state = { isShutdown: false }

async function shutdown(): Promise<void> {
  if (state.isShutdown) {
    console.log('Please wait until graceful shutdown is complete')
    return
  }
  state.isShutdown = true
  try {
    // TODO: Iterate over all open presence streams and delete the corresponding data from redis
    process.exit(0)
  } catch (e) {
    console.error('Failed to shutdown server gracefully', e)
    process.exit(1)
  }
}

process.on('SIGTERM', () => {
  console.log('SIGTERM received, entering shutdown')
  void shutdown()
})

process.on('SIGINT', () => {
  console.log('SIGINT received, entering shutdown')
  void shutdown()
})

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
  chatSequenceId: z.number(),
  messageSequenceId: z.number(),
  createdAt: z.string(),
});

const RowSpec = z.object({
  entityType: z.string(),
  entityCollectionId: z.string(),
  entityId: z.string(),
  data: z.object({
    text: z.string(),
  }),
});

const ChatRow = z.object({
  messageId: z.string(),
  chatId: z.string(),
  chatSequenceId: z.number(),
  messageSequenceId: z.number(),
  createdAt: z.string(),
  isDeleted: z.boolean().optional(),
  text: z.string().optional(),
});

type T = z.infer<typeof ChatRow>;

const ChatUpsert = ChatRow.pick({
  messageId: true,
  chatId: true,
  text: true,
  isDeleted: true,
});

const ChatDelete = ChatRow.pick({ messageId: true, chatId: true });

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
        ChatRow,
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
    "^/chat/(?<chatId>.+?)/get$",
    async ({ stream, params }) => {
      // SELECT DISTINCT ON is not very fast by default, it can be optimized:
      // https://wiki.postgresql.org/wiki/Loose_indexscan
      // https://www.timescale.com/blog/how-we-made-distinct-queries-up-to-8000x-faster-on-postgresql/
      const entities = await db.getAll(
        ChatRow,
        db.sql`
          WITH entities AS (
            SELECT DISTINCT ON (message_id) *
            FROM chat_messages WHERE
            chat_id = ${params.chatId}
            ORDER BY message_id, message_sequence_id DESC
          )
          SELECT * FROM entities
          WHERE is_deleted IS NOT TRUE
          ORDER BY created_at DESC
          LIMIT 10
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

      const handler = () => replicator.unsubscribe(params.channelName, stream);

      stream.on("close", handler);
      stream.on("error", handler);
      stream.on("end", handler);
      stream.on("aborted", handler);
      stream.on("finish", handler);
      stream.on("drain", handler);
      stream.on("unpipe", handler);
    }
  );

  app.handleWithData(
    "post",
    "^/chat/upsert$",
    ChatUpsert,
    async ({ stream, data }) => {
      const result = await db.getExactlyOne(
        InsertResult,
        db.sql`
          INSERT INTO chat_messages (message_id, chat_id, created_at, chat_sequence_id, message_sequence_id, text, is_deleted) VALUES (
            ${data.messageId},
            ${data.chatId},
            CURRENT_TIMESTAMP,
            (SELECT COALESCE(MAX(chat_sequence_id) + 1, 0) FROM chat_messages WHERE chat_id = ${data.chatId}),
            0,
            ${data.text},
            ${data.isDeleted}
          )
          ON CONFLICT (message_id) DO UPDATE SET
            message_sequence_id = chat_messages.message_sequence_id + 1,
            text = ${data.text},
            is_deleted = ${data.isDeleted}
          RETURNING chat_sequence_id, message_sequence_id, created_at
        `

        // db.sql`
        //   INSERT INTO chat_messages (message_id, chat_id, created_at, chat_sequence_id, message_sequence_id, text, is_deleted) VALUES (
        //     ${data.messageId},
        //     ${data.chatId},
        //     COALESCE(created_at, CURRENT_TIMESTAMP),
        //     (SELECT COALESCE(MAX(chat_sequence_id) + 1, 0) FROM chat_messages WHERE chat_id = ${data.chatId}),
        //     (SELECT COALESCE(MAX(message_sequence_id) + 1, 0) FROM chat_messages WHERE message_id = ${data.messageId}),
        //     ${data.text},
        //     ${data.isDeleted}
        //   )
        //   RETURNING chat_sequence_id, message_sequence_id
        // `
      );

      const augmentedData = ChatRow.parse({ ...result, ...data });

      await replicator.publish(data.chatId, JSON.stringify([augmentedData]));

      stream.respond(corsHeaders);
      stream.end("ok");
    }
  );

  // PRESENCE

  app.handle(
    "get",
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

  app.handle(
    "get",
    "^/presence/(?<channelName>.+)/sub/(?<clientId>.+)$",
    async ({ stream, params }) => {
      const ch = `presence:${params.channelName}`;

      await replicator.subscribe(ch, stream);

      stream.respond({
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });

      stream.on("close", async () => {
        replicator.unsubscribe(ch, stream);
        redisClient.HDEL(ch, params.clientId);
        const update: PresenceDelete = {
          type: "delete",
          clientId: params.clientId,
        };
        replicator.publish(ch, JSON.stringify([update]));
      });
    }
  );

  app.handleWithData(
    "post",
    "^/presence/(?<channelName>.+)/pub$",
    PresenceUpsert,
    async ({ stream, params, data }) => {
      const ch = `presence:${params.channelName}`;

      await redisClient.HSET(ch, data.clientId, JSON.stringify(data.data));
      await replicator.publish(ch, JSON.stringify([data]));

      stream.respond(corsHeaders);
      stream.end("ok");
    }
  );

  app.handle("get", "^/stats$", ({ stream }) => {
    stream.respond({ ...corsHeaders, "content-type": "application/type" });

    const result: Record<string, number> = {};
    for (const [key, val] of replicator.activeChannels.entries()) {
      result[key] = val.size;
    }

    stream.end(JSON.stringify(result));
  });

  const port = process.env.PORT ? parseInt(process.env.PORT) : 8000;
  server.listen(port);
  console.log(`Listening on port ${port}`);
}

main();
