"""Generate every HTML page (EN at /, RU at /ru/) from content.json + i18n.json + docs/data/manifest.json.
Run: python3 tools/build.py   (after tools/optimize.py if photos changed)
Numbers, contacts, reviews, photo selection: content.json.  All visible words, EN and RU: i18n.json.
"""
import json, os, html, shutil, urllib.parse
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.environ.get('SITE_OUT') or os.path.join(ROOT, 'docs')   # SITE_OUT / SITE_CONTENT: tests build into a temp dir
C = json.load(open(os.environ.get('SITE_CONTENT') or os.path.join(ROOT, 'content.json'), encoding='utf8'))
I = json.load(open(os.path.join(ROOT, 'i18n.json'), encoding='utf8'))
M = json.load(open(os.path.join(D, 'data', 'manifest.json')))
SITE = C['site_url'].rstrip('/')
e = html.escape
TERMS = bool(C.get('terms_approved'))
if TERMS and not (C.get('terms_text') and C.get('privacy_text')):
    raise SystemExit('content.json: terms_approved is true but terms_text / privacy_text is empty; fill both lists or set terms_approved to false')
LANGS = ['en']   # add 'ru' back to rebuild the Russian version (strings are kept in i18n.json)

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

NAVP = ['', 'work/', 'prices/', 'reviews/', 'contact/']

def head(x, title, desc, og='assets/og.jpg'):
    L = x.L; url = f'{SITE}/{x.pfx}{x.path}'
    alts = (''.join(f'<link rel="alternate" hreflang="{l}" href="{SITE}/{"ru/" if l=="ru" else ""}{x.path}">' for l in LANGS) + f'<link rel="alternate" hreflang="x-default" href="{SITE}/{x.path}">') if len(LANGS) > 1 else ''
    ld = json.dumps({"@context": "https://schema.org", "@type": "Photographer", "name": L['name_full'], "alternateName": "Klemmenov",
                     "url": f'{SITE}/', "image": f'{SITE}/{og}', "areaServed": "Dubai", "address": {"@type": "PostalAddress", "addressLocality": "Dubai", "addressCountry": "AE"},
                     "knowsLanguage": ["en", "ru"], "sameAs": [C['instagram'], C['telegram']]}, ensure_ascii=False)
    nav = ''.join(f'<li><a href="{x.home}{p}"{" aria-current=page" if (p and x.path.startswith(p)) or (p == "" and x.path == "") else ""}>{n}</a></li>' for n, p in zip(L['nav'], NAVP))
    other = 'ru/' if x.lang == 'en' else ''
    sw = '' if len(LANGS) < 2 else f'<li><a class="lang" href="{x.up}{other}{x.path}" hreflang="{"ru" if x.lang=="en" else "en"}" lang="{"ru" if x.lang=="en" else "en"}" aria-label="{L["switch_label"]}">{L["switch"]}</a></li>'
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
    if TERMS: links += ''.join(f'<a href="{x.home}{k}/">{L["legal_pages"][k]["link"]}</a>' for k in ('terms', 'privacy'))
    bar = '' if x.path.startswith('book/') else f'<a class="bookbar" href="{x.home}book/">Book · from {money(min(sc["from"] for sc in C["service_cards"]), L)} AED</a>\n'
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
{bar}<script src="{x.up}assets/app.js" defer></script>
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

def reviews_html(x, names=None, mode='rows'):
    out = []
    for r in C['reviews']:
        if names and r['name'] not in names: continue
        paras = ''.join(f'<p>{e(p).replace(chr(10), "<br>")}</p>' for p in r['text'].split('\n\n'))
        h = f'<a href="https://www.instagram.com/{r["handle"]}/">@{r["handle"]}</a>' if r.get('handle') else ''
        ph = img(x, 'reviews', r['photo'], '(min-width:900px) 40vw, 92vw', x.L['alt']['review'].format(name=r['name'])) if r.get('photo') else ''
        k = len(out)
        out.append(f'<article class="review rv {"flip" if k % 2 else ""}" style="--d:{(k%3)*90}ms"><figure>{ph}</figure><blockquote class="quote">{paras}<cite>{e(r["name"])}{h}</cite></blockquote></article>')
    return ''.join(out)

def faq_html():
    return ''.join(f'<details class="rv"><summary>{e(f["q"])}</summary><p>{e(f["a"])}</p></details>' for f in C['faq'])

def fitstyle(word):  # per-word fit for the giant headings (CSS reads --n)
    return f'style="--n:{len(word)}"'

def w(lang, path, content):
    base = os.path.join(D, 'ru') if lang == 'ru' else D
    p = os.path.join(base, path); os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'w', encoding='utf8').write(content)

# ---------------------------------------------------------------- HOME
WORK = [('personal', 'personal'), ('events', 'events'), ('commercial', 'commercial')]   # (photo set, gallery page)

def work_ids(key, count=6):  # collage ids first, then the rest of the set; excluded ids never appear
    ex = set(C['exclude'].get(key, []))
    ids = [n for n in C['collage'][key] if n not in ex]
    for m in M[key]:
        n = int(m['id'].split('-')[1])
        if n not in ex and n not in ids: ids.append(n)
    return ids[:count]

def home(lang):
    x = Ctx(lang, ''); L = x.L; V = L['home_v2']; hs = C['hero']
    t = head(x, L['home']['title'], L['home']['desc'])
    tri = ''.join(f'<figure style="--i:{i}">{img(x, s, n, "(min-width:1100px) 20vw, (min-width:700px) 33vw, 50vw", L["alt"]["hero"][i % 3], eager=(i < 3))}</figure>' for i, (s, n) in enumerate(hs))
    hr = {h['id']: h for h in hourly(x)}
    tone = {'personal': 'ch-burgundy', 'event': 'ch-white', 'commercial': 'svc-tone'}
    cards = ''
    for k, sc in enumerate(C['service_cards']):
        h = hr[sc['id']]; bl = ''.join(f'<li>{e(b)}</li>' for b in sc['bullets'])
        cards += (f'<article class="svc {tone[sc["id"]]} rv" style="--d:{k*90}ms"><h3>{e(h["name"])}</h3>'
                  f'<p class="svc-price">{V["from_label"]} {money(sc["from"], L)} {V["unit"]}</p><ul>{bl}</ul>'
                  f'<a class="btn" href="book/?service={sc["id"]}">{V["book_cta"]}</a></article>')
    steps = ''.join(f'<li class="rv" style="--d:{k*90}ms"><h3>{e(st["title"])}</h3><p>{e(st["text"])}</p></li>' for k, st in enumerate(C['how_it_works']))
    work = ''
    for key, page in WORK:
        frames = ''.join(fig(x, key, n, '(min-width:900px) 30vw, 50vw', L['alt'][key], d=(i % 3) * 90) for i, n in enumerate(work_ids(key)))
        work += f'<div class="work-set"><h3 class="rv"><a href="{page}/">{L["ch"][key]} <span>→</span></a></h3><div class="work-grid">{frames}</div></div>'
    P = L['prices']; pk = ''
    pids = [k for k, v in C['services'].items() if v['type'] == 'package']
    for sid, p, tr in zip(pids, C['packages'], L['packages']):
        inc = ''.join(f'<li>{e(i)}</li>' for i in tr['included'])
        pk += (f'<article class="pkg rv"><h3>{e(tr["name"])}</h3><p class="price">{money(p["price"], L)}<small>{P["pk_unit"]}</small></p>'
               f'<ul>{inc}</ul><a class="btn" href="book/?service={sid}">{V["book_cta"]}</a></article>')
    faq = faq_html()
    t += f'''
<section class="ch-black hero" id="hero" aria-labelledby="top">
<div class="tri">{tri}</div>
<h1 class="name" id="top" data-split>Klemmenov</h1>
<div class="hero-row">
<div><p class="lead rv">{L['hero_lead']}</p><p class="from rv" style="--d:80ms">{e(V['hero_from'])}</p></div>
<a class="btn rv" style="--d:120ms" href="{wa(x)}">{L['book']}</a>
</div>
</section>

<section class="ch-black pad" id="services"><div class="wrap">
<h2 class="rv sub">{V['services_h']}</h2>
<div class="svc-grid">{cards}</div>
</div></section>

<section class="ch-burgundy pad" id="how"><div class="wrap">
<h2 class="rv sub">{V['how_h']}</h2>
<ol class="steps" role="list">{steps}</ol>
</div></section>

<section class="ch-black pad" id="work"><div class="wrap">
<div class="chapter-head"><h2 class="rv sub">{V['work_h']}</h2><a class="more rv" href="work/">{V['work_cta']} <span>→</span></a></div>
{work}
</div></section>

<section class="ch-white pad" id="packages"><div class="wrap">
<h2 class="rv sub">{V['packages_h']}</h2>
<div class="pkgs">{pk}</div>
</div></section>

<section class="ch-burgundy pad" id="reviews"><div class="wrap">
<div class="chapter-head"><h2 class="rv sub">{V['reviews_h']}</h2><a class="more rv" href="reviews/">{L['all_reviews']} <span>→</span></a></div>
<div class="reviews-home">{reviews_html(x, C['home_reviews'])}</div>
</div></section>

<section class="ch-black pad" id="faq"><div class="wrap">
<h2 class="rv sub">{V['faq_h']}</h2>
<div class="faq">{faq}</div>
</div></section>

<section class="ch-burgundy pad" id="book"><div class="wrap">
<h2 class="rv" style="max-width:11ch">{V['book_h']}</h2>
<p class="lead rv" style="--d:100ms;margin:28px 0 36px">{V['book_lead']}</p>
<div class="rv" style="--d:160ms;display:flex;gap:12px;flex-wrap:wrap"><a class="btn" href="{wa(x, L['wa_book'])}">WhatsApp</a><a class="btn" style="--acc:#171310;--acc-ink:#efedea" href="{C['telegram']}">Telegram</a><a class="btn" style="--acc:#171310;--acc-ink:#efedea" href="{C['instagram']}">Instagram</a></div>
</div></section>
'''
    w(lang, 'index.html', t + foot(x))

def book(lang):  # request mode: the page only builds a WhatsApp message, nothing is charged
    x = Ctx(lang, 'book/'); L = x.L; B = L['book_page']
    S, FA, QA = C['services'], C['fixed_addons'], C['quote_addons']
    def price_line(sv):
        if sv['type'] == 'hourly':
            return f"{money(sv['rate'], L)} {B['per_hour']}, {B['min_hours'].format(n=sv['min'], unit=B['hour'] if sv['min'] == 1 else B['hours'])}"
        return f"{money(sv['price'], L)} AED, {B['package_tag']}"
    cards = ''.join(
        f'<label class="opt"><input type="radio" name="service" value="{sid}"><span class="opt-t">{e(sv["label"])}</span>'
        f'<span class="opt-s">{e(price_line(sv))}</span></label>' for sid, sv in S.items())
    fixed = ''.join(
        f'<div class="xrow" data-addon="{aid}" data-max="{100 if aid == "extra_retouch" else 10}">'
        f'<div class="xtxt"><span class="xname" id="x-{aid}">{e(a["label"])}</span>'
        f'<span class="xunit">{e(B["unit_line"].format(price=money(a["price"], L), unit=B["units"][a["per"]]))}</span></div>'
        f'<div class="stepper" role="group" aria-labelledby="x-{aid}"><button type="button" class="minus" aria-label="{B["qty_less"]}: {e(a["label"])}">−</button>'
        f'<output>0</output><button type="button" class="plus" aria-label="{B["qty_more"]}: {e(a["label"])}">+</button></div></div>'
        for aid, a in FA.items())
    quote = ''.join(
        f'<label class="opt opt-check"><input type="checkbox" name="quote" value="{qid}"><span class="opt-t">{e(B["quote_labels"][qid])}</span>'
        f'<span class="opt-s">{e(txt)}</span></label>' for qid, txt in QA.items())
    cfg = html.escape(json.dumps({'wa': C['whatsapp'], 'greeting': L['wa_text'], 'quoteLabels': B['quote_labels'],
        'hour': B['hour'], 'hours': B['hours'], 'errors': B['errors'], 'perHour': B['per_hour'], 'currency': B['summary_currency'],
        'hoursText': B['summary_hours'], 'total': B['summary_total'], 'empty': B['summary_empty'], 'quoteWord': B['summary_quote'], 'packageNote': B['package_note']}, ensure_ascii=False), quote=True)
    st = B['steps']
    t = head(x, B['title'], B['desc'])
    t += f'''<section class="ch-black book">
<div class="page-head"><h1 class="rv" {fitstyle(B['h1'])}>{B['h1']}</h1></div>
<noscript><div class="wrap book-ns"><p class="lead">{B['noscript']}</p><a class="btn" href="{wa(x, L['wa_book'])}">{B['noscript_btn']}</a></div></noscript>
<div class="wrap book-nm" data-nomodule hidden><p class="lead">{B['noscript']}</p><a class="btn" href="{wa(x, L['wa_book'])}">{B['noscript_btn']}</a></div>
<div class="wrap book-app" data-book="{cfg}">
<form class="book-grid" novalidate>
<div class="book-steps">
<section class="step" data-step="service" aria-labelledby="h-service">
<h2 id="h-service"><span class="n">1</span>{st[0]}</h2>
<fieldset class="opts"><legend class="sr">{B['service_legend']}</legend>{cards}</fieldset>
<div class="hours" data-hours><span class="hlabel" id="hours-l">{B['hours_label']}</span>
<div class="stepper" role="group" aria-labelledby="hours-l"><button type="button" class="minus" aria-label="{B['hours_less']}">−</button><output>2</output><button type="button" class="plus" aria-label="{B['hours_more']}">+</button></div></div>
</section>
<section class="step" data-step="extras" aria-labelledby="h-extras">
<h2 id="h-extras"><span class="n">2</span>{st[1]}</h2>
<p class="small note" data-package-note hidden>{B['package_note']}</p>
<div class="xlist">{fixed}</div>
<h3 class="sub3">{B['extras_quote_h']}</h3>
<p class="small note">{B['quote_note']}</p>
<fieldset class="opts opts-q"><legend class="sr">{B['extras_quote_h']}</legend>{quote}</fieldset>
</section>
<section class="step" data-step="date" aria-labelledby="h-date">
<h2 id="h-date"><span class="n">3</span>{st[2]}</h2>
<div class="field"><label for="f-date">{B['date_label']}</label><input id="f-date" name="date" type="text" autocomplete="off" placeholder="{e(B['date_ph'])}"><p class="small note">{B['date_hint']}</p></div>
</section>
</div>
<aside class="summary" aria-labelledby="h-sum">
<h2 id="h-sum">{B['summary_h']}</h2>
<div data-summary aria-live="polite" aria-atomic="true"></div>
</aside>
<section class="step book-contact" data-step="contact" aria-labelledby="h-contact">
<h2 id="h-contact"><span class="n">4</span>{st[3]}</h2>
<div class="field"><label for="f-name">{B['name_label']}</label><input id="f-name" name="name" type="text" autocomplete="name"></div>
<div class="field"><label for="f-reach">{B['reach_label']}</label><input id="f-reach" name="reach" type="text" autocomplete="tel" placeholder="{e(B['reach_ph'])}"></div>
<div class="field"><label for="f-notes">{B['notes_label']}</label><textarea id="f-notes" name="notes" rows="3" placeholder="{e(B['notes_ph'])}"></textarea></div>
<a class="btn" data-request href="{wa(x, L['wa_book'])}" target="_blank" rel="noopener">{B['request_btn']}</a>
<p class="small note">{B['request_note']}</p>
</section>
</form>
</div>
</section>
'''
    fb = ("<script>window.bookFallback=function(){var m=document.querySelector('[data-nomodule]'),a=document.querySelector('.book-app');"
          "if(m)m.hidden=false;if(a)a.style.display='none'}</script>\n<script nomodule>bookFallback()</script>\n"
          '<script type="module" src="../assets/book.mjs" onerror="bookFallback()"></script>\n')
    t += foot(x).replace('</body>', fb + '</body>')
    w(lang, 'book/index.html', t)

# ---------------------------------------------------------------- GALLERIES
CLS = {'personal': 'ch-black', 'events': 'ch-burgundy', 'commercial': 'ch-white'}
SVC = {'personal': 'personal', 'events': 'event', 'commercial': 'commercial'}
def gallery_items(key):  # (set, n) of every frame in the gallery page; the hub counts with this too
    ex = set(C['exclude'].get(key, []))
    items = [(key, int(m['id'].split('-')[1])) for m in M[key] if int(m['id'].split('-')[1]) not in ex]
    extra = C.get('extra_sets', {}).get(key)          # e.g. personal gets the 'creative' set mixed in
    if extra:
        ext = [(extra, int(m['id'].split('-')[1])) for m in M[extra] if int(m['id'].split('-')[1]) not in set(C['exclude'].get(extra, []))]
        step = max(3, len(items) // (len(ext) + 1))
        for j, it in enumerate(ext):
            items.insert(min(len(items), 2 + j * (step + 1)), it)
    return items

def gallery(lang, key):
    x = Ctx(lang, f'{key}/'); L = x.L; g = L['gal'][key]
    items = gallery_items(key)
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

# ---------------------------------------------------------------- WORK HUB
def work(lang):
    x = Ctx(lang, 'work/'); L = x.L; H = L['work_hub']
    t = head(x, H['title'], H['desc'])
    cards = ''
    for k, key in enumerate(CLS):
        n = len(gallery_items(key)); ex = set(C['exclude'].get(key, []))
        pid = next(i for i in C['collage'][key] if i not in ex)
        cards += (f'<article class="series rv" style="--d:{k*90}ms" data-count="{n}"><a href="{x.home}{key}/">{img(x, key, pid, "(min-width:900px) 30vw, 92vw", L["alt"][key])}'
                  f'<h2>{L["ch"][key]}</h2><p class="small">{n} {H["count_label"]}</p><span class="more">{L["ch_link"][key]} <span>→</span></span></a></article>')
    t += f'''<section class="ch-black">
<div class="page-head"><h1 class="rv" {fitstyle(H['h1'])}>{H['h1']}</h1><div class="row"><p class="lead rv" style="--d:80ms">{H['lead']}</p></div></div>
<div class="wrap" style="padding-bottom:clamp(60px,8vw,110px)"><div class="series-grid">{cards}</div></div>
</section>
'''
    w(lang, 'work/index.html', t + foot(x))

# ---------------------------------------------------------------- LEGAL (only when content.json terms_approved is true)
def legal(lang, key):
    x = Ctx(lang, f'{key}/'); L = x.L; G = L['legal_pages'][key]
    secs = ''.join(f'<section class="rv"><h2 class="sub">{e(s["h"])}</h2>' + ''.join(f'<p>{e(p)}</p>' for p in s['p']) + '</section>' for s in C[f'{key}_text'])
    t = head(x, G['title'], G['desc'])
    t += f'''<section class="ch-black">
<div class="page-head"><h1 class="rv" {fitstyle(G['h1'])}>{G['h1']}</h1></div>
<div class="wrap legal-text" style="padding-bottom:clamp(60px,8vw,110px)">{secs}</div>
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
    addons = ''.join(f'<li class="rv"><span>{e(a)}</span><strong>{e(p)}</strong></li>' for a, p in L['addons']['items'])
    t += f'''<section class="ch-black">
<div class="page-head"><h1 class="rv" {fitstyle(P['h1'])}>{P['h1']}</h1><div class="row"><p class="lead rv" style="--d:80ms">{P['lead']}</p></div>
<nav class="jump rv" aria-label="{P['jump'][0]}"><a href="#rates">{P['jump'][0]}</a><a href="#packages">{P['jump'][1]}</a><a href="#addons">{P['jump'][2]}</a><a href="#faq">{P['jump'][3]}</a></nav></div>
<div class="wrap" style="padding-bottom:clamp(60px,8vw,110px)"><div class="calc"><div></div><div class="rv">{calc_block(x)}</div></div></div>
{strip(x, [('commercial', 13), ('personal', 35), ('events', 60), ('commercial', 3)])}
<div id="rates" style="height:clamp(60px,8vw,110px)"></div>
{rows}
</section>
<section class="ch-burgundy pad" id="packages"><div class="wrap">
<h2 class="rv sub" style="margin-bottom:clamp(36px,5vw,70px)">{P['pk_h']}</h2>
<div class="pkgs">{pk}</div></div></section>
<section class="ch-white pad" id="addons"><div class="wrap">
<h2 class="rv sub" style="margin-bottom:clamp(30px,4vw,56px)">{L['addons']['h']}</h2>
<ul class="addons">{addons}</ul>
<p class="lead rv" style="margin-top:clamp(28px,4vw,56px)">{L['addons']['note']}</p>
</div></section>
<section class="ch-black pad" id="faq"><div class="wrap">
<h2 class="rv sub">{P['faq_h']}</h2>
<div class="faq">{faq_html()}</div>
</div></section>
'''
    w(lang, 'prices/index.html', t + foot(x))

def reviews(lang):
    x = Ctx(lang, 'reviews/'); L = x.L; R = L['reviews']
    t = head(x, R['title'], R['desc'])
    t += f'''<section class="ch-burgundy">
<div class="page-head"><h1 class="rv" {fitstyle(R['h1'])}>{R['h1']}</h1><div class="row"><p class="lead rv" style="--d:80ms">{R['lead']}</p><a class="btn rv" style="--d:140ms" href="{wa(x)}">{L['book']}</a></div></div>
<div class="wrap" style="padding-top:clamp(20px,3vw,40px);padding-bottom:clamp(70px,10vw,150px)"><div class="reviews-all">{reviews_html(x)}</div></div>
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
    pages = ['', 'work/', 'personal/', 'events/', 'commercial/', 'prices/', 'reviews/', 'contact/', 'book/'] + (['terms/', 'privacy/'] if TERMS else [])
    if len(LANGS) < 2:
        urls = ''.join(f'<url><loc>{SITE}/{p}</loc></url>\n' for p in pages)
    else:
      urls = ''.join(f'<url><loc>{SITE}/{p}</loc><xhtml:link rel="alternate" hreflang="en" href="{SITE}/{p}"/><xhtml:link rel="alternate" hreflang="ru" href="{SITE}/ru/{p}"/></url>\n<url><loc>{SITE}/ru/{p}</loc><xhtml:link rel="alternate" hreflang="en" href="{SITE}/{p}"/><xhtml:link rel="alternate" hreflang="ru" href="{SITE}/ru/{p}"/></url>\n' for p in pages)
    w('en', 'sitemap.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' + urls + '</urlset>\n')
    w('en', 'robots.txt', f'User-agent: *\nAllow: /\nSitemap: {SITE}/sitemap.xml\n')
    w('en', '.nojekyll', '')
    w('en', 'assets/favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0c0a09"/><text x="32" y="47" font-family="Georgia,serif" font-size="44" text-anchor="middle" fill="#c8a26b">K</text></svg>')

for lg in LANGS:
    home(lg); work(lg); [gallery(lg, k) for k in CLS]; prices(lg); reviews(lg); contact(lg); book(lg)
if TERMS:
    for lg in LANGS: legal(lg, 'terms'); legal(lg, 'privacy')
else:   # gate closed: no stale legal pages
    for lg in LANGS:
        for k in ('terms', 'privacy'): shutil.rmtree(os.path.join(D, 'ru' if lg == 'ru' else '', k), ignore_errors=True)
notfound(); seo()

def pricing_assets():  # one source of truth: content.json -> JSON for the browser and the Worker
    keys = ['max_hours', 'services', 'deposit', 'fixed_addons', 'quote_addons']
    data = json.dumps({k: C[k] for k in keys}, ensure_ascii=False, indent=2) + '\n'
    os.makedirs(os.path.join(ROOT, 'worker'), exist_ok=True)
    for path in (os.path.join(D, 'assets', 'pricing.json'), os.path.join(ROOT, 'worker', 'pricing.json')):
        open(path, 'w', encoding='utf8').write(data)
    for f in ('pricing.mjs', 'book-ui.mjs'):
        shutil.copyfile(os.path.join(ROOT, 'shared', f), os.path.join(D, 'assets', f))
pricing_assets()
print('built', sorted(os.listdir(D)))
