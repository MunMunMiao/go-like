# Vérification

Un test unitaire vert est une preuve précise, pas une garantie universelle. Les paquets portables passent par TypeScript strict, les règles de source, la couverture du code de production, le build et des smoke tests du paquet publié. Quand le contrat l’exige, des lanes distinctes couvrent Bun, Node.js et Deno.

Les fournisseurs externes sont testés avec de vrais conteneurs épinglés par digest immuable. Les suites créent des ressources Consul, etcd, NATS, OpenTelemetry Collector, Redis/BullMQ, ZooKeeper et Kubernetes/K3s, vérifient leur comportement puis leur suppression. Un fake aide pour les cas déterministes, mais ne remplace jamais la porte de protocole réelle.

La seule porte racine complète bloquant une publication est :

```sh
bun run verify
```

Chaque fournisseur garde ses commandes Docker et ses contrôles ciblés dans son `package.json`, avec un marqueur lisible par machine. Ces diagnostics sont utiles, mais ne remplacent pas la porte racine complète. Seul le résultat terminal de la dernière exécution complète de `bun run verify` détermine l’état de publication ; vérifiez aussi le contenu généré, les manifests du workspace, le nettoyage Docker et `git status`. Une commande lancée ou un journal silencieux ne prouve pas une réussite.
