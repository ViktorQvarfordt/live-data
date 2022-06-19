const http2 = require("node:http2");
const fs = require("node:fs");
const json = require("@sanalabs/json");

const options = {
  key: fs.readFileSync("./key.pem"),
  cert: fs.readFileSync("./cert.pem"),
};

const indexHtml = fs.readFileSync("./index.html", "utf-8");

const server = http2.createSecureServer(options);

server.on("error", (err) => console.error(err));

const activeStreams = new Set();
const broadcast = (data) =>
  activeStreams.forEach((stream) => {
    stream.write(`data: ${data}\n\n`);
  });

server.on("stream", (stream, headers) => {
  console.log("stream path", headers[":path"]);

  if (headers[":path"] === "/sse") {
    stream.respond({
      ":status": 200,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });

    activeStreams.add(stream);

    stream.on("close", () => activeStreams.delete(stream));
  }

  if (headers[":path"] === "/get") {
    stream.respond({
      ":status": 200,
      "Content-Type": "application/json",
    });

    stream.end(JSON.stringify({ foo: "bar" }));
  }

  if (headers[":path"] === "/put") {
    stream.respond({
      ":status": 200,
    });

    console.log(activeStreams.size);
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => (data += chunk));
    stream.on("end", () => broadcast(data));
  }

  if (headers[":path"] === "/") {
    stream.respond({
      ":status": 200,
      "content-type": "text/html; charset=utf-8",
    });

    stream.end(indexHtml);
  }
});

const port = 8000;
server.listen(port);
console.log(`Listening on port ${port}`);
