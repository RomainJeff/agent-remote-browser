# Agent Computer, expliqué

## L'idée en une phrase
Chaque agent Notion reçoit un petit ordinateur jetable avec un navigateur, qu'il pilote à distance comme avec une télécommande. Les boutons de la télécommande sont les tools MCP. L'ordinateur, c'est un conteneur Docker.

## L'image mentale : la salle d'ordinateurs de la bibliothèque
- **Le guichet (`gateway.mjs`)** : l'agent montre sa carte (clé Bearer). Le bibliothécaire sait quel poste lui revient et quels sites il a le droit de visiter. Il note chaque demande dans le registre (`audit.jsonl`).
- **Le poste (conteneur `ac-<agent>`)** : Chromium + agent-browser, rien d'autre. Pas de droits root, pas de capacités Linux, 1 Go de RAM.
- **Le casier (volume `ac-profile-<agent>`)** : cookies et sessions. Le poste s'éteint après 5 min d'inactivité, mais le casier reste. Au retour de l'agent, il est toujours connecté.
- **Le trousseau (`login`)** : quand l'agent veut se connecter à un site, il demande « connecte-moi à X ». C'est le bibliothécaire qui tape le mot de passe. L'agent voit seulement « c'est fait ».

## Pourquoi `docker exec` plutôt qu'un vrai serveur MCP dans le conteneur
agent-browser sait déjà se lancer comme serveur MCP (`agent-browser mcp`). Mais il parle en stdio, alors que Notion veut du HTTP. Il aurait fallu un pont HTTP↔stdio par agent, maintenu en vie, avec la gestion des reconnexions.

`docker exec agent-browser open …` est beaucoup plus bête, et ça marche parce qu'agent-browser garde de lui-même un daemon en arrière-plan : le navigateur reste ouvert entre deux commandes. Résultat : le gateway est **stateless**. On peut le tuer et le relancer, rien ne se perd, puisque l'état vit dans le conteneur et le volume.

## Qui tient le câble réseau ?

Imagine un poste de bibliothèque dont on a débranché le câble Ethernet. Il lui reste un interphone vers le guichet. C’est ainsi que tourne Chromium. Quand une page demande une connexion, le guichet vérifie le domaine et compose lui-même l’adresse IP autorisée. Même si le domaine change de réponse DNS une seconde plus tard, la connexion part vers l’adresse vérifiée.

Quand le guichet sort un mot de passe, il ferme les connexions en cours et réserve l’interphone au site de connexion enregistré. Dans le fichier de profils, le mot de passe est chiffré. La clé est dans un autre volume Docker. Pour restaurer une sauvegarde, il faut donc retrouver les deux.

## Profils, tokens et le guichet OAuth
Un **profil**, c'est une carte de bibliothèque. Chacune a son poste, son casier, son trousseau, la liste des sites qu'on peut ouvrir avec, et son propre numéro (token `acp_`). On crée la carte dans l'admin. Ensuite on s'assoit soi-même au poste (Take control), on se connecte aux sites, et les cookies restent dans le casier. Dans le trousseau, on peut aussi déposer des identifiants que l'agent utilisera sans jamais les voir.

Le token n'est affiché qu'**une fois**. On ne garde que son empreinte (sha256), comme un mot de passe. Perdu ? On en régénère un, et l'ancien meurt avec toutes ses sessions OAuth.

**OAuth DCR**, c'est le guichet automatique. Notion arrive sans clé et se fait refouler avec un 401. La réponse lui indique où trouver le guichet (`WWW-Authenticate: resource_metadata=…`). Il s'y inscrit tout seul (`/register`, Dynamic Client Registration), puis ouvre une page qui demande « ton numéro de carte ? ». On colle le token. Notion repart avec un ticket d'1 h et un ticket de renouvellement de 30 jours. Le token d'origine ne transite jamais par Notion.

Le **token global** (`acg_`), c'est le passe du bibliothécaire en chef. Il ne donne aucun poste directement. Il permet de créer des cartes et d'**emprunter** (lease) un poste pour un temps limité, de façon exclusive. Pendant l'emprunt, la carte normale du poste est refusée. Un passe global ne révèle jamais le numéro d'une carte : sinon, une fuite du global les ferait toutes fuiter.

## Les pièges rencontrés
1. **Chrome for Testing n'existe pas en Linux ARM64.** `agent-browser install` échoue sur un Mac M-series. On installe donc le paquet `chromium` de Debian, qui marche sur arm64 comme sur amd64.
2. **Le profil Chrome ne garde pas les cookies de session.** Le site de démo utilise un cookie sans date d'expiration : on était déconnecté après chaque redémarrage du conteneur. Le fix : ajouter `--restore` d'agent-browser, qui sauvegarde cookies et localStorage toutes les 30 s et à la fermeture. Le tout est mis sur le même volume.
3. **`docker ps -q --format`** : avec `-q`, Docker ignore `--format` et renvoie des IDs au lieu de noms. Le reaper essayait donc d'arrêter `29132c7e4083`. Ça marchait par chance, puisqu'un ID est aussi accepté.
4. **Audit faussement « ok »** : un `open` refusé retournait une erreur MCP sans lever d'exception, donc le registre notait `ok: true`. Corrigé : on lit maintenant `isError`.
5. **`form.id` dans le DOM** : un `<input name="id">` dans un formulaire, c'est piégeux, car `form.id` renvoie l'attribut id du formulaire lui-même. Il faut écrire `form.elements.id`.
6. **`__proto__` comme nom de profil** : un objet JS indexé par une saisie utilisateur, c'est une porte ouverte. Les ids passent donc par une regex de slug, et les lectures par `Object.hasOwn`.

## Ce que je retiens
- Le bon « sandbox » pour un POC, c'est celui qui tourne déjà sur la machine. Docker suffit pour valider le produit. La question gVisor / Firecracker / service managé ne vient qu'avec le passage en multi-tenant.
- La sécurité tient en trois couches, chacune bête et testable : la clé au guichet, le contrôle de sortie au guichet, les secrets qui ne passent jamais par le LLM.
- OAuth côté serveur, c'est ~180 lignes sans dépendance. Ce qui compte : PKCE S256 obligatoire, codes à usage unique, redirect URIs en https, rotation du refresh.
- **Prochaine étape** : brancher un vrai agent Notion via `cloudflared` et mesurer ce que Notion supporte réellement (timeouts, images renvoyées par `screenshot`).
