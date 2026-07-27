# Paquets

Même si les sources sont rangées par capacité, les paquets publics LikeGo restent plats. Le noyau comprend `@likego/context`, `@likego/core`, `@likego/client`, `@likego/server`, `@likego/transport`, `@likego/metadata`, `@likego/web`, `@likego/config`, `@likego/registry`, `@likego/cache`, `@likego/store`, `@likego/broker`, `@likego/event`, `@likego/health` et `@likego/resilience`.

Les appels internes au processus et les tests peuvent utiliser `@likego/transport-memory`. Le HTTP interne passe par `@likego/transport-http` ; le sous-chemin `@likego/transport-http/node` fournit les implémentations Node de `dial` et `listen`, avec TLS/mTLS PEM côté serveur et HTTP/2 négocié par ALPN. Les ponts Web sont `@likego/hono`, `@likego/elysia` et `@likego/h3`. Les adaptateurs de cycle de vie incluent `@likego/croner`, `@likego/bullmq`, `@likego/nats`, `@likego/pino`, `@likego/winston`; l’observabilité utilise `@likego/prometheus` et `@likego/otel`.

Les registres mDNS, Consul, etcd, Kubernetes et ZooKeeper sortent dans des paquets `@likego/registry-*`. Les Store sont `@likego/store-memory`, `@likego/store-file`, `@likego/store-consul`, `@likego/store-etcd` et `@likego/store-vault`. Consul, etcd et Vault ont aussi leurs fournisseurs Config, dont `@likego/config-vault` ; environnement, fichier et YAML restent des sous-chemins de Config. Le cache utilise le contrat `@likego/cache` avec `@likego/cache-memory` ou `@likego/cache-redis` comme fournisseur.

Les noms exacts des fournisseurs Registry sont `@likego/registry-mdns`, `@likego/registry-consul`, `@likego/registry-etcd`, `@likego/registry-kubernetes` et `@likego/registry-zookeeper`. Les fournisseurs Config manquants dans la description précédente sont `@likego/config-consul`, `@likego/config-etcd` et `@likego/config-kubernetes` ; les fournisseurs Broker sont `@likego/broker-memory` et `@likego/broker-rabbitmq`. Le paquet CLI de création de projets est `@likego/create`.

Importez depuis le plus petit paquet propriétaire du contrat. Les hosts de runtime comme Node ont des entrées explicites. Aucun grand tiroir public `adapters` ; les headers du projet utilisent toujours le préfixe `Likego-`.
