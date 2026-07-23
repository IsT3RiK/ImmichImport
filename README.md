# Immich Import 📥

**Vider un disque externe dans Immich, sans se tromper.**

Vous branchez un disque USB sur le NAS, vous cochez les dossiers à envoyer, vous
cliquez. L'application s'occupe du reste et vous montre le transfert en direct.

Pas de ligne de commande, pas de fichier de configuration à écrire : au premier
lancement, un **assistant** trouve votre serveur Immich tout seul et vous guide
pour créer la clé d'accès.

![L'arborescence du disque, avec les compteurs par dossier et le panneau de sélection](docs/app-arborescence.png)

---

## Le problème que ça résout

Importer un vieux disque de photos dans Immich, sans outil, ça veut dire :
ouvrir un terminal, apprendre les options d'`immich-go`, deviner les chemins,
et prier pour ne pas créer des milliers de doublons.

Ici :

- 🌲 **Vous voyez votre disque** — arborescence dépliable, avec le nombre de
  photos et vidéos par dossier (sous-dossiers compris).
- ☑️ **Vous choisissez précisément** — cases à cocher en cascade ; cochez un
  dossier entier ou juste un sous-dossier.
- 🛑 **Rien ne part sans votre clic.** Un mode simulation permet même de voir ce
  qui *serait* envoyé, sans rien envoyer.
- 🔁 **Aucun doublon** — l'envoi est délégué à
  [`immich-go`](https://github.com/simulot/immich-go), qui compare les empreintes
  des fichiers et saute ce qui est déjà dans Immich.
- ⏸️ **Débranchez sans crainte** — si le disque est retiré en plein import (ou si
  le conteneur redémarre), la progression est sauvegardée. Au rebranchement,
  l'app propose de **reprendre là où ça s'est arrêté**.
- 🌍 **5 langues** — français, English, español, Deutsch, italiano.

> ⚠️ Application **sans authentification** : à garder sur votre réseau local.

---

## Démarrage

Il vous faut un NAS (ou une machine) avec Docker, et une instance Immich.

```bash
git clone https://github.com/IsT3RiK/ImmichImport.git
cd ImmichImport
cp .env.example .env
```

Dans `.env`, une seule ligne est vraiment obligatoire : **où votre NAS monte les
disques USB**.

```bash
IMPORT_HOST_PATH=/mnt/@usb     # UGREEN UGOS Pro ; adaptez à votre NAS
IMMICH_NETWORK=immich_default  # docker network ls | grep immich
```

Puis :

```bash
docker compose up -d --build
```

Ouvrez **http://\<ip-du-nas\>:8090** — l'assistant démarre.

---

## Configuration

L'app a besoin de deux choses : **l'adresse de votre Immich** et **une clé API**.
Deux façons, au choix.

### Option A — l'assistant (recommandé)

Rien à préparer : ouvrez l'app, l'assistant fait le reste.

**1. Bienvenue** — choisissez votre langue en haut (5 disponibles).

![Écran de bienvenue de l'assistant](docs/wizard-1-bienvenue.png)

**2. Serveur** — l'app cherche Immich sur le réseau et propose ce qu'elle trouve
(nom de service Docker, machine hôte, chaque interface réseau). Sinon : saisissez
l'adresse et testez-la, ou scannez un réseau entier.

![Détection du serveur Immich sur le réseau](docs/wizard-2-serveur.png)

**3. Clé API** — un bouton ouvre la bonne page dans Immich, la liste des
permissions à cocher est affichée, et l'app **vérifie que la clé fonctionne
avant d'enregistrer quoi que ce soit**.

![Création et vérification de la clé API](docs/wizard-3-cle-api.png)

**4. Albums** — un album par dossier, selon l'arborescence, ou aucun.

![Choix du mode d'album](docs/wizard-4-albums.png)

**5. Récapitulatif** — un dernier coup d'œil, et c'est parti.

![Récapitulatif avant validation](docs/wizard-5-pret.png)

Rien n'est enregistré tant que la connexion n'a pas réellement fonctionné. Le
résultat est gardé dans le volume `/state`. Vous pouvez rouvrir l'assistant à
tout moment avec le bouton **⚙️** en haut à droite.

### Option B — variables d'environnement

Pour un déploiement figé, sans assistant. Renseignez les deux dans `.env` :

```bash
IMMICH_URL=http://immich_server:2283
IMMICH_API_KEY=votre-clé-api
```

Quand **les deux** sont définies, la connexion est verrouillée et l'assistant est
sauté. Une seule des deux n'est qu'une valeur par défaut pré-remplie.

### Clé API Immich

Dans Immich : votre avatar (en haut à droite) → **Paramètres du compte** →
**Clés API** → **Nouvelle clé API**. Le plus simple est de cocher **Select all**.
Pour une clé au périmètre minimal :

| Permission     | Rôle                                       |     |
| -------------- | ------------------------------------------ | --- |
| `asset.upload` | Envoyer les photos et vidéos               | requis |
| `asset.read`   | Éviter de renvoyer un fichier déjà présent | conseillé |
| `album.create` | Créer un album par dossier                 | conseillé |
| `album.read`   | Retrouver les albums existants             | conseillé |

La clé ne quitte jamais le serveur : le navigateur ne la voit pas.

---

## Le disque externe

> **On ne monte pas le disque, mais son dossier parent.** C'est ce qui permet de
> brancher et débrancher à chaud sans redémarrer le conteneur.

La plupart des NAS montent les USB sous un dossier parent : `/mnt/@usb` (UGREEN
UGOS Pro), `/volumeUSB*` (Synology), `/media` ou `/mnt` ailleurs. C'est ce parent
qu'on met dans `IMPORT_HOST_PATH`. Pour le trouver, en SSH :

```bash
ls /mnt/@usb/
lsblk -o NAME,MOUNTPOINT,SIZE,LABEL
```

Le disque est monté **en lecture seule** : vos fichiers sources ne peuvent pas
être modifiés.

> Si un disque branché *après* le démarrage du conteneur n'apparaît pas, lancez
> une fois côté NAS : `sudo mount --make-rshared /mnt/@usb` (adaptez le chemin).

---

## Utilisation

1. Branchez le disque : la pastille passe au vert et l'arborescence se charge.
2. Dépliez les dossiers (clic sur `▸` ou le nom), cochez ce que vous voulez
   envoyer. Le panneau de droite montre la sélection réelle.
3. *(optionnel)* Cochez **Mode simulation** pour voir ce qui serait envoyé.
4. **Importer la sélection** — les compteurs et le temps restant s'affichent en
   direct. **Annuler l'import** stoppe proprement.

Un seul import à la fois. Si vous rechargez la page ou revenez plus tard,
l'affichage se raccroche automatiquement à l'import en cours.

### Reprise après débranchement

Si le disque disparaît en cours d'import, le job s'arrête et la progression est
sauvegardée. Au rebranchement, un bandeau propose :

- **Reprendre** — ne retraite que les dossiers non terminés. Pour un dossier
  laissé à moitié, `immich-go` saute les fichiers déjà envoyés.
- **Recommencer à zéro** — oublie l'état et repart d'une nouvelle sélection.

---

## Réglages avancés

Variables d'environnement, **toutes facultatives** :

| Variable                | Défaut            | Rôle |
| ----------------------- | ----------------- | ---- |
| `IMPORT_HOST_PATH`      | —                 | Dossier **hôte** parent des disques USB (le seul réglage vraiment nécessaire). |
| `IMMICH_URL`            | —                 | Adresse d'Immich (sans `/api`). Voir [Configuration](#configuration). |
| `IMMICH_API_KEY`        | —                 | Clé API Immich. |
| `ALBUM_MODE`            | `FOLDER`          | `FOLDER` \| `PATH` \| `NONE` — choisi dans l'assistant. |
| `IMMICH_NETWORK`        | `immich_default`  | Réseau Docker de votre stack Immich. |
| `IMPORT_ROOT`           | `/import`         | Racine parcourue **dans le conteneur**. |
| `STATE_DIR`             | `/state`          | Volume **inscriptible** : configuration + progression. |
| `IMMICH_GO_EXTRA_ARGS`  | —                 | Arguments bruts ajoutés à chaque appel `immich-go`. |
| `DISK_MONITOR_INTERVAL` | `2`               | Fréquence (s) de vérification de présence du disque. |
| `PORT`                  | `8080`            | Port HTTP interne au conteneur. |

Le port publié (`8090`) se change dans `docker-compose.yml`.

---

## Sous le capot

```
Dockerfile           python:3.12-slim + binaire immich-go
docker-compose.yml   rejoint le réseau Docker d'Immich
app/
  main.py            API FastAPI (arbre, comptage, import, SSE, assistant)
  fs.py              résolution sûre des chemins, listing, comptage
  importer.py        exécution d'immich-go, suivi de progression
  settings.py        connexion : env ou assistant, persistée dans /state
  immich_check.py    découverte réseau, test de connexion, contrôle de la clé
  state.py           progression persistée (reprise après interruption)
  i18n.py            messages serveur traduits
  static/            frontend vanilla (aucun build, aucun CDN, hors-ligne)
```

Quelques garde-fous : chaque chemin est confiné sous `IMPORT_ROOT`
(anti-traversée), le disque est monté en lecture seule, le scan réseau est
limité aux plages privées, et la clé API reste côté serveur.
