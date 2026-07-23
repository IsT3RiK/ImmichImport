# Immich Import 📥

Petite web UI locale, autonome et **sans authentification** (réseau local V1),
pour **sélectionner manuellement** quels dossiers d'un disque externe monté sur
un NAS importer dans une instance **Immich** self-hosted.

L'import réel est délégué à [`immich-go`](https://github.com/simulot/immich-go)
(`upload from-folder`), qui gère nativement le **checksum** et la
**déduplication** contre les assets déjà présents dans Immich. Ce projet ne
réimplémente donc *aucune* logique de dédup côté fichiers — juste la sélection.

## Fonctionnalités

- 🌲 **Tree view** paresseux (lazy-load) de l'arborescence sous `IMPORT_ROOT`.
- 🔢 Compteurs **photos / vidéos** par dossier : non-récursif immédiat + total
  récursif (`Σ`) chargé en arrière-plan.
- ☑️ Cases à cocher **tri-state** avec cascade parent → enfants, tout en
  autorisant la sélection d'un sous-dossier précis sans cocher son parent.
- 🧹 **Déduplication de la sélection** : un enfant déjà couvert par un parent
  coché n'est pas traité deux fois (côté frontend *et* revalidé côté backend).
- ▶️ **Rien** n'est importé avant le clic sur **« Importer la sélection »**.
- ⏱️ Import **asynchrone** (background job) avec **logs live** via SSE.
- 🔒 **Anti path-traversal** : chaque chemin est résolu et confiné sous
  `IMPORT_ROOT`. Le disque est monté **read-only** (`:ro`).
- 🔌 **Détection à chaud** du disque : le dossier parent des USB est monté avec
  propagation `rslave`, et l'UI poll `/api/status` — brancher/débrancher le
  disque met à jour l'arborescence en direct, sans redémarrer ni recharger.
- ⏸️ **Import interruptible et reprenable** : si le disque est débranché en
  cours d'import (ou le container redémarre), le job s'arrête proprement et
  l'état est **persisté**. Au rebranchement, l'UI propose **Reprendre** (ne
  retraite que les dossiers restants) ou **Recommencer à zéro**.

## Architecture

```
Dockerfile           image python:3.12-slim + binaire immich-go téléchargé au build
docker-compose.yml   rejoint le réseau Docker existant d'Immich
app/
  config.py          lecture des variables d'env
  fs.py              résolution sûre des chemins, listing, comptage, dédup
  importer.py        gestionnaire de job + exécution d'immich-go (stream logs)
  state.py           persistance de la progression (reprise après interruption)
  main.py            API FastAPI (tree / count / import / jobs / SSE)
  static/            frontend vanilla (tree view, cascade, logs)
```

## Variables d'environnement

| Variable              | Défaut                          | Rôle |
| --------------------- | ------------------------------- | ---- |
| `IMPORT_ROOT`         | `/import`                       | Racine parcourable **dans le container** = dossier **parent** où le NAS monte les USB. Chaque disque branché y apparaît comme sous-dossier. |
| `IMMICH_URL`          | `http://immich_server:2283`     | URL d'Immich joignable depuis le réseau Docker. |
| `IMMICH_API_KEY`      | —                               | Clé API Immich (**obligatoire**). |
| `ALBUM_MODE`          | `FOLDER`                        | `FOLDER` \| `PATH` \| `NONE` → `--folder-as-album`. |
| `IMMICH_GO_EXTRA_ARGS`| —                               | Args bruts ajoutés à chaque appel immich-go (ex. `--dry-run`). |
| `STATE_DIR`           | `/state`                        | Dossier **writable** où la progression est persistée (reprise). Volume nommé, **jamais** le disque `:ro`. |
| `DISK_MONITOR_INTERVAL`| `2`                            | Fréquence (s) de vérification de présence du disque pendant un import. |
| `PORT`                | `8080`                          | Port HTTP interne. |

## Monter le disque externe côté NAS

> **On ne monte PAS le disque directement, mais son dossier parent.** C'est ce
> qui permet le branchement/débranchement à chaud sans redémarrer le container.

La plupart des NAS montent automatiquement les disques USB sous un dossier
parent (ex. `/mnt/@usb` sur **UGREEN UGOS Pro**, `/volumeUSB*` sur Synology,
`/media` ou `/mnt` ailleurs). C'est ce **parent** qu'on branche dans le
container via `IMPORT_HOST_PATH`, en **read-only** et avec propagation
`rslave` (déjà configuré dans `docker-compose.yml`).

1. Trouvez le dossier parent des USB de votre NAS (en SSH) :

   ```bash
   ls /mnt/@usb/                              # UGREEN UGOS Pro
   lsblk -o NAME,MOUNTPOINT,SIZE,LABEL        # voir où les disques se montent
   ```

2. Mettez ce chemin dans `IMPORT_HOST_PATH` (`.env`). Exemple UGREEN :
   `IMPORT_HOST_PATH=/mnt/@usb`.

3. Branchez le disque : il apparaît sous ce parent (ex. `/mnt/@usb/MonDisque`)
   et l'UI le détecte **automatiquement** (pastille verte + arbre rechargé).
   Aucun montage manuel n'est nécessaire si le NAS auto-monte les USB.

> ⚠️ **Propagation `rslave`** : pour qu'un disque branché *après* le démarrage
> du container soit visible, le point de montage host doit être « shared ». Sur
> la plupart des NAS c'est le cas par défaut. Si un disque branché à chaud
> n'apparaît pas, exécutez une fois côté host :
> `sudo mount --make-rshared /mnt/@usb` (adaptez le chemin).

## Démarrage

```bash
cd /path/to/ImmichImport
cp .env.example .env
# éditez .env : IMPORT_HOST_PATH, IMMICH_API_KEY, IMMICH_NETWORK...

# Trouvez le nom réseau de votre stack Immich :
docker network ls | grep immich          # ex: immich_default

docker compose up -d --build
```

Ouvrez **http://\<nas-ip\>:8090** (port hôte mappé dans `docker-compose.yml`).

### Intégrer à un compose Immich existant (snippet)

Si vous préférez ajouter le service directement dans le `docker-compose.yml`
d'Immich (même fichier, même réseau implicite), collez :

```yaml
  immich-import:
    build: ./ImmichImport          # ou image: pré-buildée
    container_name: immich-import
    restart: unless-stopped
    ports:
      - "8090:8080"
    environment:
      IMPORT_ROOT: /import
      IMMICH_URL: http://immich_server:2283
      IMMICH_API_KEY: ${IMMICH_API_KEY}
      ALBUM_MODE: FOLDER
    volumes:
      # dossier PARENT des USB (pas un disque précis), :ro + propagation rslave
      - type: bind
        source: /mnt/@usb          # UGREEN UGOS Pro ; adaptez à votre NAS
        target: /import
        read_only: true
        bind:
          propagation: rslave
      - immich-import-state:/state # writable : progression pour la reprise
    # même réseau que les autres services Immich -> pas de bloc networks à ajouter

# ... et déclarez le volume nommé au niveau racine du compose :
# volumes:
#   immich-import-state:
```

## Utilisation

1. Si aucun disque n'est branché, une bannière l'indique (pastille rouge).
   Branchez le disque externe : l'arborescence se charge automatiquement
   (pastille verte). Chaque disque apparaît comme un dossier sous la racine ;
   dépliez-les (clic sur `▸` ou le nom) pour lazy-loader sous-dossiers et
   compteurs.
2. Cochez les dossiers voulus. Cocher un parent coche ses enfants ; vous pouvez
   décocher un enfant précis (le parent passe en état intermédiaire).
3. Le panneau **Sélection** montre l'ensemble **minimal** réellement envoyé.
4. **Importer la sélection** → un job démarre, les logs d'`immich-go`
   défilent en direct. **Annuler l'import** stoppe le processus en cours.

## Reprise après débranchement

L'import est **interruptible et reprenable**, dossier par dossier :

- Un thread surveille la présence du disque (`DISK_MONITOR_INTERVAL`, 2 s par
  défaut). Si le disque **disparaît en cours d'import**, immich-go est stoppé et
  le job passe en état `interrupted`. La progression (quels dossiers sont
  `done`) est **persistée** dans le volume `/state`.
- Idem si le **container redémarre** en plein import : au redémarrage, l'état
  `running` orphelin est traité comme une interruption reprenable.
- Au **rebranchement** du disque, l'UI affiche un bandeau : combien de dossiers
  étaient déjà terminés, combien restent, et deux boutons :
  - **Reprendre** → ne relance **que les dossiers non terminés**. Pour un
    dossier laissé à moitié, immich-go recalcule les checksums et **saute les
    fichiers déjà envoyés** — donc pas de doublon ni de retéléversement.
  - **Recommencer à zéro** → jette l'état persisté ; vous refaites une sélection.

> La granularité de reprise est le **dossier** (unité de sélection). À
> l'intérieur d'un dossier, la reprise fine est assurée gratuitement par la
> déduplication par checksum d'immich-go côté serveur.

## Notes & limites (V1)

- **Un seul import à la fois** (429/409 si un job tourne déjà) — volontaire, les
  imports concurrents se battraient sur la pause des jobs Immich.
- Pas d'auth : à n'exposer que sur le LAN. Ne pas publier tel quel sur Internet.
- Le total récursif `Σ` est calculé à la volée ; sur de très gros dossiers il
  peut mettre quelques secondes à s'afficher (chargé en tâche de fond, 4 en //).
- Astuce test : mettez `IMMICH_GO_EXTRA_ARGS=--dry-run` pour valider la
  sélection sans rien téléverser.
