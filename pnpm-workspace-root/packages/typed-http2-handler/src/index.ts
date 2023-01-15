import type http2 from "node:http2";
import type { Json } from "@workspace/common/types";
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

type Handler<Re extends string, QueryData extends Json | undefined = undefined> = ({
  stream,
  params,
  queryData,
}: {
  stream: http2.ServerHttp2Stream;
  params: RegExCaptureResult<Re>;
  queryData: QueryData;
}) => void | Promise<void>;

// TODO
// type HandlerWithQueryData<Re extends string, QueryData extends> = ({
//   stream,
//   params,
//   queryData,
// }: {
//   stream: http2.ServerHttp2Stream;
//   params: RegExCaptureResult<Re>;
//   queryData: QueryData;
// }) => void | Promise<void>;

type HandlerWithData<
  Re extends string,
  BodyData extends Json,
  QueryData extends Json | undefined = undefined,
> = ({
  stream,
  params,
  queryData,
  bodyData,
}: {
  stream: http2.ServerHttp2Stream;
  params: RegExCaptureResult<Re>;
  queryData: QueryData;
  bodyData: BodyData;
}) => void | Promise<void>;

type HandlerSpec<
  Re extends string,
  BodyData extends Json,
  QueryData extends Json | undefined = undefined,
> = {
  pathRegExp: Re;
  method: Method;
} & (
  | {
      withData: false;
      handler: Handler<Re, QueryData>;
      querySchema?: z.Schema<QueryData> | undefined;
    }
  | {
      withData: true;
      handler: HandlerWithData<Re, BodyData, QueryData>;
      querySchema?: z.Schema<QueryData> | undefined;
      bodySchema: z.Schema<BodyData>;
    }
);

export const mkApp = (server: http2.Http2SecureServer) => {
  const handlerSpecs: HandlerSpec<any, any, any>[] = []; // TODO Make these types more strict

  const handle = <Re extends string, QueryData extends Json | undefined = undefined>({
    method,
    pathRegExp,
    querySchema,
    handler,
  }: {
    method: Method;
    pathRegExp: Re;
    querySchema?: z.Schema<QueryData>;
    handler: Handler<Re, QueryData>;
  }): void => {
    // @ts-ignore
    handlerSpecs.push({
      method: method,
      pathRegExp,
      querySchema,
      withData: false,
      handler,
    });
  };

  const handleWithData = <
    Re extends string,
    BodyData extends Json,
    QueryData extends Json | undefined = undefined,
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
    bodySchema: z.Schema<BodyData>;
    handler: HandlerWithData<Re, BodyData, QueryData>;
  }): void => {
    handlerSpecs.push({
      method,
      pathRegExp,
      withData: true,
      querySchema,
      bodySchema,
      handler,
    });
  };

  server.on("stream", async (stream, headers) => {
    console.log("handling");
    try {
      const path = headers[":path"];
      const method = headers[":method"];

      console.log("stream", method, path);

      if (!path || !method) return;

      let spec: HandlerSpec<any, any, any> | undefined = undefined; // TODO Make these types more strict
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
        console.log("404");
        stream.respond({
          ...corsHeaders,
          ":status": 404,
        });
        stream.close();
        return;
      }

      // let rawQueryData = ''
      let queryData: Json = {};
      console.log("PATH", path);

      if (!spec.withData) {
        // @ts-ignore
        await spec.handler({ stream, params, queryData });
      } else {
        let rawBodyData: string | undefined = undefined;

        stream.setEncoding("utf8");

        stream.on("data", (chunk) => {
          if (rawBodyData === undefined) {
            rawBodyData = "";
          }
          rawBodyData += chunk;
        });

        stream.on("end", async () => {
          if (!spec?.withData) throw new Error("IllegalStateException");

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

          if (!bodyData) throw new Error("IllegalStateException");

          try {
            await spec.handler({ stream, params, queryData, bodyData });
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
