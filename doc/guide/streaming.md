# Streaming

LikeGo uses the streaming model that already exists in the Web platform. A streaming request is a standard `Request`, and a streaming response is a standard `Response` whose body may be a `ReadableStream<Uint8Array>`. There is no custom stream class, frame DSL, or fake bidirectional channel layered on top.

Public HTTP streaming belongs to `@likego/web` and the native framework Handler. Internal `@likego/client` and `@likego/transport` currently expose unary `Message` calls only; there is no separate Fetch Transport or Stream Client API.

This distinction matters because Web bodies are one-shot. Middleware should avoid reading a body unless it intends to replace it, and cancellation should travel through the request signal and the first `Context` argument. The transport validates that stream chunks are `Uint8Array`; malformed chunks become protocol errors instead of silently turning into empty data.

For public HTTP endpoints, pass your framework's native Fetch handler to `@likego/web`. Hono, Elysia, and H3 can create SSE, streamed responses, or runtime-specific WebSocket upgrades directly. LikeGo only preserves their native `Request`, `Response`, stream, and error identity.
