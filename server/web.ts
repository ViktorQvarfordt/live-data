import http2 from "node:http2";
import { Json } from "./types";
import { RegExCaptureResult, TypedRegEx } from "typed-regex";
import { z } from "zod";
import { corsHeaders } from "./server";

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

export const mkApp = (server: http2.Http2SecureServer) => {
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
