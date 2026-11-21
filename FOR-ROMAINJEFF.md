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

## Lot 3 : le carnet, le coffre et le déménagement

**Le carnet (SQLite).** Avant, l'état tenait dans un fichier JSON réécrit en entier à chaque changement, comme un cahier qu'on recopie à chaque ligne ajoutée. Maintenant, c'est un vrai carnet relié : `arb.db`, une base SQLite. Le pilote est `node:sqlite`, fourni par Node lui-même : rien à compiler, rien à installer. Better Auth (Lot 4) sait écrire dans ce même carnet via Kysely, qui reconnaît une base `node:sqlite` toute seule. On a vérifié avant de choisir : `better-auth@1.7.27`, Node 24 et 26, sans avertissement « expérimental ».

Le carnet a ses règles :
- **WAL** : les lecteurs ne bloquent pas l'écrivain.
- **Clés étrangères** : supprimer un profil efface ses identifiants, ses leases et ses tokens, en cascade. Plus de miettes orphelines.
- **Migrations numérotées** (`001_app.sql`, puis `002_...`) : chaque page ajoutée au règlement s'applique une fois, dans une transaction. `PRAGMA user_version` est le marque-page.
- **Les leases survivent** : avant, un redémarrage effaçait les prêts en cours, et un deuxième agent pouvait prendre un navigateur déjà prêté. Maintenant le prêt est écrit dans le carnet, haché comme tous les tokens.

**Le coffre et sa clé.** Les mots de passe enregistrés sont dans le carnet, mais scellés (AES-256-GCM). La clé du coffre n'est **pas** rangée avec le carnet : c'est un secret Docker à part (`/run/secrets/login_key`). Voler le carnet seul ne donne rien. Chaque enveloppe porte l'empreinte de la clé qui l'a scellée (`key_id`). Au démarrage, le gateway compare : clé absente ou différente alors que des enveloppes existent ? Il refuse de démarrer, plutôt que de créer une clé neuve qui rendrait tout illisible. `rotate-login-key` change la serrure : nouvelle clé, tout est re-scellé dans une seule transaction, l'ancienne clé reste à côté (`.old`) jusqu'à ce qu'on la jette.

**Le déménagement (`migrate-from-poc`).** Le POC (`agent-computer`) tourne encore. On emporte les meubles, pas les clés de l'ancien appartement : profils, listes de sites autorisés et identifiants (déchiffrés avec l'ancienne clé, rescellés avec la nouvelle, et vérifiés un par un). Les tokens et l'OAuth restent sur place : on en génère des neufs, les agents se reconnectent. Par défaut c'est une visite à blanc : la commande fait tout l'import dans une transaction, puis l'annule, et affiche les commandes Docker qui copieraient les volumes `ac-profile-*` vers `arb-profile-*`. Avec `--apply`, elle valide et copie pour de vrai, sans jamais écraser un volume existant. La sortie ne montre que des compteurs et des noms de profils.

## Les pièges rencontrés
1. **Chrome for Testing n'existe pas en Linux ARM64.** On installe le paquet `chromium` de Debian.
2. **Le profil Chrome ne garde pas les cookies de session.** Fix : `--restore` d'agent-browser, qui sauvegarde cookies et localStorage sur le même volume.
3. **Audit faussement « ok »** : un `open` refusé ne levait pas d'exception. On lit maintenant `isError`.
4. **`__proto__` comme nom de profil** : les ids passent par une regex de slug, les lectures par `Object.hasOwn`.
5. **Node 26 lit le corps à notre place.** Le faux Engine des tests sautait le corps JSON de la requête `Upgrade` pour atteindre stdin. Sous Node 24, ce corps restait dans le socket ; sous Node 26, le serveur HTTP l'avalait déjà. Résultat : le test mangeait le mot de passe et recevait `got:` au lieu de `got:secret`. On a découvert ça au build de l'image (Node 26), pas en local (Node 24). Morale : faire tourner les tests sur la version cible, pas seulement sur celle du laptop.
6. **Non-root, mais le socket est à root.** Dans le conteneur, `/var/run/docker.sock` appartient à `root:root` en 0660. L'utilisateur `node` n'y a pas accès. Fix : `group_add: [DOCKER_GID]` dans compose (0 sur Docker Desktop, le groupe `docker` sur Linux).
7. **Les volumes nommés héritent du propriétaire de l'image.** Un volume vide monté sur `/data` prend le propriétaire du dossier dans l'image. Si le dossier n'existe pas, il appartient à root, et `node` ne peut pas y écrire la base. Fix : `mkdir` + `chown node` + `chmod 700` dans le Dockerfile.
8. **Le gateway redémarré, le test plante en `ECONNRESET`.** Le client HTTP de Node garde la connexion ouverte (keep-alive). On redémarrait le serveur sur le même port : la première requête partait sur l'ancien socket, mort. Fix : chaque redémarrage de test prend de nouveaux ports libres.
9. **SQLite crée ses fichiers compagnons.** En mode WAL, `arb.db` vient avec `arb.db-wal` et `arb.db-shm`. Ils contiennent les dernières écritures, donc des hashes et des enveloppes. SQLite leur donne les droits du fichier principal : on crée `arb.db` en 0600 **avant** de l'ouvrir, et les compagnons suivent.
10. **`JSON.parse` bavarde.** Son message d'erreur cite un bout du fichier fautif. Sur un `state.json` du POC, ce bout peut être un mot de passe en clair. La CLI remplace l'erreur par un message générique, et un test vérifie qu'aucun secret ne sort, en hex, base64 et texte.

## Ce que je retiens
- Une interface étroite vaut mieux qu'une interface puissante. Six mots, aucun « plan de montage » : c'est ce qui rend le gateway testable **et** plus sûr.
- Le vrai risque restant n'a pas bougé : qui parle au socket Docker contrôle l'hôte. Le HostDriver ne le règle pas, il prépare le Lot 5 qui le sort du gateway.
- Un secret ne doit jamais dormir à côté de ce qu'il protège : la clé dans un secret Docker, le carnet dans un volume. Deux sauvegardes séparées.
- **Prochaines étapes** : Better Auth devant l'admin, dans le même carnet SQLite (Lot 4), le runner séparé (Lot 5).
