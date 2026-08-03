# LikeGo

LikeGo is a set of small, Go-style building blocks for TypeScript backend services. It gives an application explicit contracts for lifecycle, context cancellation, service calls, discovery, messaging, configuration, storage, health, and telemetry without asking the application to hand over its framework or runtime.

The project deliberately sticks to standard Web APIs in portable code: `Request`, `Response`, `Headers`, `AbortSignal`, Web Streams, and injected `fetch`. Runtime-specific work lives behind a separate package or subpath. Frameworks that already expose Fetch need no LikeGo adapter: pass Hono, Elysia, or H3 2.x `app.fetch` directly to `@likego/web`; H3 1.x uses `toWebHandler(app)`. Lifecycle adapters remain for resources such as Croner, BullMQ, NATS, Pino, and Winston.

Start with [Getting started](/guide/getting-started), then read [Architecture](/guide/architecture) before choosing providers. The [package reference](/reference/packages) tells you which package owns each responsibility, while [verification](/reference/verification) explains what has actually been exercised instead of merely assumed.

## What “Go-style” means here

Context is the first argument of blocking work, ownership is visible, shutdown has a terminal result, and small interfaces are satisfied structurally. It does **not** mean copying Go spelling or pretending JavaScript has goroutines and channels. TypeScript exports stay idiomatic, and native provider objects remain available when their semantics cannot be represented honestly by a shared abstraction.
