import type http2 from "node:http2";
import qs from "node:querystring";
import url from "node:url";
import { Json } from "@workspace/common/types";
import { RegExCaptureResult, TypedRegEx } from "typed-regex";
import type { z } from "zod";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "*",
};

export type Method =
  | "GET"
  | "HEAD"
  | "POST"
  | "PUT"
  | "DELETE"
  | "CONNECT"
  | "OPTIONS"
  | "TRACE"
  | "PATCH";

type Handler<Re extends string> = ({
  stream,
  params,
}: {
  stream: http2.ServerHttp2Stream;
  params: RegExCaptureResult<Re>;
}) => void | Promise<void>;

type HandlerWithQueryData<Re extends string, QueryData extends Json> = ({
  stream,
  params,
  queryData,
}: {
  stream: http2.ServerHttp2Stream;
  params: RegExCaptureResult<Re>;
  queryData: QueryData;
}) => void | Promise<void>;

type HandlerWithBodyData<Re extends string, BodyData extends Json> = ({
  stream,
  params,
  bodyData,
}: {
  stream: http2.ServerHttp2Stream;
  params: RegExCaptureResult<Re>;
  bodyData: BodyData;
}) => void | Promise<void>;

type HandlerSpec<
  Re extends string,
  BodyData extends Json,
  QueryData extends Json
> = {
  method: Method;
  pathRegExp: Re;
} & (
  | {
      type: "plain";
      handler: Handler<Re>;
    }
  | {
      type: "with-query";
      querySchema: z.Schema<QueryData>;
      handler: HandlerWithQueryData<Re, QueryData>;
    }
  | {
      type: "with-body";
      bodySchema: z.Schema<BodyData>;
      handler: HandlerWithBodyData<Re, BodyData>;
    }
);

export const mkApp = (server: http2.Http2SecureServer) => {
  const handlerSpecs: HandlerSpec<string, Json, Json>[] = [];

  // with-query
  function registerHandler<Re extends string, QueryData extends Json>(_: {
    method: Method;
    pathRegExp: Re;
    querySchema: z.Schema<QueryData>;
    handler: HandlerWithQueryData<Re, QueryData>;
  }): void;
  // with-data
  function registerHandler<Re extends string, BodyData extends Json>(_: {
    method: Method;
    pathRegExp: Re;
    bodySchema: z.Schema<BodyData>;
    handler: HandlerWithBodyData<Re, BodyData>;
  }): void;
  // plain
  function registerHandler<Re extends string, QueryData extends Json>(_: {
    method: Method;
    pathRegExp: Re;
    handler: Handler<Re>;
  }): void;
  // actual implementation
  function registerHandler<
    Re extends string,
    QueryData extends Json,
    BodyData extends Json
  >({
    method,
    pathRegExp,
    querySchema,
    bodySchema,
    handler,
  }: {
    method: Method;
    pathRegExp: Re;
    querySchema?: z.Schema<QueryData>;
    bodySchema?: z.Schema<BodyData>;
    handler: any;
  }): void {
    if (querySchema === undefined && bodySchema === undefined) {
      handlerSpecs.push({
        type: "plain",
        method,
        pathRegExp,
        handler,
      });
    } else if (querySchema !== undefined && bodySchema === undefined) {
      handlerSpecs.push({
        type: "with-query",
        method,
        pathRegExp,
        querySchema,
        handler,
      });
    } else if (querySchema === undefined && bodySchema !== undefined) {
      handlerSpecs.push({
        type: "with-body",
        method,
        pathRegExp,
        bodySchema,
        handler,
      });
    } else {
      throw new Error("IllegalStateException1");
    }
  }

  server.on("stream", async (stream, headers) => {
    console.log("handling");
    try {
      const path = headers[":path"];
      const method = headers[":method"];

      console.log("stream", method, path);

      if (!path || !method) return;

      let spec: HandlerSpec<string, Json, Json> | undefined = undefined;
      let params: RegExCaptureResult<string> = {};

      for (const _spec of handlerSpecs) {
        if (_spec.method !== method) continue;

        const typedRegEx = TypedRegEx(_spec.pathRegExp);
        if (typedRegEx.isMatch(path)) {
          const _params = typedRegEx.captures(path);
          if (_params) {
            params = _params;
          }
          spec = _spec;
          break;
        }
      }

      if (!spec) {
        console.log("404", path);
        stream.respond({
          ...corsHeaders,
          ":status": 404,
        });
        stream.close();
        return;
      }

      if (spec.type === "plain") {
        await spec.handler({ stream, params });
      } else if (spec.type === "with-query") {
        const query = url.parse(path).query;
        if (!query) throw new Error("Expected query to be defined"); // TODO Should be 400
        let queryData = Json.parse(qs.parse(query));
        await spec.handler({ stream, params, queryData });
      } else if (spec.type === "with-body") {
        let rawBodyData: string = "";

        stream.setEncoding("utf8");

        stream.on("data", (chunk) => {
          rawBodyData += chunk;
        });

        stream.on("end", async () => {
          // This line helps typescript but should ideally not be necessary
          if (spec?.type !== "with-body")
            throw new Error("IllegalStateException3");

          let bodyData: Json;

          try {
            bodyData = spec.bodySchema.parse(JSON.parse(rawBodyData ?? ""));
          } catch (err) {
            const msg =
              "400 Bad Request - The sent data could not be parsed according to the schema.";
            console.warn(msg, err, rawBodyData);
            stream.respond({
              ...corsHeaders,
              ":status": 400,
            });
            stream.end(msg);
            return;
          }

          if (!bodyData) throw new Error("IllegalStateException4");

          try {
            await spec.handler({ stream, params, bodyData });
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

  return { handle: registerHandler };
};
