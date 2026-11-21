# agent-remote-browser, expliqué

## L'idée en une phrase
Chaque agent (Notion ou autre) reçoit un petit ordinateur jetable avec un navigateur, qu'il pilote à distance comme avec une télécommande. Les boutons de la télécommande sont les tools MCP. L'ordinateur, c'est un conteneur Docker.

## L'image mentale : la salle d'ordinateurs de la bibliothèque
- **Le guichet (`src/server.ts`)** : l'agent montre sa carte (token OAuth ou clé API). Le bibliothécaire sait quel poste lui revient et quels sites il a le droit de visiter. Il note chaque demande dans le registre (`audit.jsonl`).
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

## Profils, cartes et passes
Un **profil**, c'est une place à la bibliothèque : un poste, un casier, un trousseau, une liste de sites autorisés. Jusqu'au Lot 3, chaque profil avait son numéro fixe (`acp_`), et le bibliothécaire en chef un passe global (`acg_`). Le Lot 4 a jeté ces deux trousseaux : voir plus bas.

Le **scope global**, c'est le passe du bibliothécaire en chef : il crée des profils et **emprunte** (lease) un poste pour un temps limité, de façon exclusive. Il ne révèle jamais le numéro d'une carte.

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

## Lot 4 : le videur, le badge et la carte à puce

Jusqu'ici, la porte de l'admin était « fermée » parce qu'elle donnait sur une cour privée (localhost). Et les cartes des agents étaient des numéros fixes qu'on recopiait à la main. Le Lot 4 installe un vrai service de sécurité : **Better Auth** (`1.7.27`, version figée), qui écrit dans le même carnet SQLite que le reste.

**Le gérant et son double contrôle.** Il n'y a qu'**un** humain : l'admin. Il entre avec un mot de passe **et** un code à 6 chiffres de son appli d'authentification (TOTP). C'est la porte blindée à deux serrures : voler le mot de passe ne suffit pas, il faut aussi le téléphone. Pas de formulaire d'inscription : le seul moyen de créer l'admin, c'est d'être sur la machine (`arb admin create`). La commande affiche une seule chose secrète, une fois : l'URI `otpauth://` à scanner. Tout le reste (mot de passe, secret Better Auth) ne sort jamais.

**Le guichet OAuth, version contrôlée.** Notion arrive sans carte, se fait refouler (401), lit dans la réponse où se trouve le guichet, s'inscrit tout seul (DCR) et demande une carte. Avant, il repartait directement avec. Maintenant, le guichet appelle le gérant : page `/login` (mot de passe + code), puis page `/consent` où le gérant **choisit** quel poste ce client aura le droit d'utiliser (`profile:shop`) ou s'il reçoit le passe global. Le client repart avec un ticket d'1 h (`arb_at_`) et un ticket de renouvellement de 30 jours (`arb_rt_`), mais le périmètre, c'est le gérant qui l'a écrit, pas le client.

C'est comme un hôtel : n'importe qui peut se présenter à l'accueil, mais c'est le réceptionniste qui programme la carte pour **la chambre 12**, pas le client.

**Les badges permanents (clés API).** Pour un script ou un orchestrateur, pas de navigateur pour faire le tour login/consent : l'admin crée une clé `arb_k_…` dans l'admin, avec son périmètre, affichée une fois. Révoquée dans l'onglet « Connected clients » : refusée à l'appel suivant (testé : 401).

**Les garde-fous du guichet.** Une porte ouverte au public attire les petits malins :
- inscriptions : 5 par minute par IP, 20 par heure et 1000 clients au total ; les clients qui n'ont jamais rien obtenu partent à la poubelle après 24 h ;
- login 5/min, code 5/min (et 15 min de blocage après 5 mauvais codes), consentement 10/min, token 30/min, compteurs stockés dans la base ;
- PKCE S256 obligatoire : le client qui demande la carte doit prouver que c'est bien lui qui l'a commandée.

**Le videur à l'entrée (Cloudflare Access, optionnel).** Si un jour l'admin doit être accessible hors de la machine (`ADMIN_PUBLIC=1`), on peut mettre Cloudflare Access devant. Cloudflare remet alors un bracelet signé (un JWT) à chaque visiteur. Le gateway ne fait pas confiance aveuglément : il vérifie lui-même la signature (RS256, via WebCrypto, sans bibliothèque), le public visé, l'expiration, et exige que l'email du bracelet soit celui de l'admin. Les clés publiques de Cloudflare sont gardées en cache 1 h.

**Le déménagement du carnet.** La migration `002_better_auth.sql` ajoute les 14 tables de Better Auth et supprime les anciennes (`oauth_clients`, `oauth_tokens`, `settings`, la colonne `token_hash`). C'est notre propre runner qui l'applique, jamais l'auto-migration de Better Auth : une seule source de vérité pour le schéma. Conséquence assumée : les anciens tokens meurent, les agents se reconnectent.

### Les surprises de Better Auth
1. **Pas de plugin MCP en 1.7.** Le plan en parlait ; il a été remplacé par `@better-auth/oauth-provider`, qui fait la même chose (et mieux : refresh rotatif, CIMD).
2. **Il ne redirige que les vrais navigateurs.** `/authorize` répond par une redirection 302 seulement si la requête ressemble à une navigation (`sec-fetch-mode: navigate`). Sinon, du JSON. Et le `fetch` de Node impose `sec-fetch-mode: cors`, impossible à changer : les tests passent par `http.get`.
3. **Un cookie sans Origin = 403.** Better Auth considère une requête avec cookie mais sans en-tête Origin comme suspecte. Bonne idée, mais il faut ne jamais envoyer un en-tête `cookie:` vide.
4. **Le choix du profil passe par un petit papier.** Better Auth range le consentement par « référence » ; pour lui faire porter `profile:shop`, la page de consentement glisse le choix dans une `Map` en mémoire le temps d'un appel. D'où une conséquence : chaque connexion repasse par la page de consentement (c'est voulu : le gérant choisit à chaque fois).
5. **Rejouer un code d'autorisation tue les tokens déjà émis.** Conforme à la RFC, et testé.
6. **Passkey reporté.** Le plugin existe, mais ajoutait une dépendance WebAuthn pour un seul humain qui a déjà le TOTP.

## Lot 5 : le passe-plat et le gardien du local technique

Jusqu'au Lot 4, le bibliothécaire (le gateway) avait la **clé du local technique** dans sa poche : le socket Docker. Or le bibliothécaire, c'est celui qui parle à tout le monde : agents, clients OAuth, pages web via les navigateurs. Si quelqu'un le manipule, il ressort avec la clé, et la clé du local technique ouvre tout le bâtiment (créer un conteneur qui monte `/` de l'hôte = contrôle de la machine).

Le Lot 5 lui reprend la clé et la confie à un **gardien** : le service `runner` (`src/runner/server.ts`).

- **Le gardien ne sort jamais.** Pas de réseau (`network_mode: none`), système de fichiers en lecture seule, aucune capacité Linux. Il a la clé (le socket Docker) et un **passe-plat** : un socket Unix (`/run/arb-runner/runner.sock`) sur un volume que seuls lui et le bibliothécaire montent.
- **Le passe-plat a un menu fixe.** On y glisse une fiche d'une ligne JSON : « allume le poste `shop` », « tape `snapshot -i` sur `shop` », « éteins `shop` ». Sept plats au menu (`ensure`, `exec`, `stream`, `stop`, `remove`, `list`, `copyVolume`), et la fiche ne contient **qu'un numéro de poste** et le plat. Pas de « avec telle image », pas de « en montant tel dossier ». Une fiche avec un champ en trop est refusée (zod `strictObject`), le gardien répond `invalid request` et note le refus dans ses logs.
- **Les commandes tapées sont dans un livre.** `exec` n'accepte que les phrases exactes que le bibliothécaire utilise : `agent-browser` + ses drapeaux fixes + `open <url http(s)>`, `click @e12`, `fill @e12 -- <texte>`… plus trois utilitaires (`base64` d'une capture, `rm -f` de la capture, `cat` du fichier de session). `sh -c`, `eval`, `file:///etc/passwd`, `--no-sandbox` glissé au milieu : refusés. Et chaque commande part sous `timeout -k 5` : si elle traîne, c'est le conteneur lui-même qui la tue, pas seulement le client qui raccroche.
- **Le gardien ne touche qu'aux postes étiquetés.** Chaque conteneur créé porte l'étiquette de la pile. `arb-gateway-1` a pourtant un nom qui ressemble à un poste (`gateway-1` est un id de profil valide !) : sans étiquette, refusé. Pareil pour les volumes : il ne supprime que ceux qu'il a étiquetés.

**Pourquoi pas de mot de passe sur le passe-plat ?** Le bibliothécaire devrait le garder dans sa poche : le voler revient à voler le bibliothécaire. La vraie barrière, c'est la porte : le socket est en 0600, dans un dossier 0700, appartenant à l'uid 1000, sur un volume monté par deux services seulement. Moins de code, même sécurité.

**Le proxy de sortie reste chez le bibliothécaire.** Il a besoin des listes de sites autorisés (dans `arb.db`) et du réseau. Le gardien, lui, n'a pas de réseau du tout. Le gardien se contente de monter le volume `arb-egress` en lecture seule dans chaque poste, à son sous-dossier (`Subpath = id`) : chaque poste ne voit que **son** proxy.

**Le déménagement depuis le POC.** `migrate-from-poc --apply` copie les casiers `ac-profile-<id>` vers `arb-profile-<id>`. Le bibliothécaire ne dit plus « copie ce volume-là vers celui-ci » : il dit « copie le casier POC de `shop` », et le gardien choisit lui-même la source. Mieux : par défaut, le gardien **refuse** ce plat. Il ne l'accepte que s'il a été démarré avec `ALLOW_POC_MIGRATION=1`, le temps de la migration. Sinon, un bibliothécaire manipulé pourrait aspirer les cookies de n'importe quel profil du POC.

**Les postes, eux aussi, se durcissent.** Racine en lecture seule, `/tmp` et `/home/agent` en mémoire (tmpfs), et une étiquette « empreinte de config » : si la config change, le poste est recréé (le casier, lui, reste).

**Ce qu'un bibliothécaire corrompu peut encore faire** (détail dans SECURITY.md) : piloter tous les navigateurs et lire leurs données, comme avant ; éteindre ou supprimer les postes et casiers de la pile ; allumer beaucoup de postes (chacun est limité à 1 Go et 1 CPU, mais leur nombre ne l'est pas). Ce qu'il ne peut plus faire : prendre la machine. Le gardien, lui, reste l'équivalent de l'hôte : sa surface d'attaque est une ligne JSON de 64 Ko au plus, sans réseau.

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

11. **La query string avalée.** Les routes `/api/auth/*` du listener public transmettaient le chemin sans `?client_id=…` : l'autorisation échouait sans message clair. Fix : `path + url.search`.
12. **Un profil recréé héritait d'un code en attente.** Supprimer un profil effaçait ses tokens, mais pas les codes d'autorisation pas encore échangés (rangés dans `verification`). Un profil recréé sous le même nom pouvait les récupérer. Fix : `deleteProfile` les purge aussi.
13. **Les noms de compose ressemblent à des postes.** Compose nomme ses conteneurs `arb-gateway-1` et `arb-runner-1`. Le gardien construit le nom d'un poste en `arb-<id>`, et `gateway-1` est un id valide. Sans contrôle d'étiquette, `stop gateway-1` aurait éteint le bibliothécaire. Fix : le gardien lit le conteneur avant d'y toucher et exige l'étiquette de la pile (testé en vrai : refusé).
14. **Tuer le client ne tue pas la commande.** Un `exec` qui dépasse son délai coupait la connexion côté gateway, mais le processus continuait dans le conteneur. Fix : `timeout -k 5 <s>` devant la commande, et un filet côté runner 10 s plus tard.
15. **Le sous-dossier de volume a ses conditions.** `VolumeOptions.Subpath` (monter un seul sous-dossier d'un volume nommé) demande l'API Docker 1.45 au moins, et le sous-dossier doit exister avant de créer le conteneur (le gateway le crée en y posant le socket du proxy). C'est ce qui permet au gardien de ne monter aucun chemin de l'hôte.

## Ce que je retiens
- Une interface étroite vaut mieux qu'une interface puissante. Six mots, aucun « plan de montage » : c'est ce qui rend le gateway testable **et** plus sûr.
- Qui parle au socket Docker contrôle l'hôte. Le HostDriver a préparé le terrain, le Lot 5 a sorti le socket du gateway : c'est maintenant un gardien sans réseau, avec un menu fixe, qui le tient.
- Une validation se fait du côté de celui qui a le pouvoir. Le gateway a ses propres contrôles, mais c'est le runner qui revalide tout, parce que c'est lui qu'on veut protéger d'un gateway corrompu.
- Un secret ne doit jamais dormir à côté de ce qu'il protège : la clé dans un secret Docker, le carnet dans un volume. Deux sauvegardes séparées.
- Un périmètre se donne, il ne se demande pas : le client OAuth demande « mcp », c'est le gérant qui écrit « profile:shop » sur la carte.
- **Prochaines étapes** : le tunnel nommé, Cloudflare Access en vrai et le runbook d'exploitation (Lot 6), puis la CI de bout en bout sur Linux avec gVisor, où la racine en lecture seule des postes n'a pas encore été vérifiée (Lot 7).
