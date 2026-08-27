# Broker et événements

`@go-like/broker` définit un SPI Context-first pour publier et souscrire avec topic et bytes. Chaque livraison conserve le message natif du fournisseur, car `ack`, `nak`, `term`, redistribution, durable consumer et dead letter ont des sens propres à chaque broker. Une façade commune trop lisse ferait perdre ces informations.

`@go-like/event` ajoute une couche typée facultative. La publication encode des bytes détachés ; à la réception, le schéma n’est décodé que lorsque l’application appelle `decode()`. Même si le décodage échoue, le `Msg` NATS ou `JsMsg` JetStream natif reste disponible pour choisir le bon règlement.

`Broker.subscribe(ctx, topic, handler)` renvoie un `Subscriber` du fournisseur avec `unsubscribe(ctx)`. `newBrokerServer(...)` adapte un `Broker` au contrat Core `Server` : `start(ctx)` représente toute la durée d’exécution et `stop(ctx)` demande l’arrêt. go-like arrête la subscription admise, mais ne possède jamais la connexion, le stream ni le durable consumer. Une annulation au démarrage libère une subscription créée mais pas encore admise.

Choisissez un Broker pour la livraison d’événements et le fan-out. Si vous avez réellement besoin du modèle job, retry, backoff, token et Worker de BullMQ, utilisez `@go-like/bullmq`. Ce sont deux modèles différents ; les masquer derrière un faux dénominateur commun n’aiderait personne.

> [!NOTE]
> Cette page est un résumé localisé. Le DAG complet du recovery RabbitMQ, du settlement NATS Core/JetStream, du cycle de vie BullMQ/Croner et de la terminal barrier du provider se trouve dans la [page canonique anglaise](/guide/broker-events).

```text
application-owned native connection / consumer
  -> go-like accepted subscription
  -> Broker bytes/topic delivery
  -> application settlement through native provider object
  -> explicit unsubscribe / provider terminal result
```
