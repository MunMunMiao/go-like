# Getting started

Install only the pieces your service needs. A typical HTTP service starts with `@likego/context`, `@likego/core`, `@likego/web`, and one Web framework adapter. Internal calls add `@likego/client`, `@likego/transport`, and `@likego/transport-http`; discovery and configuration are separate choices rather than hidden defaults.

> [!IMPORTANT]
> This checkout links the `@likego/*` packages through `workspace:*` at manifest version `0.0.1`; that version has not been published to npm. The `bun add` command below describes the post-release path. To validate and run the current source from a repository checkout:
>
> ```sh
> bun install --frozen-lockfile
> bun run test:e2e:examples
> bun run --cwd examples/vanilla-web start
> ```

```sh
bun add @likego/context @likego/core @likego/web
```

Create `src/main.ts`:

```ts
import { background } from "@likego/context"
import { context, name, newApp, server, stopTimeout } from "@likego/core"
import { signal } from "@likego/core/node"
import type { Handler } from "@likego/web"
import { newNodeServer, port } from "@likego/web/node"

const handler: Handler = (request) => {
  const path = new URL(request.url).pathname
  return Response.json({ message: "hello from LikeGo", path })
}

const app = newApp(
  context(background()),
  name("hello"),
  server(newNodeServer(handler, port(3000))),
  stopTimeout(30_000),
  signal()
)

await app.run()
```

Run the service:

```sh
bun run src/main.ts
```

Anything that implements the structural `Server` contract can join the application. Adapters such as `@likego/croner`, `@likego/bullmq`, `@likego/pino`, and `@likego/winston` exist for popular libraries, but they do not replace those libraries or copy their option surfaces.

Keep credentials, network clients, and framework configuration in application code. Pass the minimum capability into LikeGo—usually an existing native object or an injected `fetch`. This keeps tests deterministic and makes ownership obvious during shutdown.
