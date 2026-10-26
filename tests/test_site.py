import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import check_site  # noqa: E402


def _check_html(html, files=()):
    with tempfile.TemporaryDirectory() as d:
        with open(os.path.join(d, "index.html"), "w", encoding="utf-8") as f:
            f.write(html)
        for name in files:
            p = os.path.join(d, name)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            open(p, "w").close()
        return check_site.check(d)


class _Home(HTMLParser):
    """Collects section ids, anchors (with the section they sit in) and the text of #hero."""

    def __init__(self):
        super().__init__()
        self.sections, self.links, self.hero_text, self.hero_btns = [], [], [], 0
        self._stack, self._cur = [], None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "section":
            self._cur = a.get("id")
            self.sections.append(self._cur)
        if tag == "a":
            self.links.append((self._cur, a.get("href", ""), a.get("class", "")))
            if self._cur == "hero" and "btn" in a.get("class", "").split():
                self.hero_btns += 1

    def handle_data(self, data):
        if self._cur == "hero":
            self.hero_text.append(data)


def _home():
    p = _Home()
    with open(os.path.join(ROOT, "docs", "index.html"), encoding="utf-8") as f:
        p.feed(f.read())
    return p


class SiteTests(unittest.TestCase):
    def test_pricing_json_matches_content(self):
        content = json.load(open(os.path.join(ROOT, "content.json"), encoding="utf-8"))
        keys = ["max_hours", "services", "deposit", "fixed_addons", "quote_addons"]
        expected = {k: content[k] for k in keys}
        for path in (os.path.join(ROOT, "docs", "assets", "pricing.json"),
                     os.path.join(ROOT, "worker", "pricing.json")):
            with open(path, encoding="utf-8") as f:
                self.assertEqual(json.load(f), expected, path)
        with open(os.path.join(ROOT, "shared", "pricing.mjs"), "rb") as a, \
                open(os.path.join(ROOT, "docs", "assets", "pricing.mjs"), "rb") as b:
            self.assertEqual(a.read(), b.read())

    def test_service_cards_match_pricing(self):
        content = json.load(open(os.path.join(ROOT, "content.json"), encoding="utf-8"))
        hourly = {h["id"]: h for h in content["hourly"]}
        cards = content["service_cards"]
        self.assertEqual([c["id"] for c in cards], ["personal", "event", "commercial"])
        for card in cards:
            h = hourly[card["id"]]
            self.assertEqual(card["from"], h["rate"])
            self.assertEqual(card["bullets"], h["included"])
        self.assertEqual(len(content["how_it_works"]), 4)
        self.assertTrue(content["faq"])
        for item in content["faq"]:
            answer = item["a"].lower()
            for word in ("refund", "cancel", "deposit", "delivery"):
                self.assertNotIn(word, answer)
        self.assertIs(content["terms_approved"], False)

    def test_current_site_has_no_problems(self):
        self.assertEqual(check_site.check(os.path.join(ROOT, "docs")), [])

    def test_checker_reports_broken_link(self):
        msgs = _check_html('<a href="nope/">x</a>')
        self.assertEqual(len(msgs), 1)
        self.assertIn("nope/", msgs[0])

    def test_folder_link_resolves_to_index(self):
        self.assertEqual(_check_html('<a href="ok/">x</a>', ["ok/index.html"]), [])

    def test_skips_external_and_fragments(self):
        html = '<a href="#a">a</a><a href="mailto:x@y.z">m</a><a href="https://e.com/">e</a>'
        self.assertEqual(_check_html(html), [])

    def test_absolute_assets_path_reported(self):
        msgs = _check_html('<link href="/assets/a.css" rel="stylesheet">', ["assets/a.css"])
        self.assertEqual(len(msgs), 1)
        self.assertIn("/assets/a.css", msgs[0])

    def test_srcset_missing_file(self):
        html = ('<img src="a.webp" srcset="a.webp 1x, b.webp 2x" width="1" height="1" alt="x">')
        msgs = _check_html(html, ["a.webp"])
        self.assertEqual(len(msgs), 1)
        self.assertIn("b.webp", msgs[0])

    def test_img_missing_alt_and_size(self):
        msgs = _check_html('<img src="a.webp">', ["a.webp"])
        self.assertEqual(len(msgs), 2)
        self.assertTrue(any("alt" in m for m in msgs))
        self.assertTrue(any("width" in m for m in msgs))

    def test_empty_alt_is_allowed(self):
        self.assertEqual(
            _check_html('<img src="a.webp" width="1" height="1" alt="">', ["a.webp"]), [])

    def test_home_structure(self):
        h = _home()
        self.assertEqual(h.sections, ["hero", "work", "book"])
        work = [(href, c) for sec, href, c in h.links if sec == "work"]
        for key in ("personal", "events", "commercial"):
            self.assertIn(f"{key}/", [href for href, _ in work])
        hero = [href for sec, href, c in h.links if sec == "hero" and "btn" in c.split()]
        self.assertEqual(hero, ["work/", "book/"])

    def test_nav_is_main_portfolio_book(self):
        p = _parse(os.path.join(ROOT, "docs", "index.html"))
        self.assertEqual(p.nav, [("Main", ""), ("Portfolio", "work/"), ("Book", "book/")])

    def test_old_pages_redirect_to_book(self):
        for page, target in (("prices", "../book/"), ("reviews", "../book/#reviews"), ("contact", "../book/#message")):
            t = open(os.path.join(ROOT, "docs", page, "index.html"), encoding="utf-8").read()
            self.assertIn(f'http-equiv="refresh" content="0; url={target}"', t, page)
            self.assertIn('rel="canonical" href="', t)
            self.assertIn("/book/\"", t.split('rel="canonical" href="')[1][:200], page)
            self.assertIn("noindex", t, page)

    def test_book_page_is_week_calendar(self):
        import html as h
        import re
        t = open(os.path.join(ROOT, "docs", "book", "index.html"), encoding="utf-8").read()
        cfg = json.loads(h.unescape(re.search(r'data-wk="([^"]*)"', t).group(1)))
        self.assertEqual(cfg["horizonDays"], 60)
        self.assertEqual(set(cfg["info"]), {"personal", "commercial", "event"})
        for needle in ("data-grid", "data-prev", "data-next", "data-today", 'role="tablist"', "data-continue", "data-details", "data-send"):
            self.assertIn(needle, t)
        self.assertEqual(t.count('role="tab"'), 3)
        self.assertRegex(t, r'<script type="module" src="\.\./assets/book-week\.mjs\?v=[a-f0-9]+"></script>')
        self.assertNotIn("<form class=\"book-grid\"", t)
        self.assertTrue(os.path.exists(os.path.join(ROOT, "docs", "assets", "book-week.mjs")))
        self.assertTrue(os.path.exists(os.path.join(ROOT, "docs", "assets", "pricing.json")))
        for gone in ("book.mjs", "book-live.mjs", "book-schedule.mjs", "book-status.mjs"):
            self.assertFalse(os.path.exists(os.path.join(ROOT, "docs", "assets", gone)), gone)

    def test_write_me_messages_and_contacts(self):
        import html as h
        import re
        import urllib.parse
        t = open(os.path.join(ROOT, "docs", "book", "index.html"), encoding="utf-8").read()
        i18n = json.load(open(os.path.join(ROOT, "i18n.json"), encoding="utf-8"))
        links = [h.unescape(m) for m in re.findall(r'href="(https://wa\.me/971545377769\?text=[^"]+)"', t)]
        for card in i18n["en"]["write"]["cards"]:
            for lg in ("en", "ru"):
                want = card[lg]
                self.assertIn(want, [urllib.parse.unquote(u.split("text=", 1)[1]) for u in links], want)
                self.assertIn(h.escape(want), t)
        self.assertEqual(len([m for m in re.findall(r'data-copy="', t)]), 12)
        self.assertIn('href="https://t.me/klemmenov"', t)
        self.assertIn('href="https://www.instagram.com/klemmenov/"', t)
        self.assertIn('href="tel:+971545377769"', t)
        self.assertIn('id="reviews"', t)
        self.assertIn('id="message"', t)
        self.assertGreaterEqual(t.count("<blockquote class=\"quote\">"), 3)

    def test_type_scale_has_five_sizes(self):
        import re
        css = open(os.path.join(ROOT, "docs", "assets", "style.css"), encoding="utf-8").read()
        css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
        sizes = set()
        for m in re.finditer(r"font-size:\s*([^;}]+)", css):
            v = m.group(1).strip()
            if "vw" in v or v.startswith("clamp") or v.startswith("calc") or v.startswith("min(") or v.startswith("var(--fs-"):
                continue
            sizes.add(v)
        tok = re.search(r"--fs-small:\s*([^;]+);", css).group(1).strip(), re.search(r"--fs-body:\s*([^;]+);", css).group(1).strip()
        self.assertEqual(tok, ("15px", "17px"))
        self.assertLessEqual(len(sizes | set(tok)), 6, sorted(sizes))

class _Links(HTMLParser):
    """Anchors with text, h3-card links, details count, ids, footer hrefs."""

    def __init__(self):
        super().__init__()
        self.anchors, self.ids, self.details, self.hrefs = [], [], 0, []
        self.nav, self._in_nav, self._a, self._txt = [], False, None, []
        self.card_text = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if a.get("id"):
            self.ids.append(a["id"])
        if tag == "details":
            self.details += 1
        if tag == "nav" and a.get("aria-label") == "Menu":
            self._in_nav = True
        if tag == "a":
            self.anchors.append(a)
            self.hrefs.append(a.get("href", ""))
            self._a = a
            self._txt = []

    def handle_endtag(self, tag):
        if tag == "nav":
            self._in_nav = False
        if tag == "a" and self._a is not None:
            if self._in_nav:
                self.nav.append(("".join(self._txt).strip(), self._a.get("href")))
            self._a = None

    def handle_data(self, data):
        if self._a is not None:
            self._txt.append(data)
        self.card_text.append(data)


def _parse(path):
    p = _Links()
    with open(path, encoding="utf-8") as f:
        p.feed(f.read())
    return p


def _build(content, out):
    env = dict(os.environ, SITE_CONTENT=content, SITE_OUT=out)
    return subprocess.run([sys.executable, os.path.join(ROOT, "tools", "build.py")],
                          cwd=ROOT, env=env, capture_output=True, text=True)


def _temp_site(approved, terms=None):
    with open(os.path.join(ROOT, "content.json"), encoding="utf-8") as f:
        content = json.load(f)
    content["terms_approved"] = approved
    if terms is not None:
        content["terms_text"], content["privacy_text"] = terms, terms
    tmp = tempfile.mkdtemp()
    out = os.path.join(tmp, "out")
    shutil.copytree(os.path.join(ROOT, "docs"), out, ignore=shutil.ignore_patterns("terms", "privacy"))
    cpath = os.path.join(tmp, "content.json")
    with open(cpath, "w", encoding="utf-8") as f:
        json.dump(content, f)
    return tmp, cpath, out


class WorkHubTests(unittest.TestCase):
    def test_work_hub_counts_match_galleries(self):
        hub = os.path.join(ROOT, "docs", "work", "index.html")
        with open(hub, encoding="utf-8") as f:
            html = f.read()
        self.assertIn("<h1", html)
        p = _parse(hub)
        for key in ("personal", "events", "commercial"):
            self.assertIn(f"../{key}/", p.hrefs)
            g = _parse(os.path.join(ROOT, "docs", key, "index.html"))
            n = sum(1 for a in g.anchors if a.get("href", "").endswith(".webp"))
            self.assertGreater(n, 0)
            self.assertIn(f'data-count="{n}"', html, key)

    def test_terms_gated(self):
        tmp, cpath, out = _temp_site(False)
        try:
            r = _build(cpath, out)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertFalse(os.path.exists(os.path.join(out, "terms")))
            self.assertFalse(os.path.exists(os.path.join(out, "privacy")))
            for root, _, files in os.walk(out):
                for fn in files:
                    if fn.endswith((".html", ".xml")):
                        t = open(os.path.join(root, fn), encoding="utf-8").read()
                        self.assertNotIn('href="terms/', t)
                        if fn.endswith(".xml"):
                            self.assertNotIn("/terms/", t)
                            self.assertNotIn("/privacy/", t)
                        self.assertNotRegex(t, r'href="(\.\./)*(terms|privacy)/')
            shutil.rmtree(tmp)
            terms = [{"h": "Scope", "p": ["Test paragraph."]}]
            tmp, cpath, out = _temp_site(True, terms)
            r = _build(cpath, out)
            self.assertEqual(r.returncode, 0, r.stderr)
            for d in ("terms", "privacy"):
                self.assertTrue(os.path.isfile(os.path.join(out, d, "index.html")))
            home = _parse(os.path.join(out, "index.html"))
            self.assertIn("terms/", home.hrefs)
            self.assertIn("privacy/", home.hrefs)
            sm = open(os.path.join(out, "sitemap.xml"), encoding="utf-8").read()
            self.assertIn("/terms/</loc>", sm)
            self.assertIn("/privacy/</loc>", sm)
            self.assertEqual(check_site.check(out), [])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_terms_true_without_text_raises(self):
        tmp, cpath, out = _temp_site(True)
        try:
            r = _build(cpath, out)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("terms_text", r.stderr)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
