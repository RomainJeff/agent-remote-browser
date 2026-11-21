# agent-remote-browser, expliqué

## L'idée en une phrase
Chaque agent (Notion ou autre) reçoit un petit ordinateur jetable avec un navigateur, qu'il pilote à distance comme avec une télécommande. Les boutons de la télécommande sont les tools MCP. L'ordinateur, c'est un conteneur Docker.

## L'image mentale : la salle d'ordinateurs de la bibliothèque
- **Le guichet (`src/server.ts`)** : l'agent montre sa carte (clé Bearer). Le bibliothécaire sait quel poste lui revient et quels sites il a le droit de visiter. Il note chaque demande dans le registre (`audit.jsonl`).
- **Le poste (conteneur `arb-<profil>`)** : Chromium + agent-browser, rien d'autre. Pas de root, pas de capacités Linux, pas de réseau, 1 Go de RAM.
- **Le casier (volume `arb-profile-<profil>`)** : cookies et sessions. Le poste s'éteint après 5 min d'inactivité, mais le casier reste. Au retour de l'agent, il est toujours connecté.
- **Le trousseau (`login`)** : l'agent demande « connecte-moi à X ». C'est le bibliothécaire qui tape le mot de passe. L'agent voit seulement « c'est fait ».

## Le HostDriver : le bibliothécaire ne touche plus aux machines
Dans le POC, le guichet appelait directement le binaire `docker` : `docker run`, `docker exec`, `docker ps`… C'est comme si le bibliothécaire allait lui-même brancher les postes, tirer les câbles et redémarrer les écrans. Ça marche, mais tout le savoir-faire « machines » est mélangé au savoir-faire « bibliothèque ».

Le Lot 2 introduit un **intendant** : le `HostDriver` (`src/host/driver.ts`). Le bibliothécaire ne lui parle qu'avec six mots :

| Mot | Ce que ça veut dire |
| --- | --- |
| `ensure(id)` | « Que le poste de cette carte soit allumé et conforme. » Le crée, le recrée s'il a une config périmée, ou le démarre. |
| `exec(id, argv)` | « Tape cette commande sur ce poste et rapporte-moi la réponse. » |
| `stream(id)` | « Tends-moi un câble vers l'écran de ce poste » (le live view de l'admin). |
| `stop(id)` / `remove(id)` | Éteindre / démonter (avec ou sans casier). |
| `list()` | « Quels postes existent, lesquels tournent ? » |

Détail important : le bibliothécaire ne donne **jamais** de plan de montage, seulement un numéro de carte. C'est l'intendant qui sait comment un poste doit être câblé (pas de réseau, capacités retirées, gVisor). Un bug dans le guichet ne peut donc pas commander « un poste avec le disque de l'hôte monté », parce que ce mot n'existe pas dans le vocabulaire.

**Pourquoi c'est utile, concrètement :**
1. **Plus de CLI docker dans l'image.** `DockerDriver` (`src/host/docker.ts`) parle directement à l'API du Docker Engine par le socket Unix, en HTTP, version figée `/v1.47`. Moins de binaires dans l'image, moins de surface, et des erreurs structurées au lieu de texte à parser.
2. **Des tests sans Docker.** `FakeDriver` (`src/host/fake.ts`) est un intendant de théâtre : il note chaque demande dans un carnet (`fake.calls`) et répond ce qu'on lui a scripté. Les 51 tests tournent en ~0,3 s, sans daemon. Avant, on simulait un faux binaire `docker` en shell : fragile et lent.
3. **Le Lot 5 est déjà prévu.** Le jour où les postes tournent sur une autre machine (le « runner »), on écrit un `RunnerDriver` qui parle au runner au lieu du socket. Le guichet ne change pas d'une ligne.

## Comment `exec` passe par l'API Docker
Il n'y a plus de `docker exec` en ligne de commande, alors on fait ce que fait la CLI : on crée un exec (`POST /containers/arb-x/exec`), puis on le démarre avec une requête HTTP qui demande un `Upgrade`. Le serveur répond `101` et la connexion devient un tuyau brut. Ce qui ressort est multiplexé : chaque morceau commence par 8 octets (1 = stdout, 2 = stderr, puis la taille). On démêle les deux flux, puis on demande le code de sortie (`GET /exec/{id}/json`).

C'est comme recevoir deux conversations sur la même ligne téléphonique, chaque phrase précédée d'une étiquette « c'est Paul, 12 mots ». C'est aussi par ce tuyau que passe le mot de passe du `login` (sur stdin), jamais en argument ni dans les logs.

## Qui tient le câble réseau ?
Imagine un poste dont on a débranché le câble Ethernet. Il lui reste un interphone vers le guichet. C'est ainsi que tourne Chromium. Quand une page demande une connexion, le guichet vérifie le domaine et compose lui-même l'adresse IP autorisée. Même si le DNS change de réponse une seconde plus tard, la connexion part vers l'adresse vérifiée.

Concrètement, l'interphone est un socket Unix posé dans le volume `arb-egress`, un sous-dossier par profil. Chaque poste ne voit que le sien, en lecture seule.

## Profils, tokens et le guichet OAuth
Un **profil**, c'est une carte de bibliothèque : un poste, un casier, un trousseau, une liste de sites autorisés et un numéro (token `acp_`). Le token n'est affiché qu'**une fois** ; on ne garde que son empreinte (sha256).

**OAuth DCR**, c'est le guichet automatique. Notion arrive sans clé, se fait refouler (401), lit dans la réponse où trouver le guichet, s'y inscrit tout seul et repart avec un ticket d'1 h et un ticket de renouvellement de 30 jours.

Le **token global** (`acg_`), c'est le passe du bibliothécaire en chef : il crée des cartes et **emprunte** (lease) un poste pour un temps limité, de façon exclusive. Il ne révèle jamais le numéro d'une carte.

## Démarrer, s'arrêter, se relever
- **Config (`src/config.ts`)** : toutes les variables d'environnement passent par zod au démarrage. Une erreur, et le process s'arrête avec la liste des problèmes. Pas de gVisor (`runsc`) ? Refus, sauf `ALLOW_NO_SANDBOX=1` (dev sur Mac). En production, `PUBLIC_URL` est obligatoire et les tunnels jetables `trycloudflare` sont refusés.
- **SIGTERM** : le guichet ferme la porte, laisse finir les demandes en cours (8 s max), raccroche les interphones, et **laisse les postes allumés**. Au redémarrage, il demande `list()` à l'intendant et rebranche l'interphone de chaque poste qui tourne. Testé en vrai : le poste survit au redémarrage du gateway, et l'agent retrouve sa page.
- **`/healthz`** (le process répond) et **`/readyz`** (Docker répond en moins de 2 s) : sans authentification, sans détail.
- **Logs** : une ligne JSON par appel (`{level,msg,profile,tool,ms}`). Jamais les arguments, jamais de secret.

## Les pièges rencontrés
1. **Chrome for Testing n'existe pas en Linux ARM64.** On installe le paquet `chromium` de Debian.
2. **Le profil Chrome ne garde pas les cookies de session.** Fix : `--restore` d'agent-browser, qui sauvegarde cookies et localStorage sur le même volume.
3. **Audit faussement « ok »** : un `open` refusé ne levait pas d'exception. On lit maintenant `isError`.
4. **`__proto__` comme nom de profil** : les ids passent par une regex de slug, les lectures par `Object.hasOwn`.
5. **Node 26 lit le corps à notre place.** Le faux Engine des tests sautait le corps JSON de la requête `Upgrade` pour atteindre stdin. Sous Node 24, ce corps restait dans le socket ; sous Node 26, le serveur HTTP l'avalait déjà. Résultat : le test mangeait le mot de passe et recevait `got:` au lieu de `got:secret`. On a découvert ça au build de l'image (Node 26), pas en local (Node 24). Morale : faire tourner les tests sur la version cible, pas seulement sur celle du laptop.
6. **Non-root, mais le socket est à root.** Dans le conteneur, `/var/run/docker.sock` appartient à `root:root` en 0660. L'utilisateur `node` n'y a pas accès. Fix : `group_add: [DOCKER_GID]` dans compose (0 sur Docker Desktop, le groupe `docker` sur Linux).
7. **Les volumes nommés héritent du propriétaire de l'image.** Un volume vide monté sur `/run/arb-keys` prend le propriétaire du dossier dans l'image. Si le dossier n'existe pas, il appartient à root, et `node` ne peut pas y écrire la clé. Fix : `mkdir` + `chown node` dans le Dockerfile.

## Ce que je retiens
- Une interface étroite vaut mieux qu'une interface puissante. Six mots, aucun « plan de montage » : c'est ce qui rend le gateway testable **et** plus sûr.
- Le vrai risque restant n'a pas bougé : qui parle au socket Docker contrôle l'hôte. Le HostDriver ne le règle pas, il prépare le Lot 5 qui le sort du gateway.
- **Prochaines étapes** : SQLite pour l'état et les leases (Lot 3), Better Auth devant l'admin (Lot 4), le runner séparé (Lot 5).
