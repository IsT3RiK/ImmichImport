"""Single source of truth for the application version.

Displayed at the bottom-left of the UI (via /api/config) so that a running
container can always be identified: the NAS builds straight from the GitHub
repository, so "which version is deployed?" has to be answerable from the
screen, not from the shell.

Bump this when shipping a change worth telling apart.
"""
__version__ = "1.0"
