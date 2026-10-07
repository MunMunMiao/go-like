# Streaming

go-like utilise le modèle de flux déjà présent sur la plateforme Web. La requête est un `Request` standard et la réponse un `Response` dont le body peut être un `ReadableStream<Uint8Array>`. Pas de classe Stream maison, de DSL de frames ni de faux canal bidirectionnel posé sur un body à usage unique.

Le streaming HTTP public appartient à `@go-like/web` et au Handler natif du framework. Un appel unaire porte un corps JSON. Un server stream `stream: true` est du SSE sur `POST /<service>/<endpoint>` (`accept: text/event-stream`), pas un protocole bidirectionnel multi-trames. Le handler est un `async *`. Le client `await` un `ServerStream`, puis `for await`. Fermez avec `close()` ou `await using`. `streamKeepAlive` vaut 15000 ms ; `0` ne garde que le commentaire initial. `maxSendMessageBytes` vaut 4 Mio et compte l'événement SSE UTF-8 entier ; le dépassement est `resource_exhausted` / HTTP 429. Memory n'a au plus un message d'avance ; le préchargement HTTP est borné et n'est pas 1:1 avec `for await`. N'effectuez pas dans le générateur un effet qui suppose la livraison. Avec une deadline, le client écrit `Go-Like-Timeout-Ms`. Le Context de la requête vit jusqu'à la fin du body. Client-streaming et bidi restent dans `@go-like/transport-grpc-buf/native`.

Un body Web ne se consomme qu’une fois. Un middleware ne devrait le lire que s’il compte le remplacer explicitement. L’annulation passe par le premier `Context` et par le signal du request. Le transport vérifie aussi que chaque chunk est un `Uint8Array` : une valeur invalide devient une erreur de protocole, pas un contenu vide difficile à diagnostiquer.

Pour le HTTP public, utilisez `@go-like/web` avec Hono, Elysia, H3 ou votre propre handler. SSE, réponses en flux et upgrade WebSocket propres au runtime restent gérés par le framework d’origine ; go-like préserve les objets et erreurs natifs.

`contextHandler` nettoie son Context privé lorsque le Handler renvoie la Response, pas à la fin du body. Un producteur de longue durée doit observer `request.signal` ou posséder son propre périmètre d’annulation.

`@go-like/protoc-gen-like` génère le code Protobuf RPC avec `Context` en premier argument, sur Protobuf-ES. `@go-like/transport-grpc-buf` fournit unary et server-streaming Connect/gRPC-Web via Fetch ; `/native` ajoute gRPC standard avec les quatre cardinalités, dont client-streaming et bidi. Ce chemin est indépendant du chemin interne Fetch/SSE.

L’interopérabilité ne prouve pas la fiabilité en production : un drain avec consommateur lent échoue sur Deno 2.9.5/2.9.7 ; Connect 2.1.2 conserve un temporisateur deadline après annulation d’une réponse suspendue ; l’annulation Fetch de Bun 1.4.2 n’atteint pas un serveur silencieux après le premier chunk. Consultez les [preuves et limites](/reference/claims#stream-cancellation-limits) ; ces défauts ne sont pas corrigés par go-like.
