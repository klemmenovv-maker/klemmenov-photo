"""Generate every HTML page (EN at /, RU at /ru/) from content.json + i18n.json + docs/data/manifest.json.
Run: python3 tools/build.py   (after tools/optimize.py if photos changed)
Numbers, contacts, reviews, photo selection: content.json.  All visible words, EN and RU: i18n.json.
"""
import json, os, html, urllib.parse
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(ROOT, 'docs')
C = json.load(open(os.path.join(ROOT, 'content.json'), encoding='utf8'))
I = json.load(open(os.path.join(ROOT, 'i18n.json'), encoding='utf8'))
M = json.load(open(os.path.join(D, 'data', 'manifest.json')))
SITE = C['site_url'].rstrip('/')
e = html.escape
LANGS = ['en', 'ru']

class Ctx:  # per-page context
    def __init__(self, lang, path):
        self.L = I[lang]; self.lang = lang; self.path = path          # path: page path inside the language, e.g. 'prices/'
        depth = path.count('/') + (1 if lang == 'ru' else 0)
        self.up = '../' * depth                                         # to docs root (assets)
        self.home = '../' * path.count('/') or ''                       # to language home
        self.pfx = 'ru/' if lang == 'ru' else ''

def money(n, L):
    s = f'{n:,}'
    return s.replace(',', ' ') if L['lang'] == 'ru' else s

def wa(x, extra=''):
    t = x.L['wa_text'] + ((' ' + extra) if extra else '')
    return f"https://wa.me/{C['whatsapp']}?text={urllib.parse.quote(t)}"

def meta(setname, n):
    return next(m for m in M[setname] if m['id'] == f'{setname}-{n:02d}')

def img(x, setname, n, sizes, alt, eager=False):
    m = meta(setname, n); b = f"{x.up}assets/img/{setname}/{m['id']}"
    pri = ' fetchpriority="high"' if eager else ' loading="lazy"'
    return (f'<img src="{b}.webp" srcset="{b}-t.webp 560w, {b}.webp 1200w" sizes="{sizes}" '
            f'width="{m["w"]}" height="{m["h"]}" alt="{e(alt)}" decoding="async"{pri}>')

def fig(x, setname, n, sizes, alt, d=0):
    return f'<figure class="rv" style="--d:{d}ms">{img(x, setname, n, sizes, alt)}</figure>'

def strip(x, items):
    return '<div class="strip">' + ''.join(fig(x, s, n, '(min-width:900px) 25vw, 50vw', x.L['alt']['strip'], d=i*100) for i, (s, n) in enumerate(items)) + '</div>'

NAVP = ['', 'personal/', 'prices/', 'reviews/', 'contact/']

def head(x, title, desc, og='assets/og.jpg'):
    L = x.L; url = f'{SITE}/{x.pfx}{x.path}'
    alts = ''.join(f'<link rel="alternate" hreflang="{l}" href="{SITE}/{"ru/" if l=="ru" else ""}{x.path}">' for l in LANGS) + f'<link rel="alternate" hreflang="x-default" href="{SITE}/{x.path}">'
    ld = json.dumps({"@context": "https://schema.org", "@type": "Photographer", "name": L['name_full'], "alternateName": "Klemmenov",
                     "url": f'{SITE}/', "image": f'{SITE}/{og}', "areaServed": "Dubai", "address": {"@type": "PostalAddress", "addressLocality": "Dubai", "addressCountry": "AE"},
                     "knowsLanguage": ["en", "ru"], "sameAs": [C['instagram'], C['telegram']]}, ensure_ascii=False)
    nav = ''.join(f'<li><a href="{x.home}{p}"{" aria-current=page" if (p and x.path.startswith(p)) or (p == "" and x.path == "") else ""}>{n}</a></li>' for n, p in zip(L['nav'], NAVP))
    other = 'ru/' if x.lang == 'en' else ''
    sw = f'<li><a class="lang" href="{x.up}{other}{x.path}" hreflang="{"ru" if x.lang=="en" else "en"}" lang="{"ru" if x.lang=="en" else "en"}" aria-label="{L["switch_label"]}">{L["switch"]}</a></li>'
    return f'''<!doctype html>
<html lang="{x.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)}</title>
<meta name="description" content="{e(desc)}">
<meta name="theme-color" content="#0c0a09">
<link rel="canonical" href="{url}">
{alts}
<meta property="og:type" content="website"><meta property="og:site_name" content="Klemmenov"><meta property="og:locale" content="{"ru_RU" if x.lang=="ru" else "en_US"}">
<meta property="og:title" content="{e(title)}"><meta property="og:description" content="{e(desc)}">
<meta property="og:url" content="{url}"><meta property="og:image" content="{SITE}/{og}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="{x.up}assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="{x.up}assets/fonts.css">
<link rel="stylesheet" href="{x.up}assets/style.css">
<script type="application/ld+json">{ld}</script>
<script>document.documentElement.className+=" js"</script>
</head>
<body>
<a class="skip" href="#main">{L['skip']}</a>
<header class="bar">
<a class="wordmark" href="{x.home or './'}">Klemmenov</a>
<nav aria-label="{L['menu']}"><ul>
{nav}{sw}
</ul></nav>
<a class="btn" href="{wa(x)}">{L['book']}</a>
<button class="burger" aria-label="{L['menu']}" aria-expanded="false"><i></i><i></i></button>
</header>
<main id="main">
'''

def foot(x):
    L = x.L
    keys = ['personal/', 'events/', 'commercial/', 'prices/', 'reviews/']
    links = ''.join(f'<a href="{x.home}{k}">{n}</a>' for k, n in zip(keys, L['foot_links']))
    return f'''</main>
<footer>
<div class="foot-top">
<p class="lead">{L['foot_lead']}</p>
<div class="foot-links"><a href="{wa(x)}">WhatsApp</a><a href="{C['telegram']}">Telegram</a><a href="{C['instagram']}">Instagram</a></div>
<div class="foot-links">{links}</div>
</div>
<div class="name" aria-hidden="true">Klemmenov</div>
<p class="legal">© <span data-year>2026</span> Klemmenov. {L['legal']}</p>
</footer>
<script src="{x.up}assets/app.js" defer></script>
</body>
</html>
'''

def hourly(x):
    out = []
    for h in C['hourly']:
        t = x.L['hourly'][h['id']]; out.append({**h, **t})
    return out

def calc_block(x):
    cl = x.L['calc']
    svc = [{'label': cl[h['id']], 'title': h['title'], 'rate': h['rate'], 'min': h['min'],
            'note': cl['express'] if h['id'] == 'event' else cl['studio']} for h in hourly(x)]
    cfg = html.escape(json.dumps({'wa': C['whatsapp'], 'text': x.L['wa_text'], 'shoot': x.L['wa_shoot'], 'lang': x.lang, 'locale': x.L['locale'], 'c': cl, 'services': svc}, ensure_ascii=False), quote=True)
    return f'''<div class="calc-ui" data-calc="{cfg}">
<div class="calc-total" aria-live="polite"></div>
<p class="calc-note small"></p>
<div class="seg" role="group" aria-label="{cl['group']}"></div>
<div class="stepper"><button type="button" class="minus" aria-label="{cl['less']}">−</button><output aria-live="polite"></output><button type="button" class="plus" aria-label="{cl['more']}">+</button></div>
<a class="btn calc-book" href="{wa(x)}">{cl['book']}</a>
</div>'''

def reviews_html(names=None):
    out = []
    for r in C['reviews']:
        if names and r['name'] not in names: continue
        paras = ''.join(f'<p>{e(p).replace(chr(10), "<br>")}</p>' for p in r['text'].split('\n\n'))
        h = f'<a href="https://www.instagram.com/{r["handle"]}/">@{r["handle"]}</a>' if r.get('handle') else ''
        out.append(f'<blockquote class="quote rv" style="--d:{(len(out)%3)*90}ms">{paras}<cite>{e(r["name"])}{h}</cite></blockquote>')
    return ''.join(out)

def fitstyle(word):  # per-word fit for the giant headings (CSS reads --n)
    return f'style="--n:{len(word)}"'

def w(lang, path, content):
    base = os.path.join(D, 'ru') if lang == 'ru' else D
    p = os.path.join(base, path); os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'w', encoding='utf8').write(content)

# ---------------------------------------------------------------- HOME
def home(lang):
    x = Ctx(lang, ''); L = x.L; col = C['collage']; hs = C['hero']
    t = head(x, L['home']['title'], L['home']['desc'])
    tri = ''.join(f'<figure style="--i:{i}">{img(x, s, n, "(min-width:900px) 33vw, 50vw", a, eager=True)}</figure>' for i, ((s, n), a) in enumerate(zip(hs, L['alt']['hero'])))
    pe = ''.join(fig(x, 'personal', n, '(min-width:900px) 26vw, 45vw', L['alt']['personal'], d=i*110) for i, n in enumerate(col['personal'][:3]))
    ev = ''.join(fig(x, 'events', n, '(min-width:900px) 40vw, 50vw', L['alt']['events'], d=i*110) for i, n in enumerate(col['events'][:5]))
    co = ''.join(fig(x, 'commercial', n, '(min-width:900px) 24vw, 50vw', L['alt']['commercial'], d=i*110) for i, n in enumerate(col['commercial'][:4]))
    def head2(k, cls): return f'<div class="chapter-head"><h2 class="rv">{L["ch"][k]}</h2><p class="lead rv" style="--d:100ms">{L["ch_lead"][k]}</p></div>'
    foot_ = lambda k, href: f'<div class="chapter-foot rv"><a class="more" href="{href}">{L["ch_link"][k]} <span>→</span></a></div>'
    t += f'''
<section class="ch-black hero" aria-labelledby="top">
<div class="tri">{tri}</div>
<h1 class="name" id="top" data-split>Klemmenov</h1>
<div class="hero-row">
<p class="lead rv">{L['hero_lead']}</p>
<a class="btn rv" style="--d:120ms" href="{wa(x)}">{L['book']}</a>
</div>
</section>

<section class="ch-black pad" id="personal"><div class="wrap">
{head2('personal','')}
<div class="col-personal">{pe}</div>
{foot_('personal', 'personal/')}
</div></section>

<section class="ch-burgundy pad" id="events"><div class="wrap">
{head2('events','')}
<div class="col-events">{ev}</div>
{foot_('events', 'events/')}
</div></section>

<section class="ch-white pad" id="commercial"><div class="wrap">
{head2('commercial','')}
<div class="col-commercial">{co}</div>
{foot_('commercial', 'commercial/')}
</div></section>

<section class="ch-black pad" id="price"><div class="wrap calc">
<div>
<h2 class="rv sub">{L['price_h']}</h2>
<p class="big-price rv" style="--d:100ms">{money(1200, L)}<small>{L['price_unit']}</small></p>
<p class="lead rv" style="--d:160ms;margin-top:24px">{L['price_lead']}</p>
</div>
<div class="rv" style="--d:120ms">
{calc_block(x)}
<p style="margin-top:22px"><a class="more" href="prices/">{L['all_prices']} <span>→</span></a></p>
</div>
</div></section>

<section class="ch-burgundy pad" id="reviews"><div class="wrap">
<div class="chapter-head"><h2 class="rv">{L['reviews_h']}</h2><a class="more rv" href="reviews/">{L['all_reviews']} <span>→</span></a></div>
<div class="quotes">{reviews_html(C['home_reviews'])}</div>
</div></section>

<section class="ch-black pad" id="book"><div class="wrap">
<h2 class="rv" style="max-width:11ch">{L['book_h']}</h2>
<p class="lead rv" style="--d:100ms;margin:28px 0 36px">{L['book_lead']}</p>
<div class="rv" style="--d:160ms;display:flex;gap:12px;flex-wrap:wrap"><a class="btn" href="{wa(x, L['wa_book'])}">WhatsApp</a><a class="btn" style="--acc:#171310;--acc-ink:#efedea" href="{C['telegram']}">Telegram</a><a class="btn" style="--acc:#171310;--acc-ink:#efedea" href="{C['instagram']}">Instagram</a></div>
</div></section>
'''
    w(lang, 'index.html', t + foot(x))

# ---------------------------------------------------------------- GALLERIES
CLS = {'personal': 'ch-black', 'events': 'ch-burgundy', 'commercial': 'ch-white'}
SVC = {'personal': 'personal', 'events': 'event', 'commercial': 'commercial'}
def gallery(lang, key):
    x = Ctx(lang, f'{key}/'); L = x.L; g = L['gal'][key]
    ex = set(C['exclude'].get(key, []))
    items = [(key, int(m['id'].split('-')[1])) for m in M[key] if int(m['id'].split('-')[1]) not in ex]
    extra = C.get('extra_sets', {}).get(key)          # e.g. personal gets the 'creative' set mixed in
    if extra:
        ext = [(extra, int(m['id'].split('-')[1])) for m in M[extra]]
        step = max(3, len(items) // (len(ext) + 1))
        for j, it in enumerate(ext):
            items.insert(min(len(items), 2 + j * (step + 1)), it)
    sv = next(h for h in hourly(x) if h['id'] == SVC[key])
    t = head(x, g['title'], g['desc'])
    word = L['ch'][key]
    t += f'''<section class="{CLS[key]}">
<div class="page-head"><h1 class="rv" {fitstyle(word)}>{word}</h1>
<div class="row"><p class="lead rv" style="--d:80ms">{L['ch_lead'][key]}</p><a class="btn rv" style="--d:140ms" href="{wa(x, L['wa_shoot'] + ' ' + sv['title'] + '.')}">{L['ch_book'][key]}</a></div></div>
<div class="masonry">
'''
    for i, (sk, n) in enumerate(items):
        m = meta(sk, n); b = f"{x.up}assets/img/{sk}/{m['id']}"
        t += (f'<a href="{b}.webp"><img src="{b}-t.webp" srcset="{b}-t.webp 560w, {b}.webp 1200w" sizes="(min-width:1200px) 25vw, (min-width:700px) 33vw, 50vw" '
              f'width="{m["w"]}" height="{m["h"]}" alt="{e(L["alt"][key])} {i+1}" decoding="async"{" fetchpriority=high" if i < 2 else " loading=lazy"}></a>\n')
    others = [k for k in CLS if k != key]
    more = ''.join(f'<a class="more" href="{x.home}{k}/">{L["ch_link"][k]} <span>→</span></a>' for k in others)
    t += f'''</div>
<div class="wrap" style="padding-bottom:clamp(60px,8vw,110px);display:flex;gap:clamp(20px,4vw,60px);flex-wrap:wrap">{more}<a class="more" href="../prices/">{L['nav'][2]} <span>→</span></a></div>
</section>
'''
    w(lang, f'{key}/index.html', t + foot(x))

# ---------------------------------------------------------------- PRICES
def prices(lang):
    x = Ctx(lang, 'prices/'); L = x.L; P = L['prices']
    t = head(x, P['title'], P['desc'])
    rows = ''
    for h in hourly(x):
        inc = ''.join(f'<li>{e(s)}</li>' for s in h['included']); notes = ''.join(f'<li>{e(s)}</li>' for s in h['notes'])
        rows += f'''<div class="rate rv"><div><h3>{e(h['name'])}</h3></div>
<div><p class="price">{money(h['rate'], L)}<small>{P['per']}</small></p></div>
<div><ul><li><strong>{P['included']}</strong></li>{inc}</ul><ul class="notes small"><li><strong>{P['notes']}</strong></li>{notes}</ul>
<a class="btn" href="{wa(x, L['wa_shoot'] + ' ' + h['title'] + '.')}">{P['slot']}</a></div></div>
'''
    pk = ''
    for p, tr in zip(C['packages'], L['packages']):
        inc = ''.join(f'<li>{e(s)}</li>' for s in tr['included'])
        pk += f'''<div class="pkg rv"><h3>{e(tr['name'])}</h3><p class="price">{money(p['price'], L)}<small>{P['pk_unit']}</small></p><ul>{inc}</ul><a class="btn" href="{wa(x, L['wa_shoot'] + ' ' + tr['name'] + '.')}">{P['slot']}</a></div>'''
    t += f'''<section class="ch-black">
<div class="page-head"><h1 class="rv" {fitstyle(P['h1'])}>{P['h1']}</h1><div class="row"><p class="lead rv" style="--d:80ms">{P['lead']}</p></div></div>
<div class="wrap" style="padding-bottom:clamp(60px,8vw,110px)"><div class="calc"><div></div><div class="rv">{calc_block(x)}</div></div></div>
{strip(x, [('commercial', 13), ('personal', 35), ('events', 60), ('commercial', 3)])}
<div style="height:clamp(60px,8vw,110px)"></div>
{rows}
</section>
<section class="ch-burgundy pad"><div class="wrap">
<h2 class="rv sub" style="margin-bottom:clamp(36px,5vw,70px)">{P['pk_h']}</h2>
<div class="pkgs">{pk}</div></div></section>
'''
    w(lang, 'prices/index.html', t + foot(x))

def reviews(lang):
    x = Ctx(lang, 'reviews/'); L = x.L; R = L['reviews']
    t = head(x, R['title'], R['desc'])
    t += f'''<section class="ch-burgundy">
<div class="page-head"><h1 class="rv" {fitstyle(R['h1'])}>{R['h1']}</h1><div class="row"><p class="lead rv" style="--d:80ms">{R['lead']}</p><a class="btn rv" style="--d:140ms" href="{wa(x)}">{L['book']}</a></div></div>
{strip(x, [('events', 12), ('personal', 40), ('events', 53), ('commercial', 11)])}
<div class="wrap" style="padding-top:clamp(60px,8vw,110px);padding-bottom:clamp(70px,10vw,150px)"><div class="quotes quotes-all">{reviews_html()}</div></div>
</section>
'''
    w(lang, 'reviews/index.html', t + foot(x))

def contact(lang):
    x = Ctx(lang, 'contact/'); L = x.L; K = L['contact']
    t = head(x, K['title'], K['desc'])
    t += f'''<section class="ch-black">
<div class="page-head"><h1 class="rv" {fitstyle(K['h1'])}>{K['h1']}</h1><div class="row"><p class="lead rv" style="--d:80ms">{K['lead']}</p></div></div>
<div class="wrap" style="padding-bottom:clamp(70px,10vw,150px)"><div class="contact-list">
<a class="rv" href="{wa(x, L['wa_book'])}"><strong>WhatsApp</strong><span>+971 55 708 7169</span></a>
<a class="rv" style="--d:90ms" href="{C['telegram']}"><strong>Telegram</strong><span>@klemmenov</span></a>
<a class="rv" style="--d:180ms" href="{C['instagram']}"><strong>Instagram</strong><span>@klemmenov</span></a>
</div></div>
</section>
'''
    w(lang, 'contact/index.html', t + foot(x))

def notfound():
    x = Ctx('en', ''); x.up = SITE + '/'; x.home = SITE + '/'
    t = head(x, 'Page not found — Klemmenov', 'Page not found.').replace('<link rel="canonical" href="' + SITE + '/">', '')
    t += f'''<section class="ch-black"><div class="page-head"><h1 {fitstyle("404")}>404</h1><div class="row"><p class="lead">This page does not exist.</p><a class="btn" href="{SITE}/">Back to main</a></div></div></section>'''
    w('en', '404.html', t + foot(x))

def seo():
    pages = ['', 'personal/', 'events/', 'commercial/', 'prices/', 'reviews/', 'contact/']
    urls = ''.join(f'<url><loc>{SITE}/{p}</loc><xhtml:link rel="alternate" hreflang="en" href="{SITE}/{p}"/><xhtml:link rel="alternate" hreflang="ru" href="{SITE}/ru/{p}"/></url>\n<url><loc>{SITE}/ru/{p}</loc><xhtml:link rel="alternate" hreflang="en" href="{SITE}/{p}"/><xhtml:link rel="alternate" hreflang="ru" href="{SITE}/ru/{p}"/></url>\n' for p in pages)
    w('en', 'sitemap.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' + urls + '</urlset>\n')
    w('en', 'robots.txt', f'User-agent: *\nAllow: /\nSitemap: {SITE}/sitemap.xml\n')
    w('en', '.nojekyll', '')
    w('en', 'assets/favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0c0a09"/><text x="32" y="47" font-family="Georgia,serif" font-size="44" text-anchor="middle" fill="#c8a26b">K</text></svg>')

for lg in LANGS:
    home(lg); [gallery(lg, k) for k in CLS]; prices(lg); reviews(lg); contact(lg)
notfound(); seo()
print('built', sorted(os.listdir(D)), sorted(os.listdir(os.path.join(D, 'ru'))))
