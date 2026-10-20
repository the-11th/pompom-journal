#!/bin/bash
# Compatibility entry point for existing saved shortcuts.
exec /bin/bash "$(dirname "$0")/Datapom.command" "$@"
