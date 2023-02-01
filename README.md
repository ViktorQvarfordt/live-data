# Instructions

```
cd pnpm-workspace-root
./dev # It starts redis, postgres, ts package compiler, and the dev servers in iTerm2 panes
```

## Project structure

Using TypeScript [Project References](https://www.typescriptlang.org/docs/handbook/project-references.html) together with pnpm workspaces.

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

### vscode intellisense

Auto-imports give the right import path both within and across packages.

### pnpm

* `pnpm` is fast and has strong adoption by the community.
* `pnpm` doesn't hijack the module resolution like `yarn pnp`, meaning that most things _just works_.

## Notes

Using an HTTP2 server since [SSE suffers from fundamental limitations on HTTP1](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#sect1).

**Inspect databases**

```sh
docker run --network=host -it --rm redis:7-alpine redis-cli
docker run --network=host -it --rm postgres:14-alpine psql "host=localhost user=postgres password=password"
```
