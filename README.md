# Instructions

**Start server:**

```sh
cd server

# Set up HTTPS keys (required for http2). You need this only once.
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -subj '/CN=localhost' -keyout key.pem -out cert.pem

node server.js
```

**Start client:**

```sh
cd client

# Install dependencies. You need this only once.
yarn install

yarn dev
```

## Notes

Using an HTTP2 server since [SSE suffers from fundamental limitations on HTTP1](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#sect1).
