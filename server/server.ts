import http2 from "node:http2";
import fs from "node:fs";
import { createClient } from "redis";

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

type ChannelName = string;

const activeStreams = new Map<ChannelName, Set<http2.ServerHttp2Stream>>();

type Method = string;
type Handler = (
  stream: http2.ServerHttp2Stream,
  m: RegExpExecArray,
  data?: string
) => void;

const mkApp = (server: http2.Http2SecureServer) => {
  const handlerSpecs: {
    pathRegExp: RegExp;
    method: Method;
    handler: Handler;
  }[] = [];

  const handle = (
    method: Method,
    pathRegExp: RegExp,
    handler: Handler
  ): void => {
    handlerSpecs.push({ method: method.toUpperCase(), pathRegExp, handler });
  };

  server.on("stream", (stream, headers) => {
    const path = headers[":path"];
    const method = headers[":method"]?.toUpperCase();

    console.log("stream", method, path);

    if (!path || !method) return;

    let handler: Handler | null = null;
    let m: RegExpExecArray | null = null;

    for (const spec of handlerSpecs) {
      if (spec.method !== method) continue;
      m = spec.pathRegExp.exec(path);
      if (m === null) continue;

      handler = spec.handler;
      break;
    }

    if (!m || !handler) {
      stream.respond({
        ...corsHeaders,
        ":status": 404,
      });

      return;
    }

    let data: string | undefined = undefined;
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      if (data === undefined) {
        data = "";
      }
      data += chunk;
    });
    stream.on("end", () => {
      if (handler && m) {
        handler(stream, m, data);
      }
    });
  });

  return { handle };
};

const app = mkApp(server);

app.handle("options", /^.*$/, (stream) => {
  stream.respond({ ...corsHeaders, ":status": 204 });
});

async function main() {
  const redisClient = createClient();

  redisClient.on("error", (err) => console.log("Redis Client Error", err));

  await redisClient.connect();

  await redisClient.set("key", "value");

  console.log(await redisClient.get("key"));

  const redisSubscriber = redisClient.duplicate();

  await redisSubscriber.connect();

  const redisChannels = new Set<string>();

  const subscribe = async (
    channelName: ChannelName,
    stream: http2.ServerHttp2Stream
  ): Promise<void> => {
    console.log("subscribe", channelName);

    if (!activeStreams.has(channelName)) {
      activeStreams.set(channelName, new Set());
    }

    activeStreams.get(channelName)?.add(stream);

    if (!redisChannels.has(channelName)) {
      console.log("redis subscribe", channelName);
      redisChannels.add(channelName);

      await redisSubscriber.subscribe(channelName, (message) => {
        console.log('redis got message', channelName, message)
        activeStreams.get(channelName)?.forEach((stream) => {
          stream.write(`data: ${message}\n\n`);
        });
      });
    }
  };

  const unsubscribe = async (
    channelName: ChannelName,
    stream: http2.ServerHttp2Stream
  ): Promise<void> => {
    console.log("unsubscribe", channelName);

    const set = activeStreams.get(channelName);
    if (set) {
      set.delete(stream);

      if (set.size === 0) {
        activeStreams.delete(channelName);
      }
    }

    if (redisChannels.has(channelName)) {
      console.log("redis unsubscribe", channelName);

      redisChannels.delete(channelName);
      await redisSubscriber.unsubscribe(channelName);
    }
  };

  const publish = async (
    channelName: ChannelName,
    data: string
  ): Promise<void> => {
    console.log(
      `publish on ${channelName} to ${activeStreams.get(channelName)?.size} clients:`,
      data
    );

    await redisClient.publish(channelName, data);
  };

  app.handle("get", /^\/subscribe\/(.+)$/, async (stream, m) => {
    const channelName = m[1];
    if (channelName === undefined) throw new Error("invalid state");

    await subscribe(channelName, stream);

    stream.respond({
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });

    stream.on("close", () => unsubscribe(channelName, stream));
  });
  
  app.handle("post", /^\/publish\/(.+)$/, (stream, m, data) => {
    const channelName = m[1];
    if (channelName === undefined) throw new Error("invalid state");
    if (data === undefined) throw new Error("invalid state");

    stream.respond(corsHeaders);

    publish(channelName, data);
  });

  const port = process.env.PORT ? parseInt(process.env.PORT) : 8000;
  server.listen(port);
  console.log(`Listening on port ${port}`);
}

main();
