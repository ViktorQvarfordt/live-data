# Instructions

Set up https keys (required for http2):

```
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -subj '/CN=localhost' -keyout key.pem -out cert.pem
```

Start server:

```
node server.js
```

## Notes

Using an HTTP2 server since [SSE suffers from fundamental limitations on HTTP1](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#sect1).
