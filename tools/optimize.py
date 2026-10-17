"""Build web-ready WebP files + manifest from source-images/.
Run: python3 tools/optimize.py
Output: docs/assets/img/<set>/<name>.webp (1200w), <name>-t.webp (560w), docs/data/manifest.json
"""
import json, os
from PIL import Image
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'source-images'); OUT = os.path.join(ROOT, 'docs', 'assets', 'img')
manifest = {}
for s in sorted(os.listdir(SRC)):
    if not os.path.isdir(os.path.join(SRC, s)): continue
    os.makedirs(os.path.join(OUT, s), exist_ok=True); items = []
    for f in sorted(os.listdir(os.path.join(SRC, s))):
        if not f.lower().endswith(('.jpg', '.jpeg', '.png')): continue
        n = os.path.splitext(f)[0]
        im = Image.open(os.path.join(SRC, s, f)).convert('RGB')
        for suffix, w, q in (('', 1200, 76), ('-t', 560, 70)):
            r = im.copy()
            if r.width > w: r = r.resize((w, round(r.height * w / r.width)), Image.LANCZOS)
            r.save(os.path.join(OUT, s, n + suffix + '.webp'), 'WEBP', quality=q, method=6)
            if suffix == '': W, H = r.size
        items.append({'id': n, 'w': W, 'h': H})
    manifest[s] = items
os.makedirs(os.path.join(ROOT, 'docs', 'data'), exist_ok=True)
json.dump(manifest, open(os.path.join(ROOT, 'docs', 'data', 'manifest.json'), 'w'), indent=1)
print({k: len(v) for k, v in manifest.items()})
