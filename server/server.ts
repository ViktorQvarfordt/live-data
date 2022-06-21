import http2 from "node:http2";
import fs from "node:fs";
import * as db from "./db";
import { Replicator } from "./replicator";
import { Json } from "./types";
import { RegExCaptureResult, TypedRegEx } from "typed-regex";
import { z } from "zod";

const options = {
  key: fs.readFileSync("./key.pem"),
  cert: fs.readFileSync("./cert.pem"),
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "*",
};

const server = http2.createSecureServer(options);

server.on("error", (err) => console.error(err));

type Method = string;

type Handler<Re extends string> = ({
  stream,
  params,
}: {
  stream: http2.ServerHttp2Stream;
  params: RegExCaptureResult<Re>;
}) => void | Promise<void>;

type HandlerWithData<Re extends string, T extends Json> = ({
  stream,
  params,
  data,
}: {
  stream: http2.ServerHttp2Stream;
  params: RegExCaptureResult<Re>;
  data: T;
}) => void | Promise<void>;

type HandlerSpec<Re extends string, T extends Json> = {
  pathRegExp: Re;
  method: Method;
} & (
  | { withData: false; handler: Handler<Re> }
  | { withData: true; handler: HandlerWithData<Re, T>; schema: z.Schema<T> }
);

const mkApp = (server: http2.Http2SecureServer) => {
  const handlerSpecs: HandlerSpec<any, any>[] = [];

  const handle = <Re extends string>(
    method: Method,
    pathRegExp: Re,
    handler: Handler<Re>
  ): void => {
    handlerSpecs.push({
      method: method.toUpperCase(),
      pathRegExp,
      handler,
      withData: false,
    });
  };

  const handleWithData = <Re extends string, T extends Json>(
    method: Method,
    pathRegExp: Re,
    schema: z.Schema<T>,
    handler: HandlerWithData<Re, T>
  ): void => {
    handlerSpecs.push({
      method: method.toUpperCase(),
      pathRegExp,
      handler,
      withData: true,
      schema,
    });
  };

  server.on("stream", async (stream, headers) => {
    try {
      const path = headers[":path"];
      const method = headers[":method"]?.toUpperCase();

      console.log("stream", method, path);

      if (!path || !method) return;

      let spec: HandlerSpec<any, any> | undefined = undefined;
      let params: RegExCaptureResult<any> = {};

      for (const _spec of handlerSpecs) {
        if (_spec.method !== method) continue;

        const typedRegEx = TypedRegEx(_spec.pathRegExp);
        if (typedRegEx.isMatch(path)) {
          params = typedRegEx.captures(path);
          spec = _spec;
          break;
        }
      }

      if (!spec) {
        stream.respond({
          ...corsHeaders,
          ":status": 404,
        });
        return;
      }

      if (!spec.withData) {
        await spec.handler({ stream, params });
      } else {
        let rawData: string | undefined = undefined;

        stream.setEncoding("utf8");

        stream.on("data", (chunk) => {
          if (rawData === undefined) {
            rawData = "";
          }
          rawData += chunk;
        });

        stream.on("end", async () => {
          if (!spec?.withData) throw new Error("IllegalStateException");

          let data;

          try {
            data = spec.schema.parse(JSON.parse(rawData ?? ""));
          } catch (err) {
            const msg =
              "400 Bad Request - The sent data could not be parsed according to the schema.";
            console.warn(msg, err);
            stream.respond({
              ...corsHeaders,
              ":status": 400,
            });
            stream.end(msg);
            return;
          }

          if (!data) throw new Error("IllegalStateException");

          try {
            await spec.handler({ stream, params, data });
          } catch (err) {
            const msg = "500 Internal Server Error";
            console.error(msg, err);
            stream.respond({
              ...corsHeaders,
              ":status": 500,
            });
            stream.end(msg);
            return;
          }
        });
      }
    } catch (err) {
      const msg = "500 Internal Server Error";
      console.error(msg, err);
      stream.respond({
        ...corsHeaders,
        ":status": 500,
      });
      stream.end(msg);
      return;
    }
  });

  return { handle, handleWithData };
};

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
  data: z.any(),
});

const Row = z.intersection(InsertResult, RowSpec);

const channelNameToEntityTypes: Record<string, string[]> = {
  chan1: ["chatMessage"],
};

async function main() {
  const replicator = new Replicator();

  await replicator.init();

  app.handle(
    "get",
    "^/subscribe/(?<channelName>.+)$",
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

  app.handle(
    "get",
    "^/load/(?<channelName>.+)$",
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

  app.handleWithData(
    "post",
    "^/publish/(?<channelName>.+)$",
    RowSpec,
    async ({ stream, params, data }) => {
      if (data === undefined) throw new Error("invalid state");

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

  const port = process.env.PORT ? parseInt(process.env.PORT) : 8000;
  server.listen(port);
  console.log(`Listening on port ${port}`);
}

main();
