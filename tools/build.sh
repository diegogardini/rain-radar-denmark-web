#!/usr/bin/env bash
# Builds the site into one folder for GitHub Pages:
#   <out>/            the page (site/)
#   <out>/lib/*.js    the widget's JavaScript models (nowcast, chances, places,
#                     colours, map), from a checkout of the widget repository
# usage: bash tools/build.sh <out-dir> [widget-dir]
#   widget-dir defaults to $WIDGET_DIR, else ../omarchy-rain-radar-denmark-widget
set -euo pipefail

out="${1:?usage: tools/build.sh <out-dir> [widget-dir]}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
widget="${2:-${WIDGET_DIR:-$root/../omarchy-rain-radar-denmark-widget}}"
[ -f "$widget/manifest.json" ] || { echo "no widget checkout at $widget" >&2; exit 1; }

mkdir -p "$out/lib"
cp "$root"/site/* "$out/"
cp "$widget"/*.js "$out/lib/"
touch "$out/.nojekyll" # serve the files as they are
echo "built $(find "$out" -type f | wc -l) files in $out from widget $(git -C "$widget" describe --tags --always 2>/dev/null || echo '?')"
