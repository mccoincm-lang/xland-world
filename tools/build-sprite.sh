#!/bin/sh
# Regenerates src/sprite.svg from the approved artwork in ../xland-territory-atlas.
set -e
cd "$(dirname "$0")/.."
NM=${NODE_TOOLS:-/opt/npm-tools/node_modules}
"$NM/.bin/esbuild" tools/build-sprite.tsx --bundle --platform=node --jsx=automatic --format=cjs \
  --loader:.css=empty --alias:react=$NM/react --alias:react-dom=$NM/react-dom \
  --outfile=tools/.sprite.cjs --log-level=warning
node tools/.sprite.cjs src/sprite.svg
rm -f tools/.sprite.cjs
