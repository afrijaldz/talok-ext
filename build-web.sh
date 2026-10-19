#!/bin/sh
# Build the web version into dist/: the same reader, served as a static site (and a PWA).
set -e
cd "$(dirname "$0")"
rm -rf dist
mkdir dist
cp -R reader.js reader.css vendor web/icons web/icon.svg web/site.webmanifest dist/
# Pages are served from /owner/repo, so assets need root-relative paths. The web-only <head> tags
# (manifest, icons, theme color) are added here so the extension's reader.html stays as it is.
sed -e 's#href="reader.css"#href="/reader.css"#' -e 's#src="\([a-z/.]*\.js\)"#src="/\1"#' \
    -e '/<\/head>/{r web/head.html' -e 'N;}' reader.html > dist/index.html
# A new cache version whenever anything in the build changes.
version=$(cat dist/index.html dist/reader.js dist/reader.css | shasum | cut -c1-12)
sed "s/__VERSION__/$version/" web/sw.js > dist/sw.js
