import http2 from "node:http2";
import fs from "node:fs";
import * as db from "@workspace/server-common/db";
import { z } from "zod";
import {
  HttpMethod,
  createApp,
} from "@workspace/server-common/typed-http2-handler";
import { config } from "./config.js";

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

const InsertResult = z.object({
  chatSequenceId: z.number(),
  messageSequenceId: z.number(),
  createdAt: z.string(),
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

const ChatUpsert = ChatRow.pick({
  chatId: true,
  messageId: true,
  text: true,
  isDeleted: true,
})

// app.handle(
//   "GET",
//   "^/entity/(?<entityCollectionId>.+?)/get$",
//   async ({ stream, params }) => {
//     // SELECT DISTINCT ON is not very fast by default, it can be optimized:
//     // https://wiki.postgresql.org/wiki/Loose_indexscan
//     // https://www.timescale.com/blog/how-we-made-distinct-queries-up-to-8000x-faster-on-postgresql/
//     const entities = await getAll(
//       ChatRow,
//       sql`
//         WITH entities AS (
//           SELECT DISTINCT ON (entity_id) *
//           FROM event_log WHERE
//           entity_collection_id = ${params.entityCollectionId} -- eg chat:123
//           ORDER BY entity_id, sequence_id DESC;
//         )
//         SELECT * FROM entities
//         WHERE is_deleted IS NOT TRUE
//         ORDER BY created_at DESC
//         LIMIT 10
//       `
//     );

//     stream.respond({ ...corsHeaders, "content-type": "application/json" });
//     stream.end(JSON.stringify(entities));
//   }
// );

const makeHttp2Request = (
  host: string,
  path: string,
  method: HttpMethod,
  body: string
): Promise<string> =>
  new Promise((resolve, reject) => {
    const client = http2.connect(host);

    client.on("error", (err) => reject(err));

    const req = client.request({ ":path": path, ":method": method });

    req.write(body);

    // req.on('response', (headers, flags) => {})

    req.setEncoding("utf8");
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      resolve(data);
      client.close();
    });
    req.end();
  });

app.handle({
  method: "GET",
  pathRegExp: "^/chat/(?<chatId>.+?)/get$",
  handler: async ({ stream, params }) => {
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
  },
});

app.handle({
  method: "POST",
  pathRegExp: "^/chat/upsert$",
  bodySchema: ChatUpsert,
  handler: async ({ stream, bodyData }) => {
    const result = await db.getExactlyOne(
      InsertResult,
      db.sql`
        INSERT INTO chat_messages (message_id, chat_id, created_at, chat_sequence_id, message_sequence_id, text, is_deleted) VALUES (
          ${bodyData.messageId},
          ${bodyData.chatId},
          CURRENT_TIMESTAMP,
          (SELECT COALESCE(MAX(chat_sequence_id) + 1, 0) FROM chat_messages WHERE chat_id = ${bodyData.chatId}),
          0,
          ${bodyData.text},
          ${bodyData.isDeleted}
        )
        ON CONFLICT (message_id) DO UPDATE SET
          message_sequence_id = chat_messages.message_sequence_id + 1,
          text = ${bodyData.text},
          is_deleted = ${bodyData.isDeleted}
        RETURNING chat_sequence_id, message_sequence_id, created_at
      `

      // sql`
      //   INSERT INTO chat_messages (message_id, chat_id, created_at, chat_sequence_id, message_sequence_id, text, is_deleted) VALUES (
      //     ${bodyData.messageId},
      //     ${bodyData.chatId},
      //     COALESCE(created_at, CURRENT_TIMESTAMP),
      //     (SELECT COALESCE(MAX(chat_sequence_id) + 1, 0) FROM chat_messages WHERE chat_id = ${bodyData.chatId}),
      //     (SELECT COALESCE(MAX(message_sequence_id) + 1, 0) FROM chat_messages WHERE message_id = ${bodyData.messageId}),
      //     ${bodyData.text},
      //     ${bodyData.isDeleted}
      //   )
      //   RETURNING chat_sequence_id, message_sequence_id
      // `
    );

    const augmentedData = ChatRow.parse({ ...result, ...bodyData });

    await makeHttp2Request(
      config.ssePubSubHost,
      `/channel/pub`,
      "POST",
      JSON.stringify({
        channelId: bodyData.chatId,
        clientId: null,
        messages: [augmentedData],
      })
    );

    stream.respond(corsHeaders);
    stream.end();
  },
});

const port = process.env.PORT ? parseInt(process.env.PORT) : 8000;
server.listen(port);
console.log(`Listening on port ${port}`);
