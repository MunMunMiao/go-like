# Vérification

Une commande peut exister sans avoir réussi. Une piste verte n'implique pas que chaque plug, runtime, exemple ou tarball empaqueté fonctionne. Consignez l'arborescence candidate, les versions d'outils, la commande exacte, le code de sortie, les décomptes et le nettoyage.

## Pistes de preuve

| Piste                  | Ce qu'elle contrôle                                                                        | Services externes          | Ce qu'une réussite ne prouve pas                          |
| ---------------------- | ------------------------------------------------------------------------------------------ | -------------------------- | --------------------------------------------------------- |
| Format                 | Formatage des sources et de la documentation                                               | Non                        | Le comportement d'exécution                               |
| Lint                   | Règles Oxlint                                                                              | Non                        | Les types ou le comportement d'exécution                  |
| Typecheck              | TypeScript de la racine, des paquets, des exemples et des E2E                              | Non                        | La sortie de build ou le comportement d'un fournisseur    |
| Unitaire               | Tests déterministes                                                                        | Non                        | Un réseau réel, Docker ou des tarballs empaquetés         |
| Build                  | ESM et déclarations des paquets                                                            | Non                        | La résolution chez le consommateur                        |
| E2E de runtime         | Fixtures Bun et Node là où elles sont déclarées                                            | En général non             | Chaque plug                                               |
| E2E de fournisseur     | Consul, etcd, Kubernetes, ZooKeeper, Redis, RabbitMQ, NATS et les autres services déclarés | Oui                        | La disponibilité en production ou une CI hébergée         |
| E2E d'exemple          | Processus, requête, readiness, arrêt et nettoyage de l'exemple                             | Parfois                    | Une installation séparée de chaque exemple                |
| Publié                 | Tarballs empaquetés consommés par des fixtures Node et Bun                                 | Non, sauf imports de plugs | La publication npm                                        |
| Soak                   | Comportement HTTP ou de service de longue durée                                            | En général non             | Un test court, ou chaque plug                             |
| Build de documentation | VitePress                                                                                  | Non                        | La mise en page du navigateur ou la qualité de traduction |
| Audit                  | Rapport de vulnérabilités des dépendances                                                  | Non                        | L'autorisation applicative                                |

L'inventaire public actuel est de 20 paquets et 75 entrées. Voir [Paquets](/fr-Latn/reference/packages).

## Commandes déclarées

Depuis la racine du dépôt :

```sh
bun install --frozen-lockfile
bun run verify
```

`bun run verify` exécute `test:protobuf`, `fmt:check`, `lint:check`, `typecheck`, `build` et `test:unit:coverage` dans cet ordre. L'étape de couverture exécute chaque script de couverture de la racine et du workspace et se termine par `coverage:verify`. `examples/payments-ledger` est l'exception du périmètre unitaire dont le script de couverture exécute aussi son scénario PostgreSQL et NATS, et a donc besoin de Docker.

`fmt` répare le formatage. `lint` applique les correctifs Oxlint sûrs, formate le résultat et ne réussit qu'avec zéro avertissement :

```sh
bun run fmt
bun run lint
```

Les étapes individuelles resserrent un échec. Réussir une étape ne remplace pas `verify` :

```sh
bun run test:protobuf
bun run fmt:check
bun run lint:check
bun run typecheck
bun run build
bun run test:unit
bun run test:unit:coverage
bun run test:parallel
bun run test:stability
```

`test:unit:coverage` contrôle l'inventaire des sources exécutables et la couverture de lignes et de fonctions par fichier. Il ne revendique pas la couverture de branches. `test:stability` randomise chaque exécution de racine et de workspace, répète chaque fichier de test deux fois et imprime la graine. Il ne réessaie pas. `test:parallel` exécute le périmètre unitaire une fois avec deux workers Bun isolés. Ni la stabilité ni le parallèle ne font partie de `verify`.

Le build de documentation et l'audit restent séparés :

```sh
bun run doc:build
bun run audit
```

`test:protobuf` exécute le lint et la génération Buf, contrôle les types des fixtures générées et exécute son test d'intégration RPC. Ce n'est pas un contrôle de format en lecture seule.

## Périmètres E2E

Les scripts racine sont :

```sh
bun run test:e2e:suites
bun run test:e2e:runtimes
bun run test:e2e:providers
bun run test:e2e:examples
bun run test:e2e:published
bun run test:e2e
bun run test:e2e:soak
bun run test:e2e:grpc-soak
```

Les scripts de périmètre construisent d'abord, sauf `test:e2e:grpc-soak`, qui génère le protobuf puis exécute `e2e/grpc-soak.ts`. Un `bun e2e/run.ts --scope <name>` direct ne construit pas nécessairement. Dites lequel vous avez exécuté.

L'E2E de fournisseur a besoin de ses services Docker déclarés et du nettoyage. Les contrôles publiés empaquettent des tarballs et les installent dans des consommateurs préparés. Le soak vaut 60 minutes par défaut :

```sh
bun run test:e2e:soak
```

Une exécution HTTP courte n'est pas ce soak.

Cette page liste les scripts du manifest racine. Elle ne consigne pas de code de sortie pour eux. La disposition pas à pas des suites vit avec le runner E2E, pas ici.

## Observation de la chaîne d'outils

Le dépôt ne déclare pas de versions de runtime ou d'outil comme exigences d'exécution. Une piste contrôle que chaque outil requis peut s'exécuter, puis consigne l'environnement. Un outil manquant, un timeout, un statut non nul ou un consommateur en échec font échouer l'exécution. Une chaîne de version ne le fait pas.

Les versions des dépendances, le lockfile et les fixtures fixes sont des entrées de reproductibilité.

## Preuve de baseline pour ce parcours documentaire

L'audit de contrat fourni a rapporté ce qui suit sur le commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675` :

```text
bun run typecheck  -> passed
bun run test:unit  -> passed, 2,736 tests across root and 87 workspaces
bun run fmt:check  -> passed, 1,514 files
source export audit -> 66 declared entries imported without an import error
```

Cet audit décrit l'arborescence d'avant la migration. La source actuelle exporte 75 entrées sur 20 paquets. L'audit n'a pas exécuté `build`, `doc:build`, `audit`, les E2E de fournisseurs Docker, l'exécution inter-runtime, les contrôles de tarballs publiés, les requêtes npm, une CI hébergée, ni le soak de 60 minutes. Cette édition documentaire ne remplace pas ce relevé par un nouveau résultat réussi.

## Ce qu'un résultat permet de dire

| Résultat                   | Formulation sûre                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------- |
| Inspection d'export source | « Le paquet exporte ce symbole sur cette arborescence. »                                |
| Typecheck ciblé            | « Cette source passe le typecheck sous cette commande. »                                |
| Test unitaire ciblé        | « Ces cas ont réussi sous cette commande. »                                             |
| `bun run verify`           | « La séquence verify consignée a réussi pour cette arborescence et cet environnement. » |
| E2E de fournisseur         | « Ce scénario a réussi avec le service et le nettoyage consignés. »                     |
| Fixture de runtime         | « Cette fixture a réussi sous cette version de runtime. »                               |
| Consommateur publié        | « Cet artefact empaqueté a été consommé par la fixture consignée. »                     |
| Build de documentation     | « VitePress a construit les routes configurées. »                                       |
| Soak                       | « Cette durée et cette charge se sont terminées avec les résidus consignés. »           |

Utilisez [Affirmations](/reference/claims) pour le registre éditorial.

## Frontières connues

- Un `publishConfig` de manifest n'établit pas une publication npm.
- Un fichier de workflow n'établit pas un résultat de CI hébergée.
- Un script de paquet peut être une piste déclarée sans réussite récente.
- Les fournisseurs mémoire n'établissent pas un comportement interprocessus ou de protocole fournisseur.
- Un `ReadableStream` Web n'établit pas un RPC interne full-duplex.
- Des options TLS n'établissent pas une authentification applicative.
- Un timeout d'arrêt n'établit pas que chaque ressource native a terminé.
