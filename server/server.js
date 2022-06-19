const http2 = require("node:http2");
const fs = require("node:fs");
const json = require("@sanalabs/json");

const options = {
  key: fs.readFileSync("./key.pem"),
  cert: fs.readFileSync("./cert.pem"),
};

const commonHeaders = {
  ":status": 200,
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "*",
};

const server = http2.createSecureServer(options);

server.on("error", (err) => console.error(err));

const activeStreams = new Set();

const broadcast = (data) => {
  console.log(`broadcasting to ${activeStreams.size} clients:`, data);
  activeStreams.forEach((stream) => {
    stream.write(`data: ${JSON.stringify(data)}\n\n`);
  });
};

let state = { foo: "bar" };

server.on("stream", (stream, headers) => {
  console.log("stream", headers[":method"], headers[":path"]);

  if (headers[":method"] === "OPTIONS") {
    stream.respond(commonHeaders);
  } else if (headers[":path"] === "/sse") {
    stream.respond({
      ...commonHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });

    activeStreams.add(stream);

    stream.on("close", () => activeStreams.delete(stream));
  } else if (headers[":path"] === "/get") {
    stream.respond({
      ...commonHeaders,
      "Content-Type": "application/json",
    });

    stream.end(JSON.stringify(state));
  } else if (headers[":path"] === "/put") {
    stream.respond({
      ...commonHeaders,
    });

    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => (data += chunk));
    stream.on("end", () => {
      const delta = JSON.parse(data);
      json.patch(state, delta);
      broadcast(state);
    });
  }

  // if (headers[":path"] === "/") {
  //   stream.respond({
  //     ":status": 200,
  //     "content-type": "text/html; charset=utf-8",
  //   });

  //   stream.end(indexHtml);
  // }
});

const port = 8000;
server.listen(port);
console.log(`Listening on port ${port}`);
