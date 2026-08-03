# LikeGo

LikeGo rassemble des briques façon Go pour construire des services backend en TypeScript. Cycle de vie, contexte, appels interservices, découverte, messages, configuration, stockage, santé et observabilité restent dans de petits paquets bien délimités. Pas besoin de jeter votre framework ni de choisir un runtime imposé.

Le code portable s’en tient aux API Web standard : `Request`, `Response`, `Headers`, `AbortSignal`, Web Streams et un `fetch` injecté. Ce qui dépend de Node.js, Bun ou Deno passe par une entrée dédiée. Les frameworks qui exposent déjà Fetch n’ont pas besoin d’un adaptateur LikeGo : passez `app.fetch` de Hono, Elysia ou H3 2.x directement à `@likego/web` ; H3 1.x utilise `toWebHandler(app)`. Les adaptateurs de cycle de vie restent réservés aux ressources comme Croner, BullMQ, NATS, Pino et Winston.

Commencez par [Bien démarrer](/fr-Latn/guide/getting-started), puis lisez [Architecture](/fr-Latn/guide/architecture). La [référence des paquets](/fr-Latn/reference/packages) dit clairement qui fait quoi, tandis que [Vérification](/fr-Latn/reference/verification) sépare les capacités réellement testées des promesses qui sembleraient seulement plausibles.

## « Façon Go », concrètement

Le `Context` est le premier argument d’une opération bloquante, la propriété des ressources est visible et l’arrêt produit un état terminal observable. Cela ne consiste pas à copier la casse de Go ni à faire semblant que JavaScript possède des channels : TypeScript garde ses exports naturels et les objets natifs des fournisseurs restent accessibles.
