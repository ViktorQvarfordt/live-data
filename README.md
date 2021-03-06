# Instructions

**Start server:**

```sh
cd server
yarn install
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -subj '/CN=localhost' -keyout key.pem -out cert.pem # https required for http2
docker run --rm -p 6379:6379 redis:7-alpine
docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=password postgres:14-alpine
node server.js
```

**Start client:**

```sh
cd client
yarn install
yarn dev
```

**Inspect databases:**

```sh
docker run --network=host -it --rm redis:7-alpine redis-cli
docker run --network=host -it --rm postgres:14-alpine psql "host=localhost user=postgres password=password"
```

## Notes

Using an HTTP2 server since [SSE suffers from fundamental limitations on HTTP1](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#sect1).


## Draft API

```ts
const server = http2.createSecureServer({
  key: fs.readFileSync('./key.pem'),
  cert: fs.readFileSync('./cert.pem')
})

const publisher = createPublisher({ server, onAuthenticate })

server.listen(8000)

publisher.publish('channel-123', JSON.stringify({ anyJsonData: 'example' }))
```
