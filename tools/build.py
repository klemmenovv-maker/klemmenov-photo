"""Generate every HTML page (EN at /, RU at /ru/) from content.json + i18n.json + docs/data/manifest.json.
Run: python3 tools/build.py   (after tools/optimize.py if photos changed)
Numbers, contacts, reviews, photo selection: content.json.  All visible words, EN and RU: i18n.json.
"""
import json, os, html, shutil, urllib.parse, hashlib
from pathlib import Path
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
SCHEDULE_API = (C.get('booking_schedule_api') or '').strip().rstrip('/')
if SCHEDULE_API:
    _s = urllib.parse.urlsplit(SCHEDULE_API)
    if not ((_s.scheme == 'https' or (_s.scheme == 'http' and _s.hostname in ('localhost', '127.0.0.1'))) and _s.hostname and not _s.username and not _s.password and not _s.query and not _s.fragment):
        raise SystemExit('booking_schedule_api must be an HTTPS URL (HTTP only for localhost)')
BOOKING_CFG = json.load(open(os.path.join(ROOT, 'worker', 'booking-config.json'), encoding='utf8'))
_assets = Path(ROOT) / 'docs' / 'assets'
PHONE = '+' + C['whatsapp']
ASSET_VERSION = hashlib.sha256(b''.join(p.read_bytes() for p in sorted([*_assets.glob('*.mjs'), _assets / 'style.css', _assets / 'app.js']))).hexdigest()[:12]
LANGS = ['en']   # RU: add 'ru' once i18n.json['ru']['wk'] is translated

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

NAVP = ['', 'work/', 'book/']

def head(x, title, desc, og='assets/og.jpg', noindex=False, extra=''):
    L = x.L; url = f'{SITE}/{x.pfx}{x.path}'
    alts = (''.join(f'<link rel="alternate" hreflang="{l}" href="{SITE}/{"ru/" if l=="ru" else ""}{x.path}">' for l in LANGS) + f'<link rel="alternate" hreflang="x-default" href="{SITE}/{x.path}">') if len(LANGS) > 1 else ''
    ld = json.dumps({"@context": "https://schema.org", "@type": "Photographer", "name": L['name_full'], "alternateName": "Klemmenov",
                     "url": f'{SITE}/', "image": f'{SITE}/{og}', "areaServed": "Dubai", "telephone": PHONE,
                     "address": {"@type": "PostalAddress", "addressLocality": "Dubai", "addressCountry": "AE"},
                     "knowsLanguage": ["en", "ru"], "sameAs": [C['instagram'], C['telegram']]}, ensure_ascii=False)
    def cur(p): return ' aria-current=page' if (p and x.path.startswith(p)) or (p == '' and x.path == '') or (p == 'work/' and x.path.split('/')[0] in CLS) else ''
    nav = ''.join(f'<li><a href="{x.home}{p}"{cur(p)}>{n}</a></li>' for n, p in zip(L['nav'], NAVP))
    other = 'ru/' if x.lang == 'en' else ''
    sw = '' if len(LANGS) < 2 else f'<a class="lang" href="{x.up}{other}{x.path}" hreflang="{"ru" if x.lang=="en" else "en"}" lang="{"ru" if x.lang=="en" else "en"}" aria-label="{L["switch_label"]}">{L["switch"]}</a>'
    return f'''<!doctype html>
<html lang="{x.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)}</title>
<meta name="description" content="{e(desc)}">
{'<meta name="robots" content="noindex">' + chr(10) if noindex else ''}<meta name="theme-color" content="#120d0c">
<link rel="canonical" href="{url}">
{alts}{extra}
<meta property="og:type" content="website"><meta property="og:site_name" content="Klemmenov"><meta property="og:locale" content="{"ru_RU" if x.lang=="ru" else "en_US"}">
<meta property="og:title" content="{e(title)}"><meta property="og:description" content="{e(desc)}">
<meta property="og:url" content="{url}"><meta property="og:image" content="{SITE}/{og}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="{x.up}assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="{x.up}assets/fonts.css">
<link rel="stylesheet" href="{x.up}assets/style.css?v={ASSET_VERSION}">
<script type="application/ld+json">{ld}</script>
<script>document.documentElement.className+=" js"</script>
</head>
<body>
<a class="skip" href="#main">{L['skip']}</a>
<header class="bar">
<a class="wordmark" href="{x.home or './'}">Klemmenov</a>
<nav aria-label="{L['menu']}"><ul>
{nav}
</ul></nav>
{sw}
<button class="burger" aria-label="{L['menu']}" aria-expanded="false"><i></i><i></i></button>
</header>
<main id="main">
'''

def foot(x):
    L = x.L
    keys = ['personal/', 'events/', 'commercial/', 'book/']
    links = ''.join(f'<a href="{x.home}{k}">{n}</a>' for k, n in zip(keys, L['foot_links']))
    if TERMS: links += ''.join(f'<a href="{x.home}{k}/">{L["legal_pages"][k]["link"]}</a>' for k in ('terms', 'privacy'))
    return f'''</main>
<footer>
<p class="lead">{L['foot_lead']}</p>
<div class="foot-links"><a href="{wa(x)}">WhatsApp</a><a href="{C['telegram']}">Telegram</a><a href="{C['instagram']}">Instagram</a></div>
<div class="foot-links">{links}</div>
<p class="legal">© <span data-year>2026</span> Klemmenov. {L['legal']}</p>
</footer>
<script src="{x.up}assets/app.js?v={ASSET_VERSION}" defer></script>
</body>
</html>
'''

def hourly(x):
    return [{**h, **x.L['hourly'][h['id']]} for h in C['hourly']]

def reviews_html(x, names=None):
    out = []
    for r in C['reviews']:
        if names and r['name'] not in names: continue
        paras = ''.join(f'<p>{e(p).replace(chr(10), "<br>")}</p>' for p in r['text'].split('\n\n'))
        h = f'<a href="https://www.instagram.com/{r["handle"]}/">@{r["handle"]}</a>' if r.get('handle') else ''
        ph = img(x, 'reviews', r['photo'], '(min-width:900px) 40vw, 92vw', x.L['alt']['review'].format(name=r['name'])) if r.get('photo') else ''
        k = len(out)
        out.append(f'<article class="review rv {"flip" if k % 2 else ""}" style="--d:{(k%3)*90}ms"><figure>{ph}</figure><blockquote class="quote">{paras}<cite>{e(r["name"])}{h}</cite></blockquote></article>')
    return ''.join(out)

def fitstyle(word):
    return ''

def w(lang, path, content):
    base = os.path.join(D, 'ru') if lang == 'ru' else D
    p = os.path.join(base, path); os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'w', encoding='utf8').write(content)

def card(x, key, n, count=None):  # one portfolio category card (home + hub): photo, amber title, text, pill
    L = x.L; ex = set(C['exclude'].get(key, []))
    pid = next(i for i in C['collage'][key] if i not in ex)
    cnt = f' data-count="{count}"' if count is not None else ''
    small = f'<p class="small">{count} {L["work_hub"]["count_label"]}</p>' if count is not None else ''
    return (f'<article class="card rv" style="--d:{n*90}ms"{cnt}><a href="{x.home}{key}/"><figure>{img(x, key, pid, "(min-width:900px) 30vw, 92vw", L["alt"][key])}</figure>'
            f'<h2>{L["ch"][key]}</h2>{small}<p>{L["ch_lead"][key]}</p><span class="btn">{L["home3"]["open"]}</span></a></article>')

# ---------------------------------------------------------------- HOME
def home(lang):
    x = Ctx(lang, ''); L = x.L; V = L['home3']; hs = C['hero']
    t = head(x, L['home']['title'], L['home']['desc'])
    tri = ''.join(f'<figure style="--i:{i}">{img(x, s, n, "(min-width:1100px) 20vw, (min-width:700px) 33vw, 50vw", L["alt"]["hero"][i % 3], eager=(i < 3))}</figure>' for i, (s, n) in enumerate(hs))
    cards = ''.join(card(x, key, k) for k, key in enumerate(CLS))
    t += f'''
<section class="ch-black hero" id="hero" aria-labelledby="top">
<div class="hero-text">
<h1 id="top" class="rv">{V['hero_h']}</h1>
<p class="lead rv" style="--d:100ms">{V['hero_lead']}</p>
<div class="actions rv" style="--d:180ms"><a class="btn" href="work/">{V['portfolio']}</a><a class="btn ghost" href="book/">{L['book']}</a></div>
</div>
<div class="tri">{tri}</div>
<a class="scroll" href="#work" aria-label="{V['scroll']}"><span aria-hidden="true">↓</span></a>
</section>

<section class="ch-black pad" id="work"><div class="wrap">
<h2 class="rv sub">{V['work_h']}</h2>
<div class="cards">{cards}</div>
</div></section>

<section class="ch-burgundy pad" id="book"><div class="wrap center">
<h2 class="rv sub">{V['book_h']}</h2>
<p class="lead rv" style="--d:100ms">{V['book_lead']}</p>
<div class="actions rv" style="--d:160ms"><a class="btn" href="book/">{L['book']}</a><a class="btn ghost" href="book/#message">{V['write']}</a></div>
</div></section>
'''
    w(lang, 'index.html', t + foot(x))

# ---------------------------------------------------------------- BOOK (week calendar, request mode) + WRITE ME + REVIEWS
def book(lang):
    x = Ctx(lang, 'book/'); L = x.L; B = L['wk']; W = L['write']
    hr = {h['id']: h for h in hourly(x)}
    info = {sid: {'name': hr[sid]['name'], 'lines': hr[sid]['included'] + hr[sid]['notes']}
            for sid, sv in C['services'].items() if sv['type'] == 'hourly'}   # three shoot types; packages are not offered online
    tabs = ''.join(f'<button type="button" role="tab" id="tab-{sid}" data-service="{sid}" aria-selected="false" tabindex="-1">{e(info[sid]["name"])}</button>' for sid in info)
    fixed = ''.join(
        f'<div class="xrow" data-addon="{aid}" data-max="{100 if aid == "extra_retouch" else 1 if aid == "rush" else 10}">'
        f'<div class="xtxt"><span class="xname" id="x-{aid}">{e(a["label"])}</span>'
        f'<span class="xunit">{e(B["unit_line"].format(price=money(a["price"], L), unit=B["units"][a["per"]]))}</span></div>'
        f'<div class="stepper" role="group" aria-labelledby="x-{aid}"><button type="button" class="minus" aria-label="{B["qty_less"]}: {e(a["label"])}">−</button>'
        f'<output>0</output><button type="button" class="plus" aria-label="{B["qty_more"]}: {e(a["label"])}">+</button></div></div>'
        for aid, a in C['fixed_addons'].items())
    quote = ''.join(
        f'<label class="opt"><input type="checkbox" name="quote" value="{qid}"><span><b>{e(B["quote_labels"][qid])}</b><small>{e(txt)}</small></span></label>'
        for qid, txt in C['quote_addons'].items())
    cfg = html.escape(json.dumps({'wa': C['whatsapp'], 'tg': C['telegram'], 'scheduleApi': SCHEDULE_API, 'terms': TERMS, 'horizonDays': BOOKING_CFG['horizonDays'],
        'openHour': 10, 'closeHour': 21, 'pkgMin': BOOKING_CFG['package_duration_min'], 'info': info, 'i': {k: v for k, v in B.items() if k not in ('title', 'desc', 'h1', 'lead')}}, ensure_ascii=False), quote=True)
    # write-me cards: WhatsApp prefilled; Telegram / Instagram copy the same text on tap
    msgs = ''
    for k, cd in enumerate(W['cards']):
        blocks = ''
        for lg in ('en', 'ru'):
            txt = cd[lg]; wlink = f"https://wa.me/{C['whatsapp']}?text={urllib.parse.quote(txt)}"
            blocks += (f'<div class="msg" lang="{lg}" data-msg="{lg}"><blockquote class="msg-text">{e(txt)}</blockquote>'
                       f'<div class="actions"><a class="btn" href="{wlink}" target="_blank" rel="noopener">{W["wa"]}</a>'
                       f'<a class="btn ghost" href="{C["telegram"]}" data-copy="{e(txt, quote=True)}" target="_blank" rel="noopener">{W["tg"]}</a>'
                       f'<a class="btn ghost" href="{C["instagram"]}" data-copy="{e(txt, quote=True)}" target="_blank" rel="noopener">{W["ig"]}</a>'
                       f'<button type="button" class="btn ghost js-only" data-copy="{e(txt, quote=True)}">{W["copy"]}</button></div></div>')
        msgs += (f'<article class="msg-card rv" style="--d:{k*90}ms"><div class="msg-head"><h3>{W["cards"][k]["title"]}</h3>'
                 f'<div class="langsw js-only" role="group" aria-label="Language"><button type="button" aria-pressed="true" data-lang="en">EN</button><button type="button" aria-pressed="false" data-lang="ru">RU</button></div></div>{blocks}</article>')
    contacts = (f'<a href="tel:{PHONE}"><strong>{W["phone"]}</strong><span>+971 54 537 7769</span></a>'
                f'<a href="{wa(x)}"><strong>WhatsApp</strong><span>+971 54 537 7769</span></a>'
                f'<a href="{C["telegram"]}"><strong>Telegram</strong><span>@klemmenov</span></a>'
                f'<a href="{C["instagram"]}"><strong>Instagram</strong><span>@klemmenov</span></a>')
    t = head(x, B['title'], B['desc'])
    t += f'''<section class="ch-black book">
<div class="page-head"><h1 class="rv">{B['h1']}</h1><p class="lead rv" style="--d:80ms">{B['lead']}</p></div>
<noscript><div class="wrap center"><p class="lead">{B['noscript']}</p><a class="btn" href="{wa(x)}">{B['noscript_btn']}</a></div></noscript>
<div class="wrap wk" data-wk="{cfg}">
<div class="wk-top">
<div class="tabs" role="tablist" aria-label="{B['tabs']}">{tabs}</div>
<div class="wk-card" data-card aria-live="polite"></div>
<details class="wk-extras" data-extras hidden><summary>{B['extras']}</summary>
<div class="xlist">{fixed}</div>
<h3 class="sub3">{B['extras_quote']}</h3><p class="small note">{B['quote_note']}</p>
<fieldset class="opts"><legend class="sr">{B['extras_quote']}</legend>{quote}</fieldset>
</details>
</div>
<div class="wk-cal">
<div class="wk-bar"><h2 class="wk-range" data-range aria-live="polite"></h2>
<div class="wk-nav"><button type="button" data-prev aria-label="{B['week_prev']}">‹</button><button type="button" data-next aria-label="{B['week_next']}">›</button><button type="button" class="today" data-today>{B['today']}</button></div></div>
<div class="wk-scroll"><div class="wk-grid" data-grid role="group" aria-label="{B['cal_label']}"></div></div>
<ul class="legend" aria-hidden="true"><li class="l-free">{B['legend'][0]}</li><li class="l-busy">{B['legend'][1]}</li><li class="l-closed">{B['legend'][2]}</li><li class="l-sel">{B['legend'][3]}</li></ul>
<p class="small note" data-status role="status">{B['loading']}</p>
<button type="button" class="linkbtn" data-retry hidden>{B['retry']}</button>
</div>
<div class="wk-bottom">
<p class="wk-chosen" data-chosen aria-live="polite">{B['pick']}</p>
<button type="button" class="btn" data-continue aria-disabled="true">{B['continue']}</button>
<form class="wk-details" data-details hidden novalidate>
<h2 class="sub3" id="wk-dh" tabindex="-1">{B['details']}</h2>
<div class="field" data-date-field hidden><label for="f-date">{B['date']}</label><input id="f-date" type="text" autocomplete="off" placeholder="{e(B['date_ph'])}"></div>
<div class="field"><label for="f-name">{B['name']}</label><input id="f-name" type="text" autocomplete="name" maxlength="80"></div>
<div class="field"><label for="f-reach">{B['reach']}</label><input id="f-reach" type="tel" autocomplete="tel" maxlength="120" placeholder="{e(B['reach_ph'])}"></div>
<div class="field"><label for="f-email">{B['email']}</label><input id="f-email" type="email" autocomplete="email" maxlength="120"></div>
<div class="field"><label for="f-loc">{B['location']}</label><select id="f-loc">{''.join(f'<option value="{k}">{e(v)}</option>' for k, v in B['locations'].items())}</select></div>
<div class="field" data-loc-field hidden><label for="f-loc-d">{B['location_d']}</label><input id="f-loc-d" type="text" maxlength="200" autocomplete="street-address"></div>
<div class="field"><label for="f-notes">{B['notes']}</label><textarea id="f-notes" rows="3" maxlength="1000" placeholder="{e(B['notes_ph'])}"></textarea></div>
<div class="field"><label class="opt"><input type="checkbox" id="f-terms"><span>{B['terms_check']}{(' <a href="../terms/">' + B['terms_link'] + '</a>') if TERMS else ''}</span></label></div>
<div class="actions">{('<button type="button" class="btn" data-submit>' + B['submit'] + '</button>') if SCHEDULE_API else ''}<a class="btn ghost" data-send href="{wa(x)}" target="_blank" rel="noopener">{B['send_wa']}</a><a class="btn ghost" data-send-tg href="{C['telegram']}" target="_blank" rel="noopener">{B['send_tg']}</a></div>
<p class="small note" data-submit-status role="status"></p>
<p class="small note">{B['note']}</p><p class="small note" data-copied role="status"></p>
</form>
</div>
</div>
</section>

<section class="ch-black pad" id="{W['id']}"><div class="wrap">
<h2 class="rv sub">{W['h']}</h2>
<p class="lead rv" style="--d:80ms">{W['lead']}</p>
<div class="msg-grid">{msgs}</div>
<p class="small note rv" data-msg-status role="status">{W['note']}</p>
</div></section>

<section class="ch-black pad" id="contacts"><div class="wrap">
<h2 class="rv sub">{W['contacts_h']}</h2>
<div class="contact-list">{contacts}</div>
</div></section>

<section class="ch-burgundy pad" id="reviews"><div class="wrap">
<h2 class="rv sub">{W['reviews_h']}</h2>
<p class="lead rv" style="--d:80ms">{W['reviews_lead']}</p>
<div class="reviews-all">{reviews_html(x)}</div>
</div></section>
'''
    t += foot(x).replace('</body>', f'<script type="module" src="../assets/book-week.mjs?v={ASSET_VERSION}"></script>\n</body>')
    w(lang, 'book/index.html', t)

def my(lang):  # client area: their own requests (token kept in the browser)
    x = Ctx(lang, 'my/'); A = x.L['my']
    d = ' '.join(f'data-{k}="{e(v, quote=True)}"' for k, v in A['js'].items())
    t = head(x, A['title'], A['desc'], noindex=True)
    t += f'''<section class="ch-black acct"><div class="page-head"><h1 class="rv">{A['h1']}</h1><p class="lead rv" style="--d:80ms">{A['lead']}</p></div>
<div class="wrap" data-my data-api="{e(SCHEDULE_API, quote=True)}" {d}>
<p class="note" data-status role="status"></p><div class="acct-list" data-list></div>
<div class="actions"><a class="btn" href="../book/">{A['new']}</a><a class="btn ghost" href="{wa(x)}">WhatsApp</a></div>
</div></section>
'''
    t += foot(x).replace('</body>', f'<script type="module" src="../assets/my-page.mjs?v={ASSET_VERSION}"></script>\n</body>')
    w(lang, 'my/index.html', t)

def admin():  # owner area, Russian, not indexed; every action needs the Google sign-in
    x = Ctx('en', 'admin/')
    t = head(x, 'Админка — Klemmenov', 'Заявки, заметки и напоминания.', noindex=True).replace('<html lang="en">', '<html lang="ru">')
    t += f'''<section class="ch-black acct"><div class="page-head"><h1>Заявки</h1><p class="lead">Только для владельца.</p></div>
<div class="wrap" data-admin data-api="{e(SCHEDULE_API, quote=True)}">
<p class="note" data-msg role="status"></p>
<div data-signin hidden><a class="btn" href="#">Войти через Google</a></div>
<div data-app hidden>
<div class="actions"><div class="acct-tabs" data-tabs></div><button type="button" class="btn ghost" data-logout>Выйти</button></div>
<div class="acct-list" data-list></div>
<h2 class="sub3">График свободности</h2><div data-chart class="acct-chart"></div>
</div></div></section>
'''
    t += foot(x).replace('</body>', f'<script type="module" src="../assets/admin-page.mjs?v={ASSET_VERSION}"></script>\n</body>')
    w('en', 'admin/index.html', t)

def redirect(lang, path, target, canon):  # old URLs keep working: meta refresh + canonical to the new page
    x = Ctx(lang, path); L = x.L
    t = head(x, L['book'], L['wk']['desc'], noindex=True, extra=f'<meta http-equiv="refresh" content="0; url={target}">').replace(f'<link rel="canonical" href="{SITE}/{x.pfx}{path}">', f'<link rel="canonical" href="{SITE}/{x.pfx}{canon}">')
    t += f'<section class="ch-black"><div class="page-head"><h1>{L["book"]}</h1><p class="lead"><a href="{target}">{L["book"]} →</a></p></div></section>'
    w(lang, path + 'index.html', t + foot(x))

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
    order = C.get('order', {}).get(key)               # optional hand-picked rhythm for the page; frames not listed follow in file order
    if order:
        pos = {n: i for i, n in enumerate(order)}
        items.sort(key=lambda it: pos.get(it[1], len(pos)) if it[0] == key else len(pos) + 1)
    return items

def gallery(lang, key):
    x = Ctx(lang, f'{key}/'); L = x.L; g = L['gal'][key]
    items = gallery_items(key)
    t = head(x, g['title'], g['desc'])
    word = L['ch'][key]
    ser = C.get('series', {}).get(key)
    cls = 'ch-paper' if ser else CLS[key]
    t += f'''<section class="{cls}">
<div class="page-head"><h1 class="rv" {fitstyle(word)}>{word}</h1>
<div class="row"><p class="lead rv" style="--d:80ms">{L['ch_lead'][key]}</p><a class="btn rv" style="--d:140ms" href="{x.home}book/?service={SVC[key]}">{L['ch_book'][key]}</a></div></div>
'''
    def tile(sk, n, i, sizes):
        m = meta(sk, n); b = f"{x.up}assets/img/{sk}/{m['id']}"
        return (f'<a href="{b}.webp"><img src="{b}-t.webp" srcset="{b}-t.webp 560w, {b}.webp 1200w" sizes="{sizes}" '
                f'width="{m["w"]}" height="{m["h"]}" alt="{e(L["alt"][key])} {i+1}" decoding="async"{" fetchpriority=high" if i < 2 else " loading=lazy"}></a>\n')
    if ser:   # 'series' layout: lead frames, then groups of frames under a quiet heading (frames keep their own proportions)
        SL = L['series'][key]; i = 0
        t += '<div class="pf-lead">\n'
        for n in ser['lead']:
            t += tile(key, n, i, '(min-width:900px) 32vw, 44vw'); i += 1
        t += '</div>\n'
        for g, gl in zip(ser['groups'], SL['groups']):
            t += (f'<div class="pf-block"><div class="pf-head"><h2>{gl["title"]}</h2><p>{gl["text"]}</p>'
                  f'<span class="pf-count">{len(g)} {SL["count"]}</span></div><div class="pf-grid">\n')
            for n in g:
                t += tile(key, n, i, '(min-width:900px) 30vw, 48vw'); i += 1
            t += '</div></div>\n'
    else:
        t += '<div class="masonry">\n'
        for i, (sk, n) in enumerate(items):
            t += tile(sk, n, i, '(min-width:1200px) 25vw, (min-width:700px) 33vw, 50vw')
    others = [k for k in CLS if k != key]
    more = ''.join(f'<a class="more" href="{x.home}{k}/">{L["ch_link"][k]} <span>→</span></a>' for k in others)
    t += f'''{'' if ser else '</div>'}
<div class="wrap" style="padding-bottom:clamp(60px,8vw,110px);display:flex;gap:clamp(20px,4vw,60px);flex-wrap:wrap">{more}<a class="more" href="{x.home}book/">{L['book']} <span>→</span></a></div>
</section>
'''
    w(lang, f'{key}/index.html', t + foot(x))

# ---------------------------------------------------------------- WORK HUB
def work(lang):
    x = Ctx(lang, 'work/'); L = x.L; H = L['work_hub']
    t = head(x, H['title'], H['desc'])
    cards = ''.join(card(x, key, k, count=len(gallery_items(key))) for k, key in enumerate(CLS))
    t += f'''<section class="ch-black">
<div class="page-head"><h1 class="rv">{H['h1']}</h1><p class="lead rv" style="--d:80ms">{H['lead']}</p></div>
<div class="wrap" style="padding-bottom:clamp(60px,8vw,110px)"><div class="cards">{cards}</div></div>
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

def notfound():
    x = Ctx('en', ''); x.up = SITE + '/'; x.home = SITE + '/'
    t = head(x, 'Page not found — Klemmenov', 'Page not found.').replace('<link rel="canonical" href="' + SITE + '/">', '')
    t += f'''<section class="ch-black"><div class="page-head"><h1 {fitstyle("404")}>404</h1><div class="row"><p class="lead">This page does not exist.</p><a class="btn" href="{SITE}/">Back to main</a></div></div></section>'''
    w('en', '404.html', t + foot(x))

def seo():
    pages = ['', 'work/', 'personal/', 'events/', 'commercial/', 'book/'] + (['terms/', 'privacy/'] if TERMS else [])
    if len(LANGS) < 2:
        urls = ''.join(f'<url><loc>{SITE}/{p}</loc></url>\n' for p in pages)
    else:
      urls = ''.join(f'<url><loc>{SITE}/{p}</loc><xhtml:link rel="alternate" hreflang="en" href="{SITE}/{p}"/><xhtml:link rel="alternate" hreflang="ru" href="{SITE}/ru/{p}"/></url>\n<url><loc>{SITE}/ru/{p}</loc><xhtml:link rel="alternate" hreflang="en" href="{SITE}/{p}"/><xhtml:link rel="alternate" hreflang="ru" href="{SITE}/ru/{p}"/></url>\n' for p in pages)
    w('en', 'sitemap.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' + urls + '</urlset>\n')
    w('en', 'robots.txt', f'User-agent: *\nAllow: /\nSitemap: {SITE}/sitemap.xml\n')
    w('en', '.nojekyll', '')
    w('en', 'assets/favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#120d0c"/><text x="32" y="47" font-family="Georgia,serif" font-size="44" text-anchor="middle" fill="#d2a971">K</text></svg>')

for lg in LANGS:
    home(lg); work(lg); [gallery(lg, k) for k in CLS]; book(lg); my(lg)
    redirect(lg, 'prices/', '../book/', 'book/'); redirect(lg, 'reviews/', '../book/#reviews', 'book/'); redirect(lg, 'contact/', '../book/#message', 'book/')
    shutil.rmtree(os.path.join(D, 'ru' if lg == 'ru' else '', 'book', 'thanks'), ignore_errors=True)
    shutil.rmtree(os.path.join(D, 'ru' if lg == 'ru' else '', 'book', 'cancelled'), ignore_errors=True)
if TERMS:
    for lg in LANGS: legal(lg, 'terms'); legal(lg, 'privacy')
else:   # gate closed: no stale legal pages
    for lg in LANGS:
        for k in ('terms', 'privacy'): shutil.rmtree(os.path.join(D, 'ru' if lg == 'ru' else '', k), ignore_errors=True)
admin(); notfound(); seo()

def pricing_assets():  # one source of truth: content.json -> JSON for the browser and the Worker
    keys = ['max_hours', 'services', 'deposit', 'fixed_addons', 'quote_addons']
    data = json.dumps({k: C[k] for k in keys}, ensure_ascii=False, indent=2) + '\n'
    os.makedirs(os.path.join(ROOT, 'worker'), exist_ok=True)
    for path in (os.path.join(D, 'assets', 'pricing.json'), os.path.join(ROOT, 'worker', 'pricing.json')):
        open(path, 'w', encoding='utf8').write(data)
    for f in ('pricing.mjs', 'book-ui.mjs', 'schedule.mjs', 'book-week.mjs', 'account.mjs', 'my-page.mjs', 'admin-page.mjs', 'request-client.mjs'):
        shutil.copyfile(os.path.join(ROOT, 'shared', f), os.path.join(D, 'assets', f))
pricing_assets()
print('built', sorted(os.listdir(D)))
