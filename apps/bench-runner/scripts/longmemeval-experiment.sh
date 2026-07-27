#!/usr/bin/env bash
# Local cache-only A/B recall experiment. Promotion remains a separate command.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export MATRIX_EXPERIMENT=1
exec "$SCRIPT_DIR/longmemeval-matrix.sh"
