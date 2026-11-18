# Streaming

go-like a trois frontières de streaming.

1. **Le streaming Web public** utilise le corps `Request` et `Response` de Fetch et l'API Web Streams.
2. **Les appels de service internes** utilisent une requête Fetch et une réponse Fetch. Un appel unaire porte un corps JSON. Un flux serveur positionne `stream: true` et renvoie `text/event-stream`. Il n'y a pas de SPI client-stream ni bidirectionnel sur ce chemin.
3. **Le RPC Protobuf généré** utilise `@go-like/connectrpc` pour Connect et gRPC-Web sur Fetch, et `@go-like/connectrpc/node` pour le gRPC standard géré. Fetch portable couvre l'unaire et le server-streaming. L'entrée Node couvre l'unaire, le server-streaming, le client-streaming et le bidi. `@go-like/protoc-gen-like` génère le code de liaison du client et du handler, avec le Context en premier argument.

Un `ReadableStream`, une réponse SSE de framework ou un upgrade WebSocket est du streaming Web. Un flux serveur interne est du SSE sur `POST /<service>/<endpoint>` avec `accept: text/event-stream`.

Le drain gRPC géré avec consommateur lent sur Node 26.12.1 et Bun 1.4.4 est consigné dans la [matrice de drain gRPC natif](/reference/claims#native-grpc-drain-status). Les observations antérieures d'annulation Fetch de Connect 2.1.2 et de Bun 1.4.2 restent dans le [registre des affirmations](/reference/claims#stream-cancellation-limits). Le RPC généré n'ajoute pas de rejeu de flux.

## Streaming Web public

```ts
import { contextHandler, type Handler } from "@go-like/core/web"

export const streamHandler: Handler = contextHandler(async () => {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("first\n"))
      controller.enqueue(encoder.encode("second\n"))
      controller.close()
    }
  })
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" }
  })
})
```

L'application ou le framework possède le format du flux, le flush, les conventions SSE, l'upgrade WebSocket et la policy de déconnexion. `contextHandler` termine son Context lorsque le handler renvoie la `Response`. Un corps de longue durée doit aussi observer `request.signal`. Un Context de RPC interne vit jusqu'à la fin du corps de réponse.

Hono, Elysia et H3 conservent leurs propres API de flux et de WebSocket. Passez `app.fetch` à `@go-like/core/web/node` ou `@go-like/core/web/bun` lorsque vous voulez le cycle de vie de l'App.

## Flux serveur internes

Déclarez `stream: true`. Le handler est un générateur asynchrone. Le client lit un `ServerStream` avec `for await`. `close()`, `await using`, `break` et l'annulation de l'appelant abandonnent la requête.

```ts
import { newClient, withEndpoint, withTransport } from "@go-like/core/client"
import { background } from "@go-like/core/context"
import { address, newServer, transport as serverTransport } from "@go-like/core/server"
import { struct } from "@go-like/core/struct"
import { defineService } from "@go-like/core/transport"
import { newMemoryTransport } from "@go-like/core/transport/memory"

const orders = defineService("orders", {
  watch: {
    request: struct.object({ after: struct.string() }),
    response: struct.object({ id: struct.string() }),
    stream: true
  }
})

const transport = newMemoryTransport()
const rpc = newServer(serverTransport(transport), address("memory://orders"))
orders.registerHandler(rpc, {
  async *watch(_ctx, request) {
    yield { id: request.after }
  }
})

const api = orders.newClient(newClient(withTransport(transport), withEndpoint("memory://orders")))
const stream = await api.watch(background(), { after: "0" })
for await (const event of stream) {
  console.log(event.id)
  break
}
await stream.close()
```

`streamKeepAlive` et `maxSendMessageBytes` sur `@go-like/core/server` bornent l'intervalle des commentaires SSE et la taille de trame. Ils ne changent pas la cardinalité. Il y a toujours un corps de requête et une séquence d'événements de réponse.

## RPC généré

`@go-like/connectrpc` exporte `newHandler`, `callOptions` et `fromHandlerContext`. Le handler est un `Handler` Fetch pour Connect et gRPC-Web. Montez-le sur un host Web de core de la même façon que n'importe quel autre handler.

`@go-like/connectrpc/node` exporte `newServer`, `newClient`, ainsi que les options d'adresse, d'annonce et de TLS. Ce serveur est un `Server` de cycle de vie et un `Endpointer` pour le palier serveurs. Le client Node consomme `Discovery` et `Selector` lorsque vous les passez. Le gRPC standard sur cette entrée est le chemin qui couvre le client-streaming et le bidi.

`@go-like/protoc-gen-like` est le plugin Buf. Le code généré importe `@go-like/core/context` et `@go-like/connectrpc`. Le générateur n'a pas de socket d'exécution.

Le gRPC standard dans le navigateur, les health et reflection gRPC officiels, et une garantie sur un runtime futur sont en dehors de cette matrice. Le drain géré testé est le [relevé des affirmations](/reference/claims#native-grpc-drain-status).
