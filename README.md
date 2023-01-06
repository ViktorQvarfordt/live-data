# Instructions

**Start server:**

```sh
docker run --rm -p 6379:6379 redis:7-alpine
docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=password postgres:14-alpine
cd server
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -subj '/CN=localhost' -keyout key.pem -out cert.pem # https required for http2
pnpm i
pnpm dev
```

**Start client:**

```sh
cd client
pnpm i
pnpm dev
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

## Project structure

### pnpm and workspaces

* `pnpm` is fast and has strong adoption by the community.
* `pnpm` doesn't hijack the module resolution like `yarn pnp`, meaning that everything _just works_.
* `yarn pnpm` doesn't support typescript composit project references.

### Typescript

This compiler option
```
"disableSourceOfProjectReferenceRedirect": true,
```
is important for performance. It makes vscode not index the composite package source files, which speeds up vscode intellisense etc.

With that, go-to-definition goes to the `.d.ts` file istead of the source. To get around this one can generate source files with this compiler option
```
"declarationMap": true,
```
