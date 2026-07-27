# Architecture

LikeGo is arranged as flat, publishable packages rather than a large framework container. `@likego/core` composes independently created servers; `@likego/context` carries cancellation, deadlines, causes, and values; the remaining SPI packages define narrow contracts for one capability domain. Provider packages implement those contracts without becoming global defaults.

The main planes are intentionally separate:

- The application plane owns startup, admission, concurrent shutdown result aggregation through `Promise.allSettled`, hooks, and terminal results. Components that require ordered cleanup must compose that order inside one Server.
- The call plane combines registry discovery, endpoint selection, client calls, server projection, and transport.
- The event plane keeps raw broker delivery semantics while offering an optional typed codec layer.
- The operations plane covers config snapshots, stores, health probes, metrics, tracing, and native logging lifecycles.
- The Web edge accepts standard Fetch handlers; it is not the same thing as internal transport.

Dependencies point inward toward portable interfaces. Provider packages may depend on an official SDK or a runtime host, but the SPI must not import them back. This boundary is what lets a Bun, Node.js, Deno, or future Web-compatible host share application code without inventing a lowest-common-denominator framework.

There is no service locator. The application constructs dependencies explicitly and hands them to constructors. That little bit of wiring is useful: it shows which component owns connections, watchers, listeners, and shutdown work.
