"use strict";

/* ============================================================================
   i18n — internationalisation hors-ligne (aucune dépendance, aucun CDN)
   --------------------------------------------------------------------------
   Expose un objet global `I18N` :
     I18N.t(key, params)   traduction + interpolation {clé}, gestion du pluriel
     I18N.n(num)           nombre localisé (séparateurs de milliers)
     I18N.bytes(num)       taille de fichier localisée (o/Ko vs B/KB)
     I18N.date(ts)         date/heure localisée (timestamp seconde ou ms)
     I18N.setLang(code)    change la langue (persistée) et notifie les abonnés
     I18N.onChange(cb)     s'abonne aux changements de langue
     I18N.applyStatic(root) applique data-i18n / -title / -aria / -html au DOM
     I18N.lang             code de langue courant
     I18N.LANGS            liste [{code, flag, label}]

   Le pluriel s'appuie sur Intl.PluralRules : une entrée peut être une chaîne
   simple, ou un objet { one, other } (catégories CLDR) sélectionné via le
   paramètre `count` (ou `n`). Les cinq langues n'utilisent que one/other.
   ========================================================================== */

(function () {
  const STORAGE_KEY = "immich_import_lang";
  const FALLBACK = "fr";

  const LANGS = [
    { code: "fr", flag: "🇫🇷", label: "Français", locale: "fr-FR" },
    { code: "en", flag: "🇬🇧", label: "English", locale: "en-GB" },
    { code: "es", flag: "🇪🇸", label: "Español", locale: "es-ES" },
    { code: "de", flag: "🇩🇪", label: "Deutsch", locale: "de-DE" },
    { code: "it", flag: "🇮🇹", label: "Italiano", locale: "it-IT" },
  ];
  const LOCALE = Object.fromEntries(LANGS.map((l) => [l.code, l.locale]));
  const BYTE_UNITS = {
    fr: ["o", "Ko", "Mo", "Go", "To", "Po"],
    en: ["B", "KB", "MB", "GB", "TB", "PB"],
    es: ["B", "KB", "MB", "GB", "TB", "PB"],
    de: ["B", "KB", "MB", "GB", "TB", "PB"],
    it: ["B", "KB", "MB", "GB", "TB", "PB"],
  };

  // --- dictionnaires ------------------------------------------------------
  // Mêmes clés dans chaque langue. Les emoji restent dans les valeurs (neutres).
  const DICT = {
    fr: {
      "app.brandSub": "Console de transfert",
      "lang.label": "Langue",

      "meta.root": "Racine",
      "meta.immich": "Immich",
      "meta.albums": "Albums",
      "meta.apiKeyMissing": "⚠ IMMICH_API_KEY manquante",

      "common.root": "&lt;racine&gt;",

      "resume.title": "Import interrompu détecté",
      "resume.resume": "Reprendre",
      "resume.discard": "Recommencer à zéro",
      "resume.simMode": "(mode simulation)",
      "resume.unknownDate": "date inconnue",
      "resume.intro": "Un import a été interrompu ({when}).",
      "resume.done": {
        one: "<b>{done}/{total}</b> dossier déjà terminé",
        other: "<b>{done}/{total}</b> dossiers déjà terminés",
      },
      "resume.remaining": {
        one: "<b>{remaining}</b> restant",
        other: "<b>{remaining}</b> restants",
      },
      "resume.more": "… +{count}",
      "resume.outro":
        "Reprendre ne retraite que les dossiers restants " +
        "(immich-go saute les fichiers déjà envoyés).",

      "tree.title": "Arborescence du disque",
      "tree.diskState": "État du disque",
      "tree.reload": "Recharger l'arborescence",
      "tree.reloadAria": "Recharger",
      // Disques sans aucune photo ni vidéo : masqués par défaut, avec
      // un lien pour les réafficher (un disque illisible compte 0 lui aussi).
      "tree.emptyHidden": {
        one: "<b>{count}</b> disque vide masqué",
        other: "<b>{count}</b> disques vides masqués",
      },
      "tree.showEmpty": "afficher",
      "tree.hideEmpty": "masquer",

      "badge.totalTitle":
        "Ce dossier et tous ses sous-dossiers : photos et vidéos qui seront importées",

      "side.title": "Sélection & transfert",
      "side.selectedLabel": "Dossiers sélectionnés",
      "selection.none": "Aucun dossier sélectionné.",
      "selection.toImport": {
        one: "<b>{count}</b> dossier à importer :",
        other: "<b>{count}</b> dossiers à importer :",
      },
      "selection.importing": {
        one: "<b>{count}</b> dossier en cours d'import :",
        other: "<b>{count}</b> dossiers en cours d'import :",
      },
      // Same list, once the job is over: the panel keeps showing what
      // was imported instead of falling back to "no folder selected".
      "selection.imported": {
        one: "<b>{count}</b> dossier du dernier import :",
        other: "<b>{count}</b> dossiers du dernier import :",
      },

      "dry.tooltip":
        "Simule l'import sans rien téléverser : immich-go affiche ce qu'il ferait, aucune modification dans Immich.",
      "dry.title": "Mode simulation (dry-run)",
      "dry.hint": "Aucune donnée n'est envoyée",

      "action.import": "Importer la sélection",
      "action.cancel": "Annuler l'import",

      "logs.summary": "Détails techniques (logs immich-go)",

      "disk.backendUnreachable": "Backend injoignable…",
      "disk.none":
        "💾 Aucun disque détecté. Branche le disque externe sur le NAS — " +
        "il apparaîtra ici automatiquement.",
      "disk.mounted": {
        one: "{count} disque monté",
        other: "{count} disques montés",
      },
      "disk.contentDetected": "Contenu détecté sous la racine",
      "disk.noneShort": "Aucun disque détecté",

      "progress.preparing": "Préparation…",
      "progress.starting": "Démarrage…",
      "progress.preparingIndex": "Préparation… (lecture de l'index Immich)",
      "live.badge": "En cours",

      "chip.uploaded": "envoyées",
      "chip.dups": "doublons",
      "chip.errors": "erreurs",
      "chip.remaining": "restantes",
      "chip.toImport": "à importer",

      "phase.index": "📥 Lecture de l'index Immich… ({pct} %)",
      "phase.albums": "📚 Lecture des albums Immich… ({count})",
      "phase.dedup": "🔎 Vérification des doublons…",
      "phase.simulating": "🧪 Simulation en cours…",
      "phase.transferring": "📤 Transfert en cours…",

      "eta.remaining": "reste ~{time}",
      "eta.rate": "≈ {rate} /s",

      "dur.h": "h",
      "dur.min": "min",
      "dur.s": "s",

      "recap.head.success": "✅ Import terminé",
      "recap.head.error": "❌ Terminé avec des erreurs",
      "recap.head.cancelled": "⏹ Import annulé",
      "recap.head.interrupted": "⏸ Import interrompu (disque débranché)",
      "recap.head.default": "Import terminé",
      "recap.simSuffix": " · 🧪 simulation",
      "recap.uploaded": "📤 Photos / vidéos envoyées",
      "recap.upgraded": "⬆️ Améliorées sur le serveur",
      "recap.dups": "🔁 Doublons ignorés",
      "recap.dupsDetail": " (serveur {server}, locaux {local})",
      "recap.unsupported": "🚫 Fichiers non supportés",
      "recap.filtered": "🙈 Écartés par un filtre",
      "recap.errors": "⚠️ Erreurs",
      // Le compteur d'erreurs ouvre la liste des fichiers concernés.
      "recap.errorsShow": "voir le détail",
      "recap.errorsHide": "masquer",
      "recap.errorsLoading": "Chargement du détail…",
      "recap.errorsNone": "Aucun détail disponible pour ces erreurs.",
      "recap.errorsMore": {
        one: "… et {count} autre, dans le journal du conteneur.",
        other: "… et {count} autres, dans le journal du conteneur.",
      },
      "recap.found": "📦 Total trouvé",
      "recap.expected": "🗂 Annoncé par l'arborescence",
      "recap.discSkipped": "🚷 Écartés avant analyse",
      "recap.discDetail": " (bannis {banned}, inconnus {unknown}, non gérés {unsupported})",
      "recap.time": "⏱ Temps de transfert",
      "recap.simNote": "🧪 Simulation : aucun fichier n'a réellement été envoyé.",

      "status.resuming": "Reprise de l'import…",
      "status.error": "Erreur : {msg}",
      "status.networkError": "Erreur réseau : {msg}",
      "status.discarded": "Import précédent abandonné. Nouvelle sélection possible.",
      "status.starting": "Démarrage…",
      "status.startingSim": "Démarrage (simulation)…",
      "status.success": "✅ Import terminé avec succès.",
      "status.cancelled": "⏹ Import annulé.",
      "status.interrupted":
        "⏸ Import interrompu (disque débranché). Rebranche le disque " +
        "pour reprendre là où on s'est arrêté.",
      "status.errorCode": "❌ Import terminé avec des erreurs (code {code}).",
      "status.live": "⏳ Import en cours — affichage en direct…",
      "status.liveSim": "⏳ Import (simulation) en cours — affichage en direct…",

      "wizard.header": "Configuration",
      "wizard.reopen": "Assistant de configuration",
      "wizard.progressAria": "Progression",
      "wizard.step.start": "Départ",
      "wizard.step.server": "Serveur",
      "wizard.step.key": "Clé",
      "wizard.step.album": "Album",
      "wizard.step.ready": "Prêt",
      "wizard.back": "retour",
      "wizard.continue": "continuer",
      "wizard.cancel": "plus tard",
      "wizard.start.title": "Trois minutes et c'est réglé.",
      "wizard.start.intro": "Cette application envoie vos dossiers de photos et vidéos vers votre serveur Immich, sans jamais renvoyer un fichier déjà présent.",
      "wizard.start.b1": "On cherche votre serveur Immich tout seul sur le réseau.",
      "wizard.start.b2": "On vous emmène directement sur la page où créer la clé d'accès.",
      "wizard.start.b3": "Vous choisissez les dossiers à importer et suivez le transfert en direct.",
      "wizard.start.cta": "commencer",
      "wizard.server.title": "Où se trouve votre Immich ?",
      "wizard.server.subtitle": "Inutile de connaître l'adresse : on regarde le réseau pour vous.",
      "wizard.server.searching": "Recherche du serveur Immich sur le réseau…",
      "wizard.server.noneFound": "Aucun serveur trouvé automatiquement. Saisissez l'adresse ci-dessous, ou lancez un scan de votre réseau.",
      "wizard.server.relaunch": "relancer la détection",
      "wizard.server.notSeen": "je ne vois pas mon serveur",
      "wizard.server.found": { one: "{n} serveur trouvé", other: "{n} serveurs trouvés" },
      "wizard.server.addr": "Adresse de votre Immich",
      "wizard.server.addrHint": "C'est l'adresse que vous tapez dans votre navigateur pour ouvrir Immich, port compris (2283 par défaut).",
      "wizard.server.addrPlaceholder": "http://192.168.1.10:2283",
      "wizard.server.test": "tester",
      "wizard.server.scanLabel": "Ou scanner un réseau entier",
      "wizard.server.scanPlaceholder": "— choisir un réseau —",
      "wizard.server.scan": "scanner",
      "wizard.server.scanHint": "Teste le port 2283 sur chaque adresse du réseau choisi. Compter une dizaine de secondes.",
      "wizard.server.kept": "Serveur retenu :",
      "wizard.server.probeFail": "Aucun serveur Immich à cette adresse",
      "wizard.server.detected": "détecté",
      "wizard.server.src.docker": "Nom de service Docker « {host} »",
      "wizard.server.src.gateway": "Machine qui héberge Docker (passerelle)",
      "wizard.server.src.dockerHost": "Machine qui héberge Docker (Docker Desktop)",
      "wizard.server.src.localhost": "Cette machine",
      "wizard.server.src.iface": "Adresse de ce conteneur ({iface})",
      "wizard.server.src.scan": "Trouvé par le scan réseau",
      "wizard.server.subnet.iface": "Réseau vu par ce conteneur ({iface})",
      "wizard.server.subnet.common": "Plage domestique courante",
      "wizard.key.title": "Créez une clé d'accès dans Immich",
      "wizard.key.subtitle": "Cette clé autorise l'application à envoyer vos photos dans Immich. Elle reste sur ce serveur et n'est jamais transmise ailleurs.",
      "wizard.key.s1": "Cliquez sur le bouton ci-dessous : Immich s'ouvre dans un nouvel onglet, directement sur la page « Clés API ».",
      "wizard.key.s2": "Cliquez sur **Nouvelle clé API**, nommez-la (par exemple « ImmichImport »), puis cochez les permissions listées plus bas avant de valider.",
      "wizard.key.s3": "Immich affiche la clé **une seule fois** : copiez-la, puis revenez ici et collez-la dans le champ.",
      "wizard.key.open": "Ouvrir la page des clés API d'Immich",
      "wizard.key.linkFail": "Le lien ne s'ouvre pas ?",
      "wizard.key.linkFailBody": "L'adresse que ce conteneur utilise pour parler à Immich n'est pas forcément celle que votre navigateur sait ouvrir. Corrigez-la ici :",
      "wizard.key.linkFailAlt": "Sinon, dans Immich : votre avatar en haut à droite → « Paramètres du compte » → « Clés API ».",
      "wizard.key.permsIntro": "Le plus simple : cochez **Select all** (tout cocher). Pour une clé au périmètre minimal, ne cochez que :",
      "wizard.key.permsNote": "Les {req} sont indispensables. Les {rec} n'affectent qu'une fonction : sans elles, la création d'albums par dossier est simplement inactive.",
      "wizard.key.required": "requis",
      "wizard.key.recommended": "conseillé",
      "perm.asset.upload": "Envoyer les photos et vidéos",
      "perm.job.create": "Mettre en pause les tâches Immich pendant l'import (clé administrateur)",
      "perm.asset.read": "Éviter de renvoyer un fichier déjà présent",
      "perm.album.create": "Créer un album par dossier",
      "perm.album.read": "Retrouver les albums existants",
      "wizard.key.paste": "Collez la clé ici",
      "wizard.key.pastePlaceholder": "clé API Immich",
      "wizard.key.verify": "vérifier",
      "wizard.key.connected": "Relié",
      "wizard.key.connectedAs": "Relié en tant que {email}",
      "wizard.key.connectedVersion": " · Immich {version}",
      "wizard.key.errKeyRejected": "Clé refusée par Immich. Vérifiez que vous avez copié la clé entière.",
      "wizard.key.errUnreachable": "Serveur injoignable. Revenez à l'étape précédente.",
      "wizard.key.errHttp": "Réponse inattendue du serveur (code {detail}).",
      "check.account.label": "Clé valide — accès au compte",
      "check.account.hint": "vérifiez que la clé est complète et active",
      "check.albums.label": "Lire les albums — album.read",
      "check.albums.hint": "sans elle, les albums par dossier ne seront pas créés",
      "check.jobs.label": "Piloter les tâches Immich — job.create (admin)",
      "check.jobs.hint": "sans elle, immich-go refuse de démarrer l'import",
      "check.granted": "accordée",
      "check.missing": "manquante — {hint}",
      "check.unknown": "non vérifiable",
      "wizard.album.title": "Comment ranger les photos importées ?",
      "wizard.album.subtitle": "immich-go peut créer des albums à partir de vos dossiers. Ce choix est modifiable plus tard.",
      "wizard.album.folder.title": "Un album par dossier",
      "wizard.album.folder.detail": "Chaque dossier importé devient un album du même nom.",
      "wizard.album.path.title": "Albums selon l'arborescence",
      "wizard.album.path.detail": "Reproduit tout le chemin des dossiers dans le nom des albums.",
      "wizard.album.none.title": "Sans album",
      "wizard.album.none.detail": "Importe les photos sans créer d'album.",
      "wizard.album.recommended": "conseillé",
      "wizard.ready.title": "Tout est prêt.",
      "wizard.ready.server": "Serveur",
      "wizard.ready.account": "Compte",
      "wizard.ready.albums": "Albums",
      "wizard.ready.note": "Prochaine étape : l'application liste les dossiers de votre disque. Cochez ceux à importer, puis lancez le transfert — vous le suivez en direct, et rien n'est envoyé tant que vous n'avez pas lancé l'import.",
      "wizard.ready.cta": "ouvrir l'application",
      "wizard.ready.saving": "enregistrement…",
      "wizard.ready.failed": "Impossible d'enregistrer : {error}",
    },

    en: {
      "app.brandSub": "Transfer console",
      "lang.label": "Language",

      "meta.root": "Root",
      "meta.immich": "Immich",
      "meta.albums": "Albums",
      "meta.apiKeyMissing": "⚠ IMMICH_API_KEY missing",

      "common.root": "&lt;root&gt;",

      "resume.title": "Interrupted import detected",
      "resume.resume": "Resume",
      "resume.discard": "Start over",
      "resume.simMode": "(simulation mode)",
      "resume.unknownDate": "unknown date",
      "resume.intro": "An import was interrupted ({when}).",
      "resume.done": {
        one: "<b>{done}/{total}</b> folder already finished",
        other: "<b>{done}/{total}</b> folders already finished",
      },
      "resume.remaining": {
        one: "<b>{remaining}</b> remaining",
        other: "<b>{remaining}</b> remaining",
      },
      "resume.more": "… +{count}",
      "resume.outro":
        "Resuming only reprocesses the remaining folders " +
        "(immich-go skips files already uploaded).",

      "tree.title": "Disk tree",
      "tree.diskState": "Disk status",
      "tree.reload": "Reload the tree",
      "tree.reloadAria": "Reload",
      // Disques sans aucune photo ni vidéo : masqués par défaut, avec
      // un lien pour les réafficher (un disque illisible compte 0 lui aussi).
      "tree.emptyHidden": {
        one: "<b>{count}</b> empty disk hidden",
        other: "<b>{count}</b> empty disks hidden",
      },
      "tree.showEmpty": "show",
      "tree.hideEmpty": "hide",

      "badge.totalTitle":
        "This folder and all its subfolders: photos and videos that will be imported",

      "side.title": "Selection & transfer",
      "side.selectedLabel": "Selected folders",
      "selection.none": "No folder selected.",
      "selection.toImport": {
        one: "<b>{count}</b> folder to import:",
        other: "<b>{count}</b> folders to import:",
      },
      "selection.importing": {
        one: "<b>{count}</b> folder being imported:",
        other: "<b>{count}</b> folders being imported:",
      },
      // Same list, once the job is over: the panel keeps showing what
      // was imported instead of falling back to "no folder selected".
      "selection.imported": {
        one: "<b>{count}</b> folder from the last import:",
        other: "<b>{count}</b> folders from the last import:",
      },

      "dry.tooltip":
        "Simulates the import without uploading anything: immich-go shows what it would do, no change in Immich.",
      "dry.title": "Simulation mode (dry-run)",
      "dry.hint": "No data is sent",

      "action.import": "Import the selection",
      "action.cancel": "Cancel import",

      "logs.summary": "Technical details (immich-go logs)",

      "disk.backendUnreachable": "Backend unreachable…",
      "disk.none":
        "💾 No disk detected. Plug the external disk into the NAS — " +
        "it will appear here automatically.",
      "disk.mounted": {
        one: "{count} disk mounted",
        other: "{count} disks mounted",
      },
      "disk.contentDetected": "Content detected under the root",
      "disk.noneShort": "No disk detected",

      "progress.preparing": "Preparing…",
      "progress.starting": "Starting…",
      "progress.preparingIndex": "Preparing… (reading the Immich index)",
      "live.badge": "Running",

      "chip.uploaded": "sent",
      "chip.dups": "duplicates",
      "chip.errors": "errors",
      "chip.remaining": "remaining",
      "chip.toImport": "to import",

      "phase.index": "📥 Reading the Immich index… ({pct}%)",
      "phase.albums": "📚 Reading the Immich albums… ({count})",
      "phase.dedup": "🔎 Checking for duplicates…",
      "phase.simulating": "🧪 Simulation in progress…",
      "phase.transferring": "📤 Transfer in progress…",

      "eta.remaining": "~{time} left",
      "eta.rate": "≈ {rate} /s",

      "dur.h": "h",
      "dur.min": "min",
      "dur.s": "s",

      "recap.head.success": "✅ Import finished",
      "recap.head.error": "❌ Finished with errors",
      "recap.head.cancelled": "⏹ Import cancelled",
      "recap.head.interrupted": "⏸ Import interrupted (disk unplugged)",
      "recap.head.default": "Import finished",
      "recap.simSuffix": " · 🧪 simulation",
      "recap.uploaded": "📤 Photos / videos sent",
      "recap.upgraded": "⬆️ Upgraded on the server",
      "recap.dups": "🔁 Duplicates skipped",
      "recap.dupsDetail": " (server {server}, local {local})",
      "recap.unsupported": "🚫 Unsupported files",
      "recap.filtered": "🙈 Skipped by a filter",
      "recap.errors": "⚠️ Errors",
      // Le compteur d'erreurs ouvre la liste des fichiers concernés.
      "recap.errorsShow": "see details",
      "recap.errorsHide": "hide",
      "recap.errorsLoading": "Loading details…",
      "recap.errorsNone": "No details available for these errors.",
      "recap.errorsMore": {
        one: "… and {count} more, in the container log.",
        other: "… and {count} more, in the container log.",
      },
      "recap.found": "📦 Total found",
      "recap.expected": "🗂 Announced by the tree",
      "recap.discSkipped": "🚷 Skipped before analysis",
      "recap.discDetail": " (banned {banned}, unknown {unknown}, unsupported {unsupported})",
      "recap.time": "⏱ Transfer time",
      "recap.simNote": "🧪 Simulation: no file was actually sent.",

      "status.resuming": "Resuming import…",
      "status.error": "Error: {msg}",
      "status.networkError": "Network error: {msg}",
      "status.discarded": "Previous import discarded. New selection possible.",
      "status.starting": "Starting…",
      "status.startingSim": "Starting (simulation)…",
      "status.success": "✅ Import completed successfully.",
      "status.cancelled": "⏹ Import cancelled.",
      "status.interrupted":
        "⏸ Import interrupted (disk unplugged). Plug the disk back in " +
        "to resume where it stopped.",
      "status.errorCode": "❌ Import finished with errors (code {code}).",
      "status.live": "⏳ Import in progress — live view…",
      "status.liveSim": "⏳ Import (simulation) in progress — live view…",

      "wizard.header": "Setup",
      "wizard.reopen": "Setup assistant",
      "wizard.progressAria": "Progress",
      "wizard.step.start": "Start",
      "wizard.step.server": "Server",
      "wizard.step.key": "Key",
      "wizard.step.album": "Albums",
      "wizard.step.ready": "Ready",
      "wizard.back": "back",
      "wizard.continue": "continue",
      "wizard.cancel": "later",
      "wizard.start.title": "Three minutes and you're set.",
      "wizard.start.intro": "This app uploads your photo and video folders to your Immich server, never re-sending a file that's already there.",
      "wizard.start.b1": "We find your Immich server on the network by ourselves.",
      "wizard.start.b2": "We take you straight to the page where you create the access key.",
      "wizard.start.b3": "You pick the folders to import and watch the transfer live.",
      "wizard.start.cta": "get started",
      "wizard.server.title": "Where is your Immich?",
      "wizard.server.subtitle": "No need to know the address: we look at the network for you.",
      "wizard.server.searching": "Searching for the Immich server on the network…",
      "wizard.server.noneFound": "No server found automatically. Enter the address below, or run a scan of your network.",
      "wizard.server.relaunch": "run detection again",
      "wizard.server.notSeen": "I don't see my server",
      "wizard.server.found": { one: "{n} server found", other: "{n} servers found" },
      "wizard.server.addr": "Your Immich address",
      "wizard.server.addrHint": "It's the address you type in your browser to open Immich, port included (2283 by default).",
      "wizard.server.addrPlaceholder": "http://192.168.1.10:2283",
      "wizard.server.test": "test",
      "wizard.server.scanLabel": "Or scan a whole network",
      "wizard.server.scanPlaceholder": "— choose a network —",
      "wizard.server.scan": "scan",
      "wizard.server.scanHint": "Tests port 2283 on every address of the chosen network. Expect around ten seconds.",
      "wizard.server.kept": "Selected server:",
      "wizard.server.probeFail": "No Immich server at this address",
      "wizard.server.detected": "detected",
      "wizard.server.src.docker": "Docker service name “{host}”",
      "wizard.server.src.gateway": "Docker host machine (gateway)",
      "wizard.server.src.dockerHost": "Docker host machine (Docker Desktop)",
      "wizard.server.src.localhost": "This machine",
      "wizard.server.src.iface": "This container's address ({iface})",
      "wizard.server.src.scan": "Found by the network scan",
      "wizard.server.subnet.iface": "Network seen by this container ({iface})",
      "wizard.server.subnet.common": "Common home range",
      "wizard.key.title": "Create an access key in Immich",
      "wizard.key.subtitle": "This key lets the app upload your photos to Immich. It stays on this server and is never sent anywhere else.",
      "wizard.key.s1": "Click the button below: Immich opens in a new tab, straight to the “API Keys” page.",
      "wizard.key.s2": "Click **New API Key**, name it (for example “ImmichImport”), then tick the permissions listed below before confirming.",
      "wizard.key.s3": "Immich shows the key **only once**: copy it, then come back here and paste it in the field.",
      "wizard.key.open": "Open Immich's API keys page",
      "wizard.key.linkFail": "Link won't open?",
      "wizard.key.linkFailBody": "The address this container uses to talk to Immich isn't necessarily the one your browser can open. Fix it here:",
      "wizard.key.linkFailAlt": "Otherwise, in Immich: your avatar top right → “Account Settings” → “API Keys”.",
      "wizard.key.permsIntro": "Easiest: tick **Select all**. For a minimal-scope key, tick only:",
      "wizard.key.permsNote": "The {req} ones are essential. The {rec} ones only affect one feature: without them, creating an album per folder is simply inactive.",
      "wizard.key.required": "required",
      "wizard.key.recommended": "recommended",
      "perm.asset.upload": "Upload photos and videos",
      "perm.job.create": "Pause Immich's jobs during the import (administrator key)",
      "perm.asset.read": "Avoid re-sending a file already there",
      "perm.album.create": "Create one album per folder",
      "perm.album.read": "Find existing albums",
      "wizard.key.paste": "Paste the key here",
      "wizard.key.pastePlaceholder": "Immich API key",
      "wizard.key.verify": "verify",
      "wizard.key.connected": "Connected",
      "wizard.key.connectedAs": "Connected as {email}",
      "wizard.key.connectedVersion": " · Immich {version}",
      "wizard.key.errKeyRejected": "Key rejected by Immich. Make sure you copied the whole key.",
      "wizard.key.errUnreachable": "Server unreachable. Go back to the previous step.",
      "wizard.key.errHttp": "Unexpected server response (code {detail}).",
      "check.account.label": "Valid key — account access",
      "check.account.hint": "check that the key is complete and active",
      "check.albums.label": "Read albums — album.read",
      "check.albums.hint": "without it, per-folder albums won't be created",
      "check.jobs.label": "Control Immich jobs — job.create (admin)",
      "check.jobs.hint": "without it, immich-go refuses to start the import",
      "check.granted": "granted",
      "check.missing": "missing — {hint}",
      "check.unknown": "not verifiable",
      "wizard.album.title": "How to arrange imported photos?",
      "wizard.album.subtitle": "immich-go can create albums from your folders. You can change this later.",
      "wizard.album.folder.title": "One album per folder",
      "wizard.album.folder.detail": "Each imported folder becomes an album with the same name.",
      "wizard.album.path.title": "Albums from the folder tree",
      "wizard.album.path.detail": "Reflects the whole folder path in the album names.",
      "wizard.album.none.title": "No album",
      "wizard.album.none.detail": "Imports the photos without creating an album.",
      "wizard.album.recommended": "recommended",
      "wizard.ready.title": "All set.",
      "wizard.ready.server": "Server",
      "wizard.ready.account": "Account",
      "wizard.ready.albums": "Albums",
      "wizard.ready.note": "Next: the app lists the folders on your disk. Tick the ones to import, then start the transfer — you follow it live, and nothing is sent until you start the import.",
      "wizard.ready.cta": "open the app",
      "wizard.ready.saving": "saving…",
      "wizard.ready.failed": "Could not save: {error}",
    },

    es: {
      "app.brandSub": "Consola de transferencia",
      "lang.label": "Idioma",

      "meta.root": "Raíz",
      "meta.immich": "Immich",
      "meta.albums": "Álbumes",
      "meta.apiKeyMissing": "⚠ Falta IMMICH_API_KEY",

      "common.root": "&lt;raíz&gt;",

      "resume.title": "Importación interrumpida detectada",
      "resume.resume": "Reanudar",
      "resume.discard": "Empezar de nuevo",
      "resume.simMode": "(modo simulación)",
      "resume.unknownDate": "fecha desconocida",
      "resume.intro": "Una importación se interrumpió ({when}).",
      "resume.done": {
        one: "<b>{done}/{total}</b> carpeta ya terminada",
        other: "<b>{done}/{total}</b> carpetas ya terminadas",
      },
      "resume.remaining": {
        one: "<b>{remaining}</b> restante",
        other: "<b>{remaining}</b> restantes",
      },
      "resume.more": "… +{count}",
      "resume.outro":
        "Reanudar solo reprocesa las carpetas restantes " +
        "(immich-go omite los archivos ya enviados).",

      "tree.title": "Árbol del disco",
      "tree.diskState": "Estado del disco",
      "tree.reload": "Recargar el árbol",
      "tree.reloadAria": "Recargar",
      // Disques sans aucune photo ni vidéo : masqués par défaut, avec
      // un lien pour les réafficher (un disque illisible compte 0 lui aussi).
      "tree.emptyHidden": {
        one: "<b>{count}</b> disco vacío oculto",
        other: "<b>{count}</b> discos vacíos ocultos",
      },
      "tree.showEmpty": "mostrar",
      "tree.hideEmpty": "ocultar",

      "badge.totalTitle":
        "Esta carpeta y todas sus subcarpetas: fotos y vídeos que se importarán",

      "side.title": "Selección y transferencia",
      "side.selectedLabel": "Carpetas seleccionadas",
      "selection.none": "Ninguna carpeta seleccionada.",
      "selection.toImport": {
        one: "<b>{count}</b> carpeta para importar:",
        other: "<b>{count}</b> carpetas para importar:",
      },
      "selection.importing": {
        one: "<b>{count}</b> carpeta importándose:",
        other: "<b>{count}</b> carpetas importándose:",
      },
      // Same list, once the job is over: the panel keeps showing what
      // was imported instead of falling back to "no folder selected".
      "selection.imported": {
        one: "<b>{count}</b> carpeta de la última importación:",
        other: "<b>{count}</b> carpetas de la última importación:",
      },

      "dry.tooltip":
        "Simula la importación sin subir nada: immich-go muestra lo que haría, sin cambios en Immich.",
      "dry.title": "Modo simulación (dry-run)",
      "dry.hint": "No se envía ningún dato",

      "action.import": "Importar la selección",
      "action.cancel": "Cancelar importación",

      "logs.summary": "Detalles técnicos (registros de immich-go)",

      "disk.backendUnreachable": "Backend inaccesible…",
      "disk.none":
        "💾 Ningún disco detectado. Conecta el disco externo al NAS — " +
        "aparecerá aquí automáticamente.",
      "disk.mounted": {
        one: "{count} disco montado",
        other: "{count} discos montados",
      },
      "disk.contentDetected": "Contenido detectado bajo la raíz",
      "disk.noneShort": "Ningún disco detectado",

      "progress.preparing": "Preparando…",
      "progress.starting": "Iniciando…",
      "progress.preparingIndex": "Preparando… (leyendo el índice de Immich)",
      "live.badge": "En curso",

      "chip.uploaded": "enviadas",
      "chip.dups": "duplicados",
      "chip.errors": "errores",
      "chip.remaining": "restantes",
      "chip.toImport": "a importar",

      "phase.index": "📥 Leyendo el índice de Immich… ({pct} %)",
      "phase.albums": "📚 Leyendo los álbumes de Immich… ({count})",
      "phase.dedup": "🔎 Comprobando duplicados…",
      "phase.simulating": "🧪 Simulación en curso…",
      "phase.transferring": "📤 Transferencia en curso…",

      "eta.remaining": "quedan ~{time}",
      "eta.rate": "≈ {rate} /s",

      "dur.h": "h",
      "dur.min": "min",
      "dur.s": "s",

      "recap.head.success": "✅ Importación finalizada",
      "recap.head.error": "❌ Finalizada con errores",
      "recap.head.cancelled": "⏹ Importación cancelada",
      "recap.head.interrupted": "⏸ Importación interrumpida (disco desconectado)",
      "recap.head.default": "Importación finalizada",
      "recap.simSuffix": " · 🧪 simulación",
      "recap.uploaded": "📤 Fotos / vídeos enviados",
      "recap.upgraded": "⬆️ Mejorados en el servidor",
      "recap.dups": "🔁 Duplicados omitidos",
      "recap.dupsDetail": " (servidor {server}, locales {local})",
      "recap.unsupported": "🚫 Archivos no compatibles",
      "recap.filtered": "🙈 Descartados por un filtro",
      "recap.errors": "⚠️ Errores",
      // Le compteur d'erreurs ouvre la liste des fichiers concernés.
      "recap.errorsShow": "ver detalle",
      "recap.errorsHide": "ocultar",
      "recap.errorsLoading": "Cargando el detalle…",
      "recap.errorsNone": "No hay detalles disponibles para estos errores.",
      "recap.errorsMore": {
        one: "… y {count} más, en el registro del contenedor.",
        other: "… y {count} más, en el registro del contenedor.",
      },
      "recap.found": "📦 Total encontrado",
      "recap.expected": "🗂 Anunciado por el árbol",
      "recap.discSkipped": "🚷 Descartados antes del análisis",
      "recap.discDetail": " (prohibidos {banned}, desconocidos {unknown}, no admitidos {unsupported})",
      "recap.time": "⏱ Tiempo de transferencia",
      "recap.simNote": "🧪 Simulación: no se envió ningún archivo realmente.",

      "status.resuming": "Reanudando la importación…",
      "status.error": "Error: {msg}",
      "status.networkError": "Error de red: {msg}",
      "status.discarded": "Importación anterior descartada. Nueva selección posible.",
      "status.starting": "Iniciando…",
      "status.startingSim": "Iniciando (simulación)…",
      "status.success": "✅ Importación completada con éxito.",
      "status.cancelled": "⏹ Importación cancelada.",
      "status.interrupted":
        "⏸ Importación interrumpida (disco desconectado). Vuelve a conectar el disco " +
        "para reanudar donde se detuvo.",
      "status.errorCode": "❌ Importación finalizada con errores (código {code}).",
      "status.live": "⏳ Importación en curso — vista en directo…",
      "status.liveSim": "⏳ Importación (simulación) en curso — vista en directo…",

      "wizard.header": "Configuración",
      "wizard.reopen": "Asistente de configuración",
      "wizard.progressAria": "Progreso",
      "wizard.step.start": "Inicio",
      "wizard.step.server": "Servidor",
      "wizard.step.key": "Clave",
      "wizard.step.album": "Álbumes",
      "wizard.step.ready": "Listo",
      "wizard.back": "atrás",
      "wizard.continue": "continuar",
      "wizard.cancel": "más tarde",
      "wizard.start.title": "Tres minutos y listo.",
      "wizard.start.intro": "Esta aplicación envía tus carpetas de fotos y vídeos a tu servidor Immich, sin volver a enviar nunca un archivo que ya está ahí.",
      "wizard.start.b1": "Buscamos tu servidor Immich solos en la red.",
      "wizard.start.b2": "Te llevamos directamente a la página donde crear la clave de acceso.",
      "wizard.start.b3": "Eliges las carpetas a importar y sigues la transferencia en directo.",
      "wizard.start.cta": "empezar",
      "wizard.server.title": "¿Dónde está tu Immich?",
      "wizard.server.subtitle": "No hace falta conocer la dirección: miramos la red por ti.",
      "wizard.server.searching": "Buscando el servidor Immich en la red…",
      "wizard.server.noneFound": "No se encontró ningún servidor automáticamente. Escribe la dirección abajo, o lanza un escaneo de tu red.",
      "wizard.server.relaunch": "reiniciar la detección",
      "wizard.server.notSeen": "no veo mi servidor",
      "wizard.server.found": { one: "{n} servidor encontrado", other: "{n} servidores encontrados" },
      "wizard.server.addr": "Dirección de tu Immich",
      "wizard.server.addrHint": "Es la dirección que escribes en tu navegador para abrir Immich, con el puerto (2283 por defecto).",
      "wizard.server.addrPlaceholder": "http://192.168.1.10:2283",
      "wizard.server.test": "probar",
      "wizard.server.scanLabel": "O escanear una red entera",
      "wizard.server.scanPlaceholder": "— elegir una red —",
      "wizard.server.scan": "escanear",
      "wizard.server.scanHint": "Prueba el puerto 2283 en cada dirección de la red elegida. Cuenta unos diez segundos.",
      "wizard.server.kept": "Servidor seleccionado:",
      "wizard.server.probeFail": "Ningún servidor Immich en esta dirección",
      "wizard.server.detected": "detectado",
      "wizard.server.src.docker": "Nombre de servicio Docker «{host}»",
      "wizard.server.src.gateway": "Máquina anfitriona de Docker (puerta de enlace)",
      "wizard.server.src.dockerHost": "Máquina anfitriona de Docker (Docker Desktop)",
      "wizard.server.src.localhost": "Esta máquina",
      "wizard.server.src.iface": "Dirección de este contenedor ({iface})",
      "wizard.server.src.scan": "Encontrado por el escaneo de red",
      "wizard.server.subnet.iface": "Red vista por este contenedor ({iface})",
      "wizard.server.subnet.common": "Rango doméstico común",
      "wizard.key.title": "Crea una clave de acceso en Immich",
      "wizard.key.subtitle": "Esta clave autoriza a la aplicación a subir tus fotos a Immich. Permanece en este servidor y no se transmite a ningún otro sitio.",
      "wizard.key.s1": "Haz clic en el botón de abajo: Immich se abre en una pestaña nueva, directamente en la página «Claves API».",
      "wizard.key.s2": "Haz clic en **Nueva clave API**, ponle nombre (por ejemplo «ImmichImport»), y marca los permisos listados abajo antes de validar.",
      "wizard.key.s3": "Immich muestra la clave **una sola vez**: cópiala, vuelve aquí y pégala en el campo.",
      "wizard.key.open": "Abrir la página de claves API de Immich",
      "wizard.key.linkFail": "¿El enlace no se abre?",
      "wizard.key.linkFailBody": "La dirección que este contenedor usa para hablar con Immich no es necesariamente la que tu navegador puede abrir. Corrígela aquí:",
      "wizard.key.linkFailAlt": "Si no, en Immich: tu avatar arriba a la derecha → «Ajustes de la cuenta» → «Claves API».",
      "wizard.key.permsIntro": "Lo más fácil: marca **Select all** (marcar todo). Para una clave de alcance mínimo, marca solo:",
      "wizard.key.permsNote": "Los {req} son imprescindibles. Los {rec} solo afectan a una función: sin ellos, la creación de un álbum por carpeta simplemente queda inactiva.",
      "wizard.key.required": "obligatorio",
      "wizard.key.recommended": "recomendado",
      "perm.asset.upload": "Subir fotos y vídeos",
      "perm.job.create": "Pausar las tareas de Immich durante la importación (clave de administrador)",
      "perm.asset.read": "Evitar reenviar un archivo ya presente",
      "perm.album.create": "Crear un álbum por carpeta",
      "perm.album.read": "Encontrar los álbumes existentes",
      "wizard.key.paste": "Pega la clave aquí",
      "wizard.key.pastePlaceholder": "clave API de Immich",
      "wizard.key.verify": "verificar",
      "wizard.key.connected": "Conectado",
      "wizard.key.connectedAs": "Conectado como {email}",
      "wizard.key.connectedVersion": " · Immich {version}",
      "wizard.key.errKeyRejected": "Clave rechazada por Immich. Asegúrate de haber copiado la clave completa.",
      "wizard.key.errUnreachable": "Servidor inaccesible. Vuelve al paso anterior.",
      "wizard.key.errHttp": "Respuesta inesperada del servidor (código {detail}).",
      "check.account.label": "Clave válida — acceso a la cuenta",
      "check.account.hint": "comprueba que la clave está completa y activa",
      "check.albums.label": "Leer los álbumes — album.read",
      "check.albums.hint": "sin ella, no se crearán los álbumes por carpeta",
      "check.jobs.label": "Controlar las tareas de Immich — job.create (admin)",
      "check.jobs.hint": "sin ella, immich-go se niega a iniciar la importación",
      "check.granted": "concedido",
      "check.missing": "falta — {hint}",
      "check.unknown": "no verificable",
      "wizard.album.title": "¿Cómo ordenar las fotos importadas?",
      "wizard.album.subtitle": "immich-go puede crear álbumes a partir de tus carpetas. Podrás cambiarlo más tarde.",
      "wizard.album.folder.title": "Un álbum por carpeta",
      "wizard.album.folder.detail": "Cada carpeta importada se convierte en un álbum con el mismo nombre.",
      "wizard.album.path.title": "Álbumes según el árbol de carpetas",
      "wizard.album.path.detail": "Refleja toda la ruta de carpetas en los nombres de los álbumes.",
      "wizard.album.none.title": "Sin álbum",
      "wizard.album.none.detail": "Importa las fotos sin crear ningún álbum.",
      "wizard.album.recommended": "recomendado",
      "wizard.ready.title": "Todo listo.",
      "wizard.ready.server": "Servidor",
      "wizard.ready.account": "Cuenta",
      "wizard.ready.albums": "Álbumes",
      "wizard.ready.note": "Siguiente: la aplicación lista las carpetas de tu disco. Marca las que importar y lanza la transferencia — la sigues en directo, y no se envía nada hasta que inicies la importación.",
      "wizard.ready.cta": "abrir la aplicación",
      "wizard.ready.saving": "guardando…",
      "wizard.ready.failed": "No se pudo guardar: {error}",
    },

    de: {
      "app.brandSub": "Transferkonsole",
      "lang.label": "Sprache",

      "meta.root": "Wurzel",
      "meta.immich": "Immich",
      "meta.albums": "Alben",
      "meta.apiKeyMissing": "⚠ IMMICH_API_KEY fehlt",

      "common.root": "&lt;Wurzel&gt;",

      "resume.title": "Unterbrochener Import erkannt",
      "resume.resume": "Fortsetzen",
      "resume.discard": "Neu beginnen",
      "resume.simMode": "(Simulationsmodus)",
      "resume.unknownDate": "unbekanntes Datum",
      "resume.intro": "Ein Import wurde unterbrochen ({when}).",
      "resume.done": {
        one: "<b>{done}/{total}</b> Ordner bereits abgeschlossen",
        other: "<b>{done}/{total}</b> Ordner bereits abgeschlossen",
      },
      "resume.remaining": {
        one: "<b>{remaining}</b> verbleibend",
        other: "<b>{remaining}</b> verbleibend",
      },
      "resume.more": "… +{count}",
      "resume.outro":
        "Beim Fortsetzen werden nur die verbleibenden Ordner erneut verarbeitet " +
        "(immich-go überspringt bereits hochgeladene Dateien).",

      "tree.title": "Datenträger-Baum",
      "tree.diskState": "Datenträger-Status",
      "tree.reload": "Baum neu laden",
      "tree.reloadAria": "Neu laden",
      // Disques sans aucune photo ni vidéo : masqués par défaut, avec
      // un lien pour les réafficher (un disque illisible compte 0 lui aussi).
      "tree.emptyHidden": {
        one: "<b>{count}</b> leerer Datenträger ausgeblendet",
        other: "<b>{count}</b> leere Datenträger ausgeblendet",
      },
      "tree.showEmpty": "anzeigen",
      "tree.hideEmpty": "ausblenden",

      "badge.totalTitle":
        "Dieser Ordner und alle Unterordner: Fotos und Videos, die importiert werden",

      "side.title": "Auswahl & Transfer",
      "side.selectedLabel": "Ausgewählte Ordner",
      "selection.none": "Kein Ordner ausgewählt.",
      "selection.toImport": {
        one: "<b>{count}</b> zu importierender Ordner:",
        other: "<b>{count}</b> zu importierende Ordner:",
      },
      "selection.importing": {
        one: "<b>{count}</b> Ordner wird importiert:",
        other: "<b>{count}</b> Ordner werden importiert:",
      },
      // Same list, once the job is over: the panel keeps showing what
      // was imported instead of falling back to "no folder selected".
      "selection.imported": {
        one: "<b>{count}</b> Ordner aus dem letzten Import:",
        other: "<b>{count}</b> Ordner aus dem letzten Import:",
      },

      "dry.tooltip":
        "Simuliert den Import, ohne etwas hochzuladen: immich-go zeigt, was es tun würde, keine Änderung in Immich.",
      "dry.title": "Simulationsmodus (Dry-Run)",
      "dry.hint": "Es werden keine Daten gesendet",

      "action.import": "Auswahl importieren",
      "action.cancel": "Import abbrechen",

      "logs.summary": "Technische Details (immich-go-Protokoll)",

      "disk.backendUnreachable": "Backend nicht erreichbar…",
      "disk.none":
        "💾 Kein Datenträger erkannt. Schließe den externen Datenträger an das NAS an — " +
        "er erscheint hier automatisch.",
      "disk.mounted": {
        one: "{count} Datenträger eingebunden",
        other: "{count} Datenträger eingebunden",
      },
      "disk.contentDetected": "Inhalt unter der Wurzel erkannt",
      "disk.noneShort": "Kein Datenträger erkannt",

      "progress.preparing": "Vorbereitung…",
      "progress.starting": "Wird gestartet…",
      "progress.preparingIndex": "Vorbereitung… (Immich-Index wird gelesen)",
      "live.badge": "Läuft",

      "chip.uploaded": "gesendet",
      "chip.dups": "Duplikate",
      "chip.errors": "Fehler",
      "chip.remaining": "verbleibend",
      "chip.toImport": "zu importieren",

      "phase.index": "📥 Immich-Index wird gelesen… ({pct} %)",
      "phase.albums": "📚 Immich-Alben werden gelesen… ({count})",
      "phase.dedup": "🔎 Prüfung auf Duplikate…",
      "phase.simulating": "🧪 Simulation läuft…",
      "phase.transferring": "📤 Transfer läuft…",

      "eta.remaining": "noch ~{time}",
      "eta.rate": "≈ {rate} /s",

      "dur.h": "Std",
      "dur.min": "Min",
      "dur.s": "s",

      "recap.head.success": "✅ Import abgeschlossen",
      "recap.head.error": "❌ Mit Fehlern abgeschlossen",
      "recap.head.cancelled": "⏹ Import abgebrochen",
      "recap.head.interrupted": "⏸ Import unterbrochen (Datenträger getrennt)",
      "recap.head.default": "Import abgeschlossen",
      "recap.simSuffix": " · 🧪 Simulation",
      "recap.uploaded": "📤 Fotos / Videos gesendet",
      "recap.upgraded": "⬆️ Auf dem Server verbessert",
      "recap.dups": "🔁 Übersprungene Duplikate",
      "recap.dupsDetail": " (Server {server}, lokal {local})",
      "recap.unsupported": "🚫 Nicht unterstützte Dateien",
      "recap.filtered": "🙈 Durch einen Filter ausgeschlossen",
      "recap.errors": "⚠️ Fehler",
      // Le compteur d'erreurs ouvre la liste des fichiers concernés.
      "recap.errorsShow": "Details anzeigen",
      "recap.errorsHide": "ausblenden",
      "recap.errorsLoading": "Details werden geladen…",
      "recap.errorsNone": "Keine Details zu diesen Fehlern verfügbar.",
      "recap.errorsMore": {
        one: "… und {count} weiterer, im Container-Log.",
        other: "… und {count} weitere, im Container-Log.",
      },
      "recap.found": "📦 Insgesamt gefunden",
      "recap.expected": "🗂 Vom Baum angekündigt",
      "recap.discSkipped": "🚷 Vor der Analyse übersprungen",
      "recap.discDetail": " (gesperrt {banned}, unbekannt {unknown}, nicht unterstützt {unsupported})",
      "recap.time": "⏱ Transferdauer",
      "recap.simNote": "🧪 Simulation: es wurde keine Datei tatsächlich gesendet.",

      "status.resuming": "Import wird fortgesetzt…",
      "status.error": "Fehler: {msg}",
      "status.networkError": "Netzwerkfehler: {msg}",
      "status.discarded": "Vorheriger Import verworfen. Neue Auswahl möglich.",
      "status.starting": "Wird gestartet…",
      "status.startingSim": "Wird gestartet (Simulation)…",
      "status.success": "✅ Import erfolgreich abgeschlossen.",
      "status.cancelled": "⏹ Import abgebrochen.",
      "status.interrupted":
        "⏸ Import unterbrochen (Datenträger getrennt). Schließe den Datenträger wieder an, " +
        "um dort fortzufahren, wo es aufgehört hat.",
      "status.errorCode": "❌ Import mit Fehlern abgeschlossen (Code {code}).",
      "status.live": "⏳ Import läuft — Live-Ansicht…",
      "status.liveSim": "⏳ Import (Simulation) läuft — Live-Ansicht…",

      "wizard.header": "Einrichtung",
      "wizard.reopen": "Einrichtungsassistent",
      "wizard.progressAria": "Fortschritt",
      "wizard.step.start": "Start",
      "wizard.step.server": "Server",
      "wizard.step.key": "Schlüssel",
      "wizard.step.album": "Alben",
      "wizard.step.ready": "Fertig",
      "wizard.back": "zurück",
      "wizard.continue": "weiter",
      "wizard.cancel": "später",
      "wizard.start.title": "Drei Minuten und es läuft.",
      "wizard.start.intro": "Diese Anwendung lädt Ihre Foto- und Video-Ordner auf Ihren Immich-Server hoch, ohne je eine bereits vorhandene Datei erneut zu senden.",
      "wizard.start.b1": "Wir finden Ihren Immich-Server ganz allein im Netzwerk.",
      "wizard.start.b2": "Wir bringen Sie direkt auf die Seite, auf der Sie den Zugriffsschlüssel erstellen.",
      "wizard.start.b3": "Sie wählen die zu importierenden Ordner und verfolgen den Transfer live.",
      "wizard.start.cta": "loslegen",
      "wizard.server.title": "Wo ist Ihr Immich?",
      "wizard.server.subtitle": "Sie müssen die Adresse nicht kennen: wir schauen für Sie ins Netzwerk.",
      "wizard.server.searching": "Suche nach dem Immich-Server im Netzwerk…",
      "wizard.server.noneFound": "Kein Server automatisch gefunden. Geben Sie die Adresse unten ein oder starten Sie einen Scan Ihres Netzwerks.",
      "wizard.server.relaunch": "Erkennung erneut starten",
      "wizard.server.notSeen": "ich sehe meinen Server nicht",
      "wizard.server.found": { one: "{n} Server gefunden", other: "{n} Server gefunden" },
      "wizard.server.addr": "Adresse Ihres Immich",
      "wizard.server.addrHint": "Es ist die Adresse, die Sie in Ihrem Browser eingeben, um Immich zu öffnen, samt Port (standardmäßig 2283).",
      "wizard.server.addrPlaceholder": "http://192.168.1.10:2283",
      "wizard.server.test": "testen",
      "wizard.server.scanLabel": "Oder ein ganzes Netzwerk scannen",
      "wizard.server.scanPlaceholder": "— Netzwerk wählen —",
      "wizard.server.scan": "scannen",
      "wizard.server.scanHint": "Testet Port 2283 an jeder Adresse des gewählten Netzwerks. Rechnen Sie mit rund zehn Sekunden.",
      "wizard.server.kept": "Ausgewählter Server:",
      "wizard.server.probeFail": "Kein Immich-Server an dieser Adresse",
      "wizard.server.detected": "erkannt",
      "wizard.server.src.docker": "Docker-Dienstname „{host}“",
      "wizard.server.src.gateway": "Docker-Host-Maschine (Gateway)",
      "wizard.server.src.dockerHost": "Docker-Host-Maschine (Docker Desktop)",
      "wizard.server.src.localhost": "Diese Maschine",
      "wizard.server.src.iface": "Adresse dieses Containers ({iface})",
      "wizard.server.src.scan": "Vom Netzwerk-Scan gefunden",
      "wizard.server.subnet.iface": "Von diesem Container gesehenes Netzwerk ({iface})",
      "wizard.server.subnet.common": "Gängiger Heimbereich",
      "wizard.key.title": "Erstellen Sie einen Zugriffsschlüssel in Immich",
      "wizard.key.subtitle": "Dieser Schlüssel erlaubt der Anwendung, Ihre Fotos zu Immich hochzuladen. Er bleibt auf diesem Server und wird nie woanders hin übertragen.",
      "wizard.key.s1": "Klicken Sie auf die Schaltfläche unten: Immich öffnet sich in einem neuen Tab, direkt auf der Seite „API-Schlüssel“.",
      "wizard.key.s2": "Klicken Sie auf **Neuer API-Schlüssel**, benennen Sie ihn (z. B. „ImmichImport“) und kreuzen Sie die unten aufgeführten Berechtigungen an, bevor Sie bestätigen.",
      "wizard.key.s3": "Immich zeigt den Schlüssel **nur einmal** an: kopieren Sie ihn, kommen Sie hierher zurück und fügen Sie ihn ins Feld ein.",
      "wizard.key.open": "Immichs API-Schlüssel-Seite öffnen",
      "wizard.key.linkFail": "Link öffnet nicht?",
      "wizard.key.linkFailBody": "Die Adresse, die dieser Container zur Kommunikation mit Immich nutzt, ist nicht unbedingt die, die Ihr Browser öffnen kann. Korrigieren Sie sie hier:",
      "wizard.key.linkFailAlt": "Ansonsten in Immich: Ihr Avatar oben rechts → „Kontoeinstellungen“ → „API-Schlüssel“.",
      "wizard.key.permsIntro": "Am einfachsten: kreuzen Sie **Select all** (alles auswählen) an. Für einen Schlüssel mit minimalem Umfang nur:",
      "wizard.key.permsNote": "Die {req} sind unverzichtbar. Die {rec} betreffen nur eine Funktion: ohne sie ist das Erstellen eines Albums pro Ordner einfach inaktiv.",
      "wizard.key.required": "erforderlich",
      "wizard.key.recommended": "empfohlen",
      "perm.asset.upload": "Fotos und Videos hochladen",
      "perm.job.create": "Immich-Aufgaben während des Imports pausieren (Administrator-Schlüssel)",
      "perm.asset.read": "Bereits vorhandene Dateien nicht erneut senden",
      "perm.album.create": "Ein Album pro Ordner erstellen",
      "perm.album.read": "Vorhandene Alben finden",
      "wizard.key.paste": "Fügen Sie den Schlüssel hier ein",
      "wizard.key.pastePlaceholder": "Immich-API-Schlüssel",
      "wizard.key.verify": "prüfen",
      "wizard.key.connected": "Verbunden",
      "wizard.key.connectedAs": "Verbunden als {email}",
      "wizard.key.connectedVersion": " · Immich {version}",
      "wizard.key.errKeyRejected": "Schlüssel von Immich abgelehnt. Prüfen Sie, ob Sie den ganzen Schlüssel kopiert haben.",
      "wizard.key.errUnreachable": "Server nicht erreichbar. Gehen Sie zum vorherigen Schritt zurück.",
      "wizard.key.errHttp": "Unerwartete Serverantwort (Code {detail}).",
      "check.account.label": "Gültiger Schlüssel — Kontozugriff",
      "check.account.hint": "prüfen Sie, ob der Schlüssel vollständig und aktiv ist",
      "check.albums.label": "Alben lesen — album.read",
      "check.albums.hint": "ohne sie werden keine Alben pro Ordner erstellt",
      "check.jobs.label": "Immich-Aufgaben steuern — job.create (Admin)",
      "check.jobs.hint": "ohne sie startet immich-go den Import nicht",
      "check.granted": "gewährt",
      "check.missing": "fehlt — {hint}",
      "check.unknown": "nicht prüfbar",
      "wizard.album.title": "Wie sollen die importierten Fotos einsortiert werden?",
      "wizard.album.subtitle": "immich-go kann aus Ihren Ordnern Alben erstellen. Sie können dies später ändern.",
      "wizard.album.folder.title": "Ein Album pro Ordner",
      "wizard.album.folder.detail": "Jeder importierte Ordner wird zu einem Album mit demselben Namen.",
      "wizard.album.path.title": "Alben nach Ordnerbaum",
      "wizard.album.path.detail": "Bildet den gesamten Ordnerpfad in den Albumnamen ab.",
      "wizard.album.none.title": "Kein Album",
      "wizard.album.none.detail": "Importiert die Fotos, ohne ein Album zu erstellen.",
      "wizard.album.recommended": "empfohlen",
      "wizard.ready.title": "Alles bereit.",
      "wizard.ready.server": "Server",
      "wizard.ready.account": "Konto",
      "wizard.ready.albums": "Alben",
      "wizard.ready.note": "Als Nächstes listet die Anwendung die Ordner auf Ihrem Datenträger auf. Kreuzen Sie die zu importierenden an und starten Sie den Transfer — Sie verfolgen ihn live, und es wird nichts gesendet, bis Sie den Import starten.",
      "wizard.ready.cta": "Anwendung öffnen",
      "wizard.ready.saving": "wird gespeichert…",
      "wizard.ready.failed": "Speichern fehlgeschlagen: {error}",
    },

    it: {
      "app.brandSub": "Console di trasferimento",
      "lang.label": "Lingua",

      "meta.root": "Radice",
      "meta.immich": "Immich",
      "meta.albums": "Album",
      "meta.apiKeyMissing": "⚠ IMMICH_API_KEY mancante",

      "common.root": "&lt;radice&gt;",

      "resume.title": "Importazione interrotta rilevata",
      "resume.resume": "Riprendi",
      "resume.discard": "Ricomincia da capo",
      "resume.simMode": "(modalità simulazione)",
      "resume.unknownDate": "data sconosciuta",
      "resume.intro": "Un'importazione è stata interrotta ({when}).",
      "resume.done": {
        one: "<b>{done}/{total}</b> cartella già completata",
        other: "<b>{done}/{total}</b> cartelle già completate",
      },
      "resume.remaining": {
        one: "<b>{remaining}</b> rimanente",
        other: "<b>{remaining}</b> rimanenti",
      },
      "resume.more": "… +{count}",
      "resume.outro":
        "Riprendere rielabora solo le cartelle rimanenti " +
        "(immich-go salta i file già inviati).",

      "tree.title": "Albero del disco",
      "tree.diskState": "Stato del disco",
      "tree.reload": "Ricarica l'albero",
      "tree.reloadAria": "Ricarica",
      // Disques sans aucune photo ni vidéo : masqués par défaut, avec
      // un lien pour les réafficher (un disque illisible compte 0 lui aussi).
      "tree.emptyHidden": {
        one: "<b>{count}</b> disco vuoto nascosto",
        other: "<b>{count}</b> dischi vuoti nascosti",
      },
      "tree.showEmpty": "mostra",
      "tree.hideEmpty": "nascondi",

      "badge.totalTitle":
        "Questa cartella e tutte le sottocartelle: foto e video che verranno importati",

      "side.title": "Selezione e trasferimento",
      "side.selectedLabel": "Cartelle selezionate",
      "selection.none": "Nessuna cartella selezionata.",
      "selection.toImport": {
        one: "<b>{count}</b> cartella da importare:",
        other: "<b>{count}</b> cartelle da importare:",
      },
      "selection.importing": {
        one: "<b>{count}</b> cartella in importazione:",
        other: "<b>{count}</b> cartelle in importazione:",
      },
      // Same list, once the job is over: the panel keeps showing what
      // was imported instead of falling back to "no folder selected".
      "selection.imported": {
        one: "<b>{count}</b> cartella dell'ultimo import:",
        other: "<b>{count}</b> cartelle dell'ultimo import:",
      },

      "dry.tooltip":
        "Simula l'importazione senza caricare nulla: immich-go mostra cosa farebbe, nessuna modifica in Immich.",
      "dry.title": "Modalità simulazione (dry-run)",
      "dry.hint": "Nessun dato viene inviato",

      "action.import": "Importa la selezione",
      "action.cancel": "Annulla importazione",

      "logs.summary": "Dettagli tecnici (log di immich-go)",

      "disk.backendUnreachable": "Backend irraggiungibile…",
      "disk.none":
        "💾 Nessun disco rilevato. Collega il disco esterno al NAS — " +
        "apparirà qui automaticamente.",
      "disk.mounted": {
        one: "{count} disco montato",
        other: "{count} dischi montati",
      },
      "disk.contentDetected": "Contenuto rilevato sotto la radice",
      "disk.noneShort": "Nessun disco rilevato",

      "progress.preparing": "Preparazione…",
      "progress.starting": "Avvio…",
      "progress.preparingIndex": "Preparazione… (lettura dell'indice Immich)",
      "live.badge": "In corso",

      "chip.uploaded": "inviate",
      "chip.dups": "duplicati",
      "chip.errors": "errori",
      "chip.remaining": "rimanenti",
      "chip.toImport": "da importare",

      "phase.index": "📥 Lettura dell'indice Immich… ({pct} %)",
      "phase.albums": "📚 Lettura degli album Immich… ({count})",
      "phase.dedup": "🔎 Controllo dei duplicati…",
      "phase.simulating": "🧪 Simulazione in corso…",
      "phase.transferring": "📤 Trasferimento in corso…",

      "eta.remaining": "~{time} rimanenti",
      "eta.rate": "≈ {rate} /s",

      "dur.h": "h",
      "dur.min": "min",
      "dur.s": "s",

      "recap.head.success": "✅ Importazione completata",
      "recap.head.error": "❌ Completata con errori",
      "recap.head.cancelled": "⏹ Importazione annullata",
      "recap.head.interrupted": "⏸ Importazione interrotta (disco scollegato)",
      "recap.head.default": "Importazione completata",
      "recap.simSuffix": " · 🧪 simulazione",
      "recap.uploaded": "📤 Foto / video inviati",
      "recap.upgraded": "⬆️ Migliorati sul server",
      "recap.dups": "🔁 Duplicati ignorati",
      "recap.dupsDetail": " (server {server}, locali {local})",
      "recap.unsupported": "🚫 File non supportati",
      "recap.filtered": "🙈 Esclusi da un filtro",
      "recap.errors": "⚠️ Errori",
      // Le compteur d'erreurs ouvre la liste des fichiers concernés.
      "recap.errorsShow": "vedi dettaglio",
      "recap.errorsHide": "nascondi",
      "recap.errorsLoading": "Caricamento del dettaglio…",
      "recap.errorsNone": "Nessun dettaglio disponibile per questi errori.",
      "recap.errorsMore": {
        one: "… e altro {count}, nel log del container.",
        other: "… e altri {count}, nel log del container.",
      },
      "recap.found": "📦 Totale trovato",
      "recap.expected": "🗂 Annunciato dall'albero",
      "recap.discSkipped": "🚷 Esclusi prima dell'analisi",
      "recap.discDetail": " (vietati {banned}, sconosciuti {unknown}, non supportati {unsupported})",
      "recap.time": "⏱ Tempo di trasferimento",
      "recap.simNote": "🧪 Simulazione: nessun file è stato realmente inviato.",

      "status.resuming": "Ripresa dell'importazione…",
      "status.error": "Errore: {msg}",
      "status.networkError": "Errore di rete: {msg}",
      "status.discarded": "Importazione precedente scartata. Nuova selezione possibile.",
      "status.starting": "Avvio…",
      "status.startingSim": "Avvio (simulazione)…",
      "status.success": "✅ Importazione completata con successo.",
      "status.cancelled": "⏹ Importazione annullata.",
      "status.interrupted":
        "⏸ Importazione interrotta (disco scollegato). Ricollega il disco " +
        "per riprendere da dove si era fermato.",
      "status.errorCode": "❌ Importazione completata con errori (codice {code}).",
      "status.live": "⏳ Importazione in corso — vista in diretta…",
      "status.liveSim": "⏳ Importazione (simulazione) in corso — vista in diretta…",

      "wizard.header": "Configurazione",
      "wizard.reopen": "Assistente di configurazione",
      "wizard.progressAria": "Avanzamento",
      "wizard.step.start": "Avvio",
      "wizard.step.server": "Server",
      "wizard.step.key": "Chiave",
      "wizard.step.album": "Album",
      "wizard.step.ready": "Pronto",
      "wizard.back": "indietro",
      "wizard.continue": "continua",
      "wizard.cancel": "più tardi",
      "wizard.start.title": "Tre minuti ed è fatta.",
      "wizard.start.intro": "Questa applicazione invia le tue cartelle di foto e video al tuo server Immich, senza mai reinviare un file già presente.",
      "wizard.start.b1": "Cerchiamo il tuo server Immich da soli sulla rete.",
      "wizard.start.b2": "Ti portiamo direttamente alla pagina dove creare la chiave di accesso.",
      "wizard.start.b3": "Scegli le cartelle da importare e segui il trasferimento in diretta.",
      "wizard.start.cta": "inizia",
      "wizard.server.title": "Dov'è il tuo Immich?",
      "wizard.server.subtitle": "Non serve conoscere l'indirizzo: guardiamo la rete per te.",
      "wizard.server.searching": "Ricerca del server Immich sulla rete…",
      "wizard.server.noneFound": "Nessun server trovato automaticamente. Inserisci l'indirizzo qui sotto, oppure avvia una scansione della tua rete.",
      "wizard.server.relaunch": "riavvia il rilevamento",
      "wizard.server.notSeen": "non vedo il mio server",
      "wizard.server.found": { one: "{n} server trovato", other: "{n} server trovati" },
      "wizard.server.addr": "Indirizzo del tuo Immich",
      "wizard.server.addrHint": "È l'indirizzo che digiti nel browser per aprire Immich, porta compresa (2283 per impostazione predefinita).",
      "wizard.server.addrPlaceholder": "http://192.168.1.10:2283",
      "wizard.server.test": "prova",
      "wizard.server.scanLabel": "Oppure scansiona un'intera rete",
      "wizard.server.scanPlaceholder": "— scegli una rete —",
      "wizard.server.scan": "scansiona",
      "wizard.server.scanHint": "Prova la porta 2283 su ogni indirizzo della rete scelta. Conta una decina di secondi.",
      "wizard.server.kept": "Server selezionato:",
      "wizard.server.probeFail": "Nessun server Immich a questo indirizzo",
      "wizard.server.detected": "rilevato",
      "wizard.server.src.docker": "Nome del servizio Docker «{host}»",
      "wizard.server.src.gateway": "Macchina che ospita Docker (gateway)",
      "wizard.server.src.dockerHost": "Macchina che ospita Docker (Docker Desktop)",
      "wizard.server.src.localhost": "Questa macchina",
      "wizard.server.src.iface": "Indirizzo di questo contenitore ({iface})",
      "wizard.server.src.scan": "Trovato dalla scansione di rete",
      "wizard.server.subnet.iface": "Rete vista da questo contenitore ({iface})",
      "wizard.server.subnet.common": "Intervallo domestico comune",
      "wizard.key.title": "Crea una chiave di accesso in Immich",
      "wizard.key.subtitle": "Questa chiave autorizza l'applicazione a caricare le tue foto su Immich. Resta su questo server e non viene mai trasmessa altrove.",
      "wizard.key.s1": "Clicca sul pulsante qui sotto: Immich si apre in una nuova scheda, direttamente sulla pagina «Chiavi API».",
      "wizard.key.s2": "Clicca su **Nuova chiave API**, dalle un nome (per esempio «ImmichImport»), poi spunta i permessi elencati sotto prima di confermare.",
      "wizard.key.s3": "Immich mostra la chiave **una sola volta**: copiala, torna qui e incollala nel campo.",
      "wizard.key.open": "Apri la pagina delle chiavi API di Immich",
      "wizard.key.linkFail": "Il link non si apre?",
      "wizard.key.linkFailBody": "L'indirizzo che questo contenitore usa per parlare con Immich non è per forza quello che il tuo browser sa aprire. Correggilo qui:",
      "wizard.key.linkFailAlt": "Altrimenti, in Immich: il tuo avatar in alto a destra → «Impostazioni account» → «Chiavi API».",
      "wizard.key.permsIntro": "Il più semplice: spunta **Select all** (seleziona tutto). Per una chiave con ambito minimo, spunta solo:",
      "wizard.key.permsNote": "I {req} sono indispensabili. I {rec} riguardano solo una funzione: senza di essi, la creazione di un album per cartella è semplicemente inattiva.",
      "wizard.key.required": "richiesto",
      "wizard.key.recommended": "consigliato",
      "perm.asset.upload": "Caricare foto e video",
      "perm.job.create": "Mettere in pausa le attività di Immich durante l'importazione (chiave amministratore)",
      "perm.asset.read": "Evitare di reinviare un file già presente",
      "perm.album.create": "Creare un album per cartella",
      "perm.album.read": "Ritrovare gli album esistenti",
      "wizard.key.paste": "Incolla la chiave qui",
      "wizard.key.pastePlaceholder": "chiave API Immich",
      "wizard.key.verify": "verifica",
      "wizard.key.connected": "Connesso",
      "wizard.key.connectedAs": "Connesso come {email}",
      "wizard.key.connectedVersion": " · Immich {version}",
      "wizard.key.errKeyRejected": "Chiave rifiutata da Immich. Assicurati di aver copiato l'intera chiave.",
      "wizard.key.errUnreachable": "Server irraggiungibile. Torna al passaggio precedente.",
      "wizard.key.errHttp": "Risposta inattesa dal server (codice {detail}).",
      "check.account.label": "Chiave valida — accesso all'account",
      "check.account.hint": "verifica che la chiave sia completa e attiva",
      "check.albums.label": "Leggere gli album — album.read",
      "check.albums.hint": "senza di essa, gli album per cartella non verranno creati",
      "check.jobs.label": "Gestire le attività di Immich — job.create (admin)",
      "check.jobs.hint": "senza di essa, immich-go rifiuta di avviare l'importazione",
      "check.granted": "concesso",
      "check.missing": "mancante — {hint}",
      "check.unknown": "non verificabile",
      "wizard.album.title": "Come ordinare le foto importate?",
      "wizard.album.subtitle": "immich-go può creare album dalle tue cartelle. Potrai cambiarlo più tardi.",
      "wizard.album.folder.title": "Un album per cartella",
      "wizard.album.folder.detail": "Ogni cartella importata diventa un album con lo stesso nome.",
      "wizard.album.path.title": "Album secondo l'albero delle cartelle",
      "wizard.album.path.detail": "Riflette l'intero percorso delle cartelle nei nomi degli album.",
      "wizard.album.none.title": "Senza album",
      "wizard.album.none.detail": "Importa le foto senza creare album.",
      "wizard.album.recommended": "consigliato",
      "wizard.ready.title": "Tutto pronto.",
      "wizard.ready.server": "Server",
      "wizard.ready.account": "Account",
      "wizard.ready.albums": "Album",
      "wizard.ready.note": "Prossimo passo: l'applicazione elenca le cartelle del tuo disco. Spunta quelle da importare e avvia il trasferimento — lo segui in diretta, e non viene inviato nulla finché non avvii l'importazione.",
      "wizard.ready.cta": "apri l'applicazione",
      "wizard.ready.saving": "salvataggio…",
      "wizard.ready.failed": "Impossibile salvare: {error}",
    },
  };

  // --- état ---------------------------------------------------------------
  function detectLang() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && DICT[saved]) return saved;
    } catch (_) { /* localStorage indisponible */ }
    const nav = (navigator.language || navigator.userLanguage || "").slice(0, 2).toLowerCase();
    return DICT[nav] ? nav : FALLBACK;
  }

  let lang = detectLang();
  const listeners = new Set();

  // Formatteurs mémoïsés par langue (Intl est intégré, aucun CDN).
  const nfCache = {};
  const pluralCache = {};
  function numberFormat() {
    return (nfCache[lang] ||= new Intl.NumberFormat(LOCALE[lang]));
  }
  function pluralRules() {
    return (pluralCache[lang] ||= new Intl.PluralRules(LOCALE[lang]));
  }

  function n(num) {
    if (typeof num !== "number" || !isFinite(num)) return String(num);
    return numberFormat().format(num);
  }

  function bytes(num) {
    num = Number(num) || 0;
    const units = BYTE_UNITS[lang] || BYTE_UNITS.en;
    let i = 0;
    while (num >= 1024 && i < units.length - 1) { num /= 1024; i++; }
    const val = i === 0 ? num : Math.round(num * 10) / 10;
    return n(val) + " " + units[i];
  }

  function date(ts) {
    // Accepte un timestamp en secondes (backend) ou en millisecondes.
    const ms = ts < 1e12 ? ts * 1000 : ts;
    try {
      return new Intl.DateTimeFormat(LOCALE[lang], {
        dateStyle: "medium", timeStyle: "short",
      }).format(new Date(ms));
    } catch (_) {
      return new Date(ms).toLocaleString();
    }
  }

  function interpolate(str, params) {
    if (!params) return str;
    return str.replace(/\{(\w+)\}/g, (m, key) => {
      if (!(key in params)) return m;
      const v = params[key];
      return typeof v === "number" ? n(v) : String(v);
    });
  }

  function lookup(key, code) {
    const table = DICT[code];
    return table && key in table ? table[key] : undefined;
  }

  function t(key, params) {
    let entry = lookup(key, lang);
    if (entry === undefined) entry = lookup(key, FALLBACK);
    if (entry === undefined) return key; // clé absente → renvoie la clé (debug)
    if (entry && typeof entry === "object") {
      const count = params ? (params.count != null ? params.count : params.n) : undefined;
      const cat = pluralRules().select(typeof count === "number" ? count : 0);
      entry = entry[cat] != null ? entry[cat] : (entry.other != null ? entry.other : entry.one);
    }
    return interpolate(entry, params);
  }

  // --- application des chaînes statiques du DOM ---------------------------
  // data-i18n="clé"        → textContent
  // data-i18n-html="clé"   → innerHTML (valeurs contenant du balisage)
  // data-i18n-title="clé"  → attribut title
  // data-i18n-aria="clé"   → attribut aria-label
  function applyStatic(root) {
    root = root || document;
    root.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    root.querySelectorAll("[data-i18n-html]").forEach((el) => {
      el.innerHTML = t(el.getAttribute("data-i18n-html"));
    });
    root.querySelectorAll("[data-i18n-title]").forEach((el) => {
      el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
    });
    root.querySelectorAll("[data-i18n-aria]").forEach((el) => {
      el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria")));
    });
  }

  function setLang(code) {
    if (!DICT[code] || code === lang) return;
    lang = code;
    try { localStorage.setItem(STORAGE_KEY, code); } catch (_) { /* ignore */ }
    document.documentElement.lang = code;
    applyStatic(document);
    listeners.forEach((cb) => { try { cb(code); } catch (_) { /* ignore */ } });
  }

  function onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }

  window.I18N = {
    LANGS,
    get lang() { return lang; },
    t, n, bytes, date,
    setLang, onChange, applyStatic,
  };

  // Injecte l'en-tête X-Lang sur chaque requête same-origin, pour que le backend
  // FastAPI renvoie ses messages (erreurs disque/import/connexion) dans la même
  // langue que l'interface. Toutes les requêtes de l'app passent des URL string.
  const _fetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    init = Object.assign({}, init);
    const headers = new Headers(init.headers || {});
    headers.set("X-Lang", lang);
    init.headers = headers;
    return _fetch(input, init);
  };

  // Reflète la langue détectée sur <html> dès le chargement.
  document.documentElement.lang = lang;
})();
