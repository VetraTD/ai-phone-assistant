#!/usr/bin/env bash
# Regenerate the self-hosted webfonts for the dashboard.
#
# Run from the repo root. Rewrites AI-phone-dashboard/frontend/src/fonts.css and
# repopulates AI-phone-dashboard/frontend/public/fonts.
#
# Why self-hosted at all: see the header of src/fonts.css. Short version, a
# Google Fonts <link> tells Google the IP of everyone who opens the dashboard,
# and no processor agreement covers that.
#
# The User-Agent matters. Google serves a DIFFERENT stylesheet per browser —
# woff2 to modern ones, older formats to anything it does not recognise — and
# curl's default UA gets the legacy set. Asking as Chrome gets woff2 only.
set -euo pipefail

FAMILIES='family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700;1,9..144,500&display=swap'
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
DIR='AI-phone-dashboard/frontend'

curl -sS -A "$UA" "https://fonts.googleapis.com/css2?${FAMILIES}" -o /tmp/gfonts-src.css

mkdir -p "$DIR/public/fonts"
for url in $(grep -o 'https://fonts.gstatic.com[^)]*' /tmp/gfonts-src.css | sort -u); do
  curl -sS "$url" -o "$DIR/public/fonts/$(basename "$url")"
done

python - "$DIR" <<'PY'
import io, os, re, sys
d = sys.argv[1]
css = io.open('/tmp/gfonts-src.css', encoding='utf-8').read()
out = re.sub(r"url\((https://fonts\.gstatic\.com[^)]*)\)",
             lambda m: "url('/fonts/%s')" % os.path.basename(m.group(1)), css)
assert 'fonts.gstatic.com' not in out, 'a Google URL survived the rewrite'
old = io.open(os.path.join(d, 'src/fonts.css'), encoding='utf-8').read()
header = old[:old.index('*/') + 3]
io.open(os.path.join(d, 'src/fonts.css'), 'w', encoding='utf-8', newline='\n').write(header + out)
print('fonts.css regenerated, @font-face blocks:', out.count('@font-face'))
PY
