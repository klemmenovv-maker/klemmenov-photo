"""Generate every HTML page of the site from content.json + docs/data/manifest.json.
Run: python3 tools/build.py   (after tools/optimize.py if photos changed)
Edit texts, prices, reviews, contacts and the photo selection in content.json, then rebuild.
"""
import json, os, html, urllib.parse
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(ROOT, 'docs')
C = json.load(open(os.path.join(ROOT, 'content.json'), encoding='utf8'))
M = json.load(open(os.path.join(D, 'data', 'manifest.json')))
SITE = C['site_url'].rstrip('/')
e = html.escape

def wa(extra=''):
    t = C['whatsapp_text'] + ((' ' + extra) if extra else '')
    return f"https://wa.me/{C['whatsapp']}?text={urllib.parse.quote(t)}"

def meta(setname, n):
    return next(x for x in M[setname] if x['id'] == f'{setname}-{n:02d}')

def img(setname, n, root, sizes, alt, eager=False, extra=''):
    m = meta(setname, n); b = f"{root}assets/img/{setname}/{m['id']}"
    pri = ' fetchpriority="high"' if eager else ' loading="lazy"'
    return (f'<img src="{b}.webp" srcset="{b}-t.webp 560w, {b}.webp 1200w" sizes="{sizes}" '
            f'width="{m["w"]}" height="{m["h"]}" alt="{e(alt)}" decoding="async"{pri}{extra}>')

def fig(setname, n, root, sizes, alt, cls='rv', d=0, eager=False):
    return f'<figure class="{cls}" style="--d:{d}ms">{img(setname, n, root, sizes, alt, eager)}</figure>'

NAV = [('Main', ''), ('Portfolio', 'personal/'), ('Prices', 'prices/'), ('Reviews', 'reviews/'), ('Contact', 'contact/')]

def head(title, desc, path, root, og='assets/og.jpg', preload=None):
    url = f'{SITE}/{path}'
    pl = f'<link rel="preload" as="image" href="{preload}" fetchpriority="high">' if preload else ''
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)}</title>
<meta name="description" content="{e(desc)}">
<meta name="theme-color" content="#0c0a09">
<link rel="canonical" href="{url}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Klemmenov">
<meta property="og:title" content="{e(title)}"><meta property="og:description" content="{e(desc)}">
<meta property="og:url" content="{url}"><meta property="og:image" content="{SITE}/{og}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="{root}assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="{root}assets/fonts.css">
<link rel="stylesheet" href="{root}assets/style.css">
<script>document.documentElement.className+=" js"</script>
{pl}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="bar">
<a class="wordmark" href="{root or './'}">Klemmenov</a>
<nav aria-label="Main"><ul>
{''.join(f'<li><a href="{root}{h}"{" aria-current=page" if h and path.startswith(h) else (" aria-current=page" if h == "" and path == "" else "")}>{n}</a></li>' for n, h in NAV)}
</ul></nav>
<a class="btn" href="{wa()}">Book a shoot</a>
<button class="burger" aria-label="Menu" aria-expanded="false"><i></i><i></i></button>
</header>
<main id="main">
'''

def foot(root):
    return f'''</main>
<footer>
<div class="foot-top">
<p class="lead">Photographer in Dubai. Personal, event and commercial shoots.</p>
<div class="foot-links">
<a href="{wa()}">WhatsApp</a><a href="{C['telegram']}">Telegram</a><a href="{C['instagram']}">Instagram</a>
</div>
<div class="foot-links">
<a href="{root}personal/">Personal</a><a href="{root}events/">Events</a><a href="{root}commercial/">Commercial</a><a href="{root}prices/">Prices</a><a href="{root}reviews/">Reviews</a>
</div>
</div>
<div class="name" aria-hidden="true">Klemmenov</div>
<p class="legal">© <span data-year>2026</span> Klemmenov. Dubai.</p>
</footer>
<script src="{root}assets/app.js" defer></script>
</body>
</html>
'''

def calc_cfg():
    return html.escape(json.dumps({
        'wa': C['whatsapp'], 'text': C['whatsapp_text'],
        'services': [{'label': h['name'].replace(' Shoot', ''), 'title': h['title'], 'rate': h['rate'], 'min': h['min'],
                      'note': ('Studio rental is not included.' if h['id'] != 'event' else 'Express delivery available.')}
                     for h in C['hourly']]}, ensure_ascii=False), quote=True)

def calc_block(root):
    return f'''<div class="calc-ui" data-calc="{calc_cfg()}">
<div class="seg" role="group" aria-label="Type of shoot"></div>
<div class="stepper"><button type="button" class="minus" aria-label="One hour less">−</button><output aria-live="polite"></output><button type="button" class="plus" aria-label="One hour more">+</button></div>
<div class="calc-total" aria-live="polite"></div>
<p class="calc-note small"></p>
<a class="btn calc-book" href="{wa()}">Book this shoot</a>
</div>'''

def reviews_html(names=None, all_=False):
    out = []
    for i, r in enumerate(C['reviews']):
        if names and r['name'] not in names: continue
        paras = ''.join(f'<p>{e(p)}</p>' for p in r['text'].split('\n\n') for p in [p.replace('\n', ' / ') if False else p])
        paras = ''.join(f'<p>{e(p).replace(chr(10), "<br>")}</p>' for p in r['text'].split('\n\n'))
        h = f'<a href="https://www.instagram.com/{r["handle"]}/">@{r["handle"]}</a>' if r.get('handle') else ''
        out.append(f'<blockquote class="quote rv" style="--d:{(len(out)%3)*90}ms">{paras}<cite>{e(r["name"])}{h}</cite></blockquote>')
    return ''.join(out)

def w(path, content):
    p = os.path.join(D, path); os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'w', encoding='utf8').write(content)

# ---------------------------------------------------------------- HOME
def home():
    r = ''
    hs = C['hero']; pre = f"assets/img/{hs[0][0]}/{hs[0][0]}-{hs[0][1]:02d}.webp"
    t = head('Klemmenov — Photographer in Dubai',
             'Photographer in Dubai: personal portraits, event photography and commercial shoots. Prices in AED, booking on WhatsApp.',
             '', r, preload=None)
    tri = ''.join(f'<figure style="--i:{i}">{img(s, n, r, "(min-width:900px) 33vw, 50vw", alt, eager=True)}</figure>'
                  for i, ((s, n), alt) in enumerate(zip(hs, ['Evening on the Dubai coast', 'Mountain dusk, white dress', 'Seaside at sunset'])))
    col = C['collage']
    pe = ''.join(fig('personal', n, r, '(min-width:900px) 26vw, 45vw', 'Personal portrait shoot in Dubai', d=i*110) for i, n in enumerate(col['personal'][:3]))
    ev = ''.join(fig('events', n, r, '(min-width:900px) 40vw, 50vw', 'Event photography in Dubai', d=i*110) for i, n in enumerate(col['events'][:4]))
    co = ''.join(fig('commercial', n, r, '(min-width:900px) 24vw, 50vw', 'Commercial fashion and beauty photography', d=i*110) for i, n in enumerate(col['commercial'][:4]))
    t += f'''
<section class="ch-black hero" aria-labelledby="top">
<div class="tri">{tri}</div>
<div class="hero-row">
<p class="lead rv">Photographer in Dubai. Personal, event and commercial shoots.</p>
<a class="btn rv" style="--d:120ms" href="{wa()}">Book a shoot</a>
</div>
<h1 class="name" id="top" data-split>Klemmenov</h1>
</section>

<section class="ch-black pad" id="personal">
<div class="wrap">
<div class="chapter-head"><h2 class="rv">Personal</h2><p class="lead rv" style="--d:100ms">Portraits in the studio, on the coast and in the desert.</p></div>
<div class="col-personal">{pe}</div>
<div class="chapter-foot rv"><a class="more" href="personal/">Personal portfolio <span>→</span></a></div>
</div>
</section>

<section class="ch-burgundy pad" id="events">
<div class="wrap">
<div class="chapter-head"><h2 class="rv">Events</h2><p class="lead rv" style="--d:100ms">Conferences, talks, openings, parties and weddings.</p></div>
<div class="col-events">{ev}</div>
<div class="chapter-foot rv"><a class="more" href="events/">Event portfolio <span>→</span></a></div>
</div>
</section>

<section class="ch-white pad" id="commercial">
<div class="wrap">
<div class="chapter-head"><h2 class="rv">Commercial</h2><p class="lead rv" style="--d:100ms">Fashion, beauty and product photography for brands.</p></div>
<div class="col-commercial">{co}</div>
<div class="chapter-foot rv"><a class="more" href="commercial/">Commercial portfolio <span>→</span></a></div>
</div>
</section>

<section class="ch-black pad" id="price">
<div class="wrap calc">
<div>
<h2 class="rv" style="font-size:clamp(2.6rem,6vw,6rem)">Price your shoot</h2>
<p class="big-price rv" style="--d:100ms;margin-top:.15em">1,200<small>AED / hour</small></p>
<p class="lead rv" style="--d:160ms;margin-top:24px">Personal shoots start at 1,200 AED an hour. Commercial and event shoots are 1,500 AED an hour.</p>
</div>
<div class="rv" style="--d:120ms">
{calc_block(r)}
<p style="margin-top:22px"><a class="more" href="prices/">All prices and packages <span>→</span></a></p>
</div>
</div>
</section>

<section class="ch-burgundy pad" id="reviews">
<div class="wrap">
<div class="chapter-head"><h2 class="rv">Reviews</h2><a class="more rv" href="reviews/">All reviews <span>→</span></a></div>
<div class="quotes">{reviews_html(C['home_reviews'])}</div>
</div>
</section>

<section class="ch-black pad" id="book">
<div class="wrap">
<h2 class="rv" style="max-width:11ch">Book a shoot</h2>
<p class="lead rv" style="--d:100ms;margin:28px 0 36px">Write with the date and the type of shoot, and I’ll reply as soon as possible.</p>
<div class="rv" style="--d:160ms;display:flex;gap:12px;flex-wrap:wrap"><a class="btn" href="{wa('I would like to book a shoot.')}">WhatsApp</a><a class="btn" style="--acc:#171310;--acc-ink:#f1ece4" href="{C['telegram']}">Telegram</a><a class="btn" style="--acc:#171310;--acc-ink:#f1ece4" href="{C['instagram']}">Instagram</a></div>
</div>
</section>
'''
    t += foot(r)
    w('index.html', t)

# ---------------------------------------------------------------- GALLERIES
G = {
    'personal': ('ch-black', 'Personal', 'Personal portraits in Dubai — Klemmenov',
                 'Personal portrait photography in Dubai: studio, coast and desert shoots by Klemmenov.',
                 'Portraits in the studio, on the coast and in the desert.', 'Personal portrait shoot, Dubai', 'personal'),
    'events': ('ch-burgundy', 'Events', 'Event photography in Dubai — Klemmenov',
               'Event photographer in Dubai: conferences, talks, openings, parties and weddings.',
               'Conferences, talks, openings, parties and weddings.', 'Event photography, Dubai', 'event'),
    'commercial': ('ch-white', 'Commercial', 'Commercial photography in Dubai — Klemmenov',
                   'Commercial fashion, beauty and product photography in Dubai for brands.',
                   'Fashion, beauty and product photography for brands.', 'Commercial photography, Dubai', 'commercial'),
}
def gallery(key):
    cls, h, title, desc, lead, alt, svc = G[key]; r = '../'
    ex = set(C['exclude'].get(key, []))
    items = [int(x['id'].split('-')[1]) for x in M[key] if int(x['id'].split('-')[1]) not in ex]
    chips = [f'<a class="more" href="{r}{k}/" {"aria-current=page" if k==key else ""}>{G[k][1]}</a>' for k in G]
    t = head(title, desc, f'{key}/', r)
    t += f'''<section class="{cls}">
<div class="page-head"><h1 class="rv">{h}</h1>
<div class="row"><p class="lead rv" style="--d:80ms">{lead}</p><a class="btn rv" style="--d:140ms" href="{wa('Shoot: ' + next(x for x in C['hourly'] if x['id']==svc)['title'] + '.')}">Book a {h.lower()} shoot</a></div></div>
<div class="masonry">
'''
    for i, n in enumerate(items):
        m = meta(key, n); b = f"{r}assets/img/{key}/{m['id']}"
        t += (f'<a href="{b}.webp"><img src="{b}-t.webp" srcset="{b}-t.webp 560w, {b}.webp 1200w" sizes="(min-width:1200px) 25vw, (min-width:700px) 33vw, 50vw" '
              f'width="{m["w"]}" height="{m["h"]}" alt="{e(alt)} {i+1}" decoding="async"{" fetchpriority=high" if i<2 else " loading=lazy"}></a>\n')
    t += f'''</div>
<div class="wrap" style="padding-bottom:clamp(60px,8vw,110px);display:flex;gap:clamp(20px,4vw,60px);flex-wrap:wrap">{''.join(c for k,c in zip(G,chips) if k!=key)}<a class="more" href="{r}prices/">Prices <span>→</span></a></div>
</section>
'''
    t += foot(r)
    w(f'{key}/index.html', t)

# ---------------------------------------------------------------- PRICES
def prices():
    r = '../'
    t = head('Prices — Klemmenov, photographer in Dubai',
             'Photoshoot prices in AED: personal 1,200 an hour, commercial and event 1,500 an hour, studio packages from 5,100 AED.', 'prices/', r)
    rows = ''
    for h in C['hourly']:
        inc = ''.join(f'<li>{e(x)}</li>' for x in h['included'])
        notes = ''.join(f'<li>{e(x)}</li>' for x in h['notes'])
        rows += f'''<div class="rate rv"><div><h3>{e(h['name'])}</h3></div>
<div><p class="price">{h['rate']:,}<small>AED / hour</small></p></div>
<div><ul><li><strong>Included</strong></li>{inc}</ul><ul class="notes small"><li><strong>Notes</strong></li>{notes}</ul>
<a class="btn" href="{wa('Shoot: ' + h['title'] + '.')}">Book a slot</a></div></div>
'''
    pk = ''
    for p in C['packages']:
        inc = ''.join(f'<li>{e(x)}</li>' for x in p['included'])
        pk += f'''<div class="pkg rv"><h3>{e(p['name'])}</h3><p class="price">{p['price']:,}<small>AED</small></p><ul>{inc}</ul><a class="btn" href="{wa('Shoot: ' + p['name'] + '.')}">Book a slot</a></div>'''
    t += f'''<section class="ch-black">
<div class="page-head"><h1 class="rv">Prices</h1><div class="row"><p class="lead rv" style="--d:80ms">All prices in AED. Studio rental is not included in hourly shoots.</p></div></div>
<div class="wrap" style="padding-bottom:clamp(60px,8vw,110px)"><div class="calc"><div></div><div class="rv">{calc_block(r)}</div></div></div>
{rows}
</section>
<section class="ch-burgundy pad"><div class="wrap">
<h2 class="rv" style="font-size:clamp(2.6rem,6vw,6rem);margin-bottom:clamp(36px,5vw,70px)">Photoshoot Packages</h2>
<div class="pkgs">{pk}</div></div></section>
'''
    t += foot(r); w('prices/index.html', t)

# ---------------------------------------------------------------- REVIEWS
def reviews():
    r = '../'
    t = head('Reviews — Klemmenov, photographer in Dubai', 'What clients say about shoots with Klemmenov in Dubai.', 'reviews/', r)
    t += f'''<section class="ch-burgundy">
<div class="page-head"><h1 class="rv">Reviews</h1><div class="row"><p class="lead rv" style="--d:80ms">Words from clients, as they wrote them.</p><a class="btn rv" style="--d:140ms" href="{wa()}">Book a shoot</a></div></div>
<div class="wrap" style="padding-bottom:clamp(70px,10vw,150px)"><div class="quotes quotes-all">{reviews_html(all_=True)}</div></div>
</section>
'''
    t += foot(r); w('reviews/index.html', t)

# ---------------------------------------------------------------- CONTACT
def contact():
    r = '../'
    t = head('Contact — Klemmenov, photographer in Dubai', 'Book a photoshoot in Dubai: message Klemmenov on WhatsApp, Telegram or Instagram.', 'contact/', r)
    t += f'''<section class="ch-black">
<div class="page-head"><h1 class="rv">Contact</h1><div class="row"><p class="lead rv" style="--d:80ms">Photographer in Dubai. Write with the date and the type of shoot, and I’ll reply as soon as possible.</p></div></div>
<div class="wrap" style="padding-bottom:clamp(70px,10vw,150px)"><div class="contact-list">
<a class="rv" href="{wa('I would like to book a shoot.')}"><strong>WhatsApp</strong><span>+971 55 708 7169</span></a>
<a class="rv" style="--d:90ms" href="{C['telegram']}"><strong>Telegram</strong><span>@klemmenov</span></a>
<a class="rv" style="--d:180ms" href="{C['instagram']}"><strong>Instagram</strong><span>@klemmenov</span></a>
</div></div>
</section>
'''
    t += foot(r); w('contact/index.html', t)

def notfound():
    r = SITE + '/'
    t = head('Page not found — Klemmenov', 'Page not found.', '404.html', r)
    t += f'''<section class="ch-black"><div class="page-head"><h1>404</h1><div class="row"><p class="lead">This page does not exist.</p><a class="btn" href="{r}">Back to main</a></div></div></section>'''
    w('404.html', t + foot(r))

def seo():
    pages = ['', 'personal/', 'events/', 'commercial/', 'prices/', 'reviews/', 'contact/']
    w('sitemap.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      ''.join(f'<url><loc>{SITE}/{p}</loc></url>\n' for p in pages) + '</urlset>\n')
    w('robots.txt', f'User-agent: *\nAllow: /\nSitemap: {SITE}/sitemap.xml\n')
    w('.nojekyll', '')
    w('assets/favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0c0a09"/><text x="32" y="46" font-family="Georgia,serif" font-size="44" text-anchor="middle" fill="#c8a26b">K</text></svg>')

home(); [gallery(k) for k in G]; prices(); reviews(); contact(); notfound(); seo()
print('built', sorted(os.listdir(D)))
