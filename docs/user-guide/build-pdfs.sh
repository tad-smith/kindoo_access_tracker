#!/usr/bin/env bash
# Regenerate the user-guide PDFs from the HTML sources using headless Chrome.
# Run from anywhere: ./docs/user-guide/build-pdfs.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [[ ! -x "$CHROME" ]]; then
  echo "Google Chrome not found at: $CHROME" >&2
  echo "Edit the CHROME path in this script, or open each .html and use Print > Save as PDF." >&2
  exit 1
fi

for name in creating-requests kindoo-managers; do
  echo "Rendering $name.pdf ..."
  "$CHROME" --headless=new --disable-gpu --no-pdf-header-footer \
    --print-to-pdf="$DIR/$name.pdf" "file://$DIR/$name.html" 2>/dev/null
done

echo "Done. PDFs written to $DIR"
