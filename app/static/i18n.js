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

      "badge.directTitle":
        "Dans CE dossier uniquement (fichiers posés directement, hors sous-dossiers)",
      "badge.totalTitle":
        "TOTAL récursif : ce dossier + tous ses sous-dossiers (ce qu'immich-go importera)",

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

      "phase.scanning": "🔎 Analyse du dossier… ({pct} % lu)",
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
      "recap.errors": "⚠️ Erreurs",
      "recap.found": "📦 Total trouvé",
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

      "badge.directTitle":
        "In THIS folder only (files placed directly, excluding subfolders)",
      "badge.totalTitle":
        "Recursive TOTAL: this folder + all its subfolders (what immich-go will import)",

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

      "phase.scanning": "🔎 Scanning the folder… ({pct}% read)",
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
      "recap.errors": "⚠️ Errors",
      "recap.found": "📦 Total found",
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

      "badge.directTitle":
        "Solo en ESTA carpeta (archivos colocados directamente, sin subcarpetas)",
      "badge.totalTitle":
        "TOTAL recursivo: esta carpeta + todas sus subcarpetas (lo que importará immich-go)",

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

      "phase.scanning": "🔎 Analizando la carpeta… ({pct} % leído)",
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
      "recap.errors": "⚠️ Errores",
      "recap.found": "📦 Total encontrado",
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

      "badge.directTitle":
        "Nur in DIESEM Ordner (direkt abgelegte Dateien, ohne Unterordner)",
      "badge.totalTitle":
        "Rekursive GESAMTZAHL: dieser Ordner + alle Unterordner (was immich-go importiert)",

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

      "phase.scanning": "🔎 Ordner wird analysiert… ({pct} % gelesen)",
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
      "recap.errors": "⚠️ Fehler",
      "recap.found": "📦 Insgesamt gefunden",
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

      "badge.directTitle":
        "Solo in QUESTA cartella (file inseriti direttamente, escluse le sottocartelle)",
      "badge.totalTitle":
        "TOTALE ricorsivo: questa cartella + tutte le sottocartelle (ciò che immich-go importerà)",

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

      "phase.scanning": "🔎 Analisi della cartella… ({pct} % letto)",
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
      "recap.errors": "⚠️ Errori",
      "recap.found": "📦 Totale trovato",
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
