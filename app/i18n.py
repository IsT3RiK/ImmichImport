"""Server-side i18n for user-facing API messages.

The frontend sends the active language in an ``X-Lang`` header (see i18n.js);
we also honour ``Accept-Language`` as a fallback. Every message returned to the
user (import / disk / connection errors, invalid selections) is translated into
the five supported languages, matching the interface. Keys mirror the frontend.
"""
from __future__ import annotations

SUPPORTED = ("fr", "en", "es", "de", "it")
FALLBACK = "fr"

# key -> { lang -> message }
MESSAGES: dict[str, dict[str, str]] = {
    "err.invalidPath": {
        "fr": "Chemin invalide.",
        "en": "Invalid path.",
        "es": "Ruta no válida.",
        "de": "Ungültiger Pfad.",
        "it": "Percorso non valido.",
    },
    "err.folderNotFound": {
        "fr": "Dossier introuvable.",
        "en": "Folder not found.",
        "es": "Carpeta no encontrada.",
        "de": "Ordner nicht gefunden.",
        "it": "Cartella non trovata.",
    },
    "err.importRunning": {
        "fr": "Un import est déjà en cours.",
        "en": "An import is already running.",
        "es": "Ya hay una importación en curso.",
        "de": "Ein Import läuft bereits.",
        "it": "Un'importazione è già in corso.",
    },
    "err.noSelection": {
        "fr": "Aucun dossier sélectionné.",
        "en": "No folder selected.",
        "es": "Ninguna carpeta seleccionada.",
        "de": "Kein Ordner ausgewählt.",
        "it": "Nessuna cartella selezionata.",
    },
    "err.noResumable": {
        "fr": "Aucun import à reprendre.",
        "en": "No resumable import.",
        "es": "No hay ninguna importación que reanudar.",
        "de": "Kein fortsetzbarer Import.",
        "it": "Nessuna importazione da riprendere.",
    },
    "err.nothingToResume": {
        "fr": "Plus rien à reprendre.",
        "en": "Nothing left to resume.",
        "es": "No queda nada por reanudar.",
        "de": "Nichts mehr fortzusetzen.",
        "it": "Non resta nulla da riprendere.",
    },
    "err.jobNotFound": {
        "fr": "Tâche introuvable.",
        "en": "Job not found.",
        "es": "Tarea no encontrada.",
        "de": "Auftrag nicht gefunden.",
        "it": "Attività non trovata.",
    },
    "err.jobNotRunning": {
        "fr": "La tâche n'est pas en cours.",
        "en": "Job not running.",
        "es": "La tarea no está en curso.",
        "de": "Auftrag läuft nicht.",
        "it": "L'attività non è in corso.",
    },
}

# Raw English messages raised deep in the code (importer.py) mapped to keys, so
# ``str(exc)`` can be localized without threading a language through every layer.
CODE_BY_MESSAGE: dict[str, str] = {
    "invalid path": "err.invalidPath",
    "folder not found": "err.folderNotFound",
    "an import is already running": "err.importRunning",
    "an import is running": "err.importRunning",
    "no folder selected": "err.noSelection",
    "no resumable import": "err.noResumable",
    "nothing left to resume": "err.nothingToResume",
    "job not found": "err.jobNotFound",
    "job not running": "err.jobNotRunning",
}


def pick_lang(accept_language: str | None, x_lang: str | None) -> str:
    """Resolve the response language: explicit X-Lang wins, else Accept-Language."""
    if x_lang:
        code = x_lang.strip().lower()[:2]
        if code in SUPPORTED:
            return code
    if accept_language:
        # "fr-FR,fr;q=0.9,en;q=0.8" -> first supported 2-letter tag.
        for part in accept_language.split(","):
            code = part.split(";")[0].strip().lower()[:2]
            if code in SUPPORTED:
                return code
    return FALLBACK


def tr(key_or_message: str, lang: str) -> str:
    """Translate a message key (or a known raw English message) to ``lang``.

    Unknown strings are returned unchanged, so callers can pass through anything
    without risk of raising.
    """
    key = key_or_message
    if key not in MESSAGES:
        key = CODE_BY_MESSAGE.get(key_or_message, "")
    table = MESSAGES.get(key)
    if not table:
        return key_or_message  # not a known message — pass through as-is
    return table.get(lang) or table.get(FALLBACK) or key_or_message
