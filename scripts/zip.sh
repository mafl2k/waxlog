#!/usr/bin/env bash
# Builds dist/waxlog-<version>.zip with a top-level waxlog/ folder, ready to unzip into
# Sauce's SauceMods folder. Only the files a user needs go in (no tests, no .claude).
set -euo pipefail

cd "$(dirname "$0")/.."
root=$(pwd)

version=$(node -p "require('./manifest.json').version")
out="dist/waxlog-${version}.zip"

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

mkdir -p "$stage/waxlog" dist
cp manifest.json README.md LICENSE "$stage/waxlog/"
cp -R pages "$stage/waxlog/pages"
find "$stage" -name .DS_Store -delete

rm -f "$out"
(cd "$stage" && zip -r -q -X "$root/$out" waxlog)

echo "Built $out"
