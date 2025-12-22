#!/bin/bash
# Validate that EXTRA_IMPORTS in _stubs.py matches what would be generated

set -e

echo "Generating EXTRA_IMPORTS mapping..."
GENERATED=$(uv run python scripts/generate_extra_imports.py)

echo "Extracting current EXTRA_IMPORTS from _stubs.py..."
# Extract the JSON representation from _stubs.py
CURRENT=$(python -c "
import sys
sys.path.insert(0, 'mirascope')
from _stubs import EXTRA_IMPORTS
import json
print(json.dumps(EXTRA_IMPORTS, indent=2))
")

echo "Comparing generated vs current..."
if [ "$GENERATED" = "$CURRENT" ]; then
    echo "✓ EXTRA_IMPORTS is up to date"
    exit 0
else
    echo "✗ EXTRA_IMPORTS is out of sync"
    echo ""
    echo "Generated:"
    echo "$GENERATED"
    echo ""
    echo "Current:"
    echo "$CURRENT"
    echo ""
    echo "To fix, run: uv run python scripts/generate_extra_imports.py --overwrite"
    exit 1
fi
