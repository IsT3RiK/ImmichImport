"""Glob-style name matcher — a faithful port of immich-go's ``namematcher``.

Why a port and not an approximation: the tree view must promise exactly what
immich-go will actually import. Any divergence between the two filters shows up
as "the app counted 250 000 files but only 12 000 were found", which is
impossible for a user to diagnose. By compiling the *same* patterns with the
*same* semantics on both sides, the two can only agree.

Reference: immich-go v0.32.0 ``internal/namematcher/list.go`` (``patternToRe``).
Semantics reproduced here:

* matching is case-insensitive (``(?i)`` prefix);
* matching is a **substring** search (unanchored), so ``thumbnails/`` matches at
  any depth of the path;
* a leading ``/`` anchors to the start of a path segment (``(^|/)``);
* ``*`` expands to ``[^/]*`` and ``?`` to ``[^/]`` — neither crosses a ``/``;
* ``. ^ $ ( ) |`` are escaped, so ``$RECYCLE.BIN/`` is a literal;
* a pattern ending with ``/`` matches **directories only**.
"""
from __future__ import annotations

import re

_ESCAPED = ".^$()|"


class InvalidPatternError(ValueError):
    """Raised when a pattern cannot be compiled (e.g. an unclosed bracket)."""


def pattern_to_re(pattern: str) -> re.Pattern[str]:
    """Translate one glob-style pattern into a compiled regular expression."""
    out: list[str] = ["(?i)"]
    buf = pattern
    i = 0
    first_rune = True
    in_brackets = False

    while i < len(buf):
        ch = buf[i]
        i += 1
        if ch == "/":
            # A leading slash anchors on a segment boundary, not on the string.
            out.append("(^|/)" if first_rune else "/")
        elif ch == "*":
            out.append("[^/]*")
        elif ch == "?":
            out.append("[^/]")
        elif ch in _ESCAPED:
            out.append("\\" + ch)
        elif ch == "\\":
            out.append(ch)
            if i < len(buf):
                out.append(buf[i])
                i += 1
        elif ch == "[":
            in_brackets = True
            out.append(ch)
            while i < len(buf):
                ch = buf[i]
                i += 1
                if ch == "]":
                    in_brackets = False
                    out.append(ch)
                    break
                lower, upper = ch.lower(), ch.upper()
                out.append(lower)
                if lower != upper:
                    out.append(upper)
        else:
            out.append(ch)
        first_rune = False

    if in_brackets:
        raise InvalidPatternError(f"invalid file name pattern: {pattern}")
    try:
        return re.compile("".join(out))
    except re.error as exc:  # noqa: BLE001 - surfaced as a clear config error
        raise InvalidPatternError(f"invalid file name pattern: {pattern}") from exc


class NameList:
    """An ordered list of banned patterns, split into file and directory rules."""

    __slots__ = ("_entries",)

    def __init__(self, patterns: list[str] | tuple[str, ...] = ()) -> None:
        self._entries: list[tuple[re.Pattern[str], str, bool]] = []
        for pattern in patterns:
            self.add(pattern)

    def add(self, pattern: str) -> None:
        if not pattern:
            return
        compiled = pattern_to_re(pattern)
        # As in immich-go: a trailing slash marks the rule as directory-only.
        self._entries.append((compiled, pattern, pattern.endswith("/")))

    @property
    def patterns(self) -> list[str]:
        return [raw for _re, raw, _dir in self._entries]

    def __bool__(self) -> bool:
        return bool(self._entries)

    def match_file(self, name: str) -> str | None:
        """Return the pattern banning this file path, or None."""
        for compiled, raw, dir_only in self._entries:
            if dir_only:
                continue
            if compiled.search(name):
                return raw
        return None

    def match_dir(self, name: str) -> str | None:
        """Return the pattern banning this directory path, or None."""
        trimmed = name[:-1] if name.endswith("/") else name
        with_slash = trimmed + "/"
        for compiled, raw, dir_only in self._entries:
            if not dir_only:
                continue
            if compiled.search(trimmed) or compiled.search(with_slash):
                return raw
        return None

    def match(self, name: str, is_dir: bool) -> str | None:
        """Return the pattern banning this entry, or None."""
        return self.match_dir(name) if is_dir else self.match_file(name)
