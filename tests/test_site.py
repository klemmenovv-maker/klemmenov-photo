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

    def test_home_section_order(self):
        self.assertEqual(_home().sections, ["hero", "services", "how", "work", "packages",
                                            "reviews", "faq", "book"])

    def test_service_cards_link_to_book(self):
        hrefs = [h for sec, h, _ in _home().links if sec in ("services", "packages")]
        for sid in ("personal", "event", "commercial", "beauty", "premium"):
            self.assertIn(f"book/?service={sid}", hrefs)

    def test_home_hero_shows_from_price(self):
        self.assertIn("1,200", "".join(_home().hero_text))

    def test_home_no_duplicate_hero_cta(self):
        self.assertEqual(_home().hero_btns, 1)

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

    def test_mobile_book_bar_markup(self):
        import re
        docs = os.path.join(ROOT, "docs")
        seen = 0
        for dp, _, fs in os.walk(docs):
            for f in fs:
                if not f.endswith(".html"):
                    continue
                path = os.path.join(dp, f)
                rel = os.path.relpath(path, docs)
                html = open(path, encoding="utf-8").read()
                bars = re.findall(r'<a class="bookbar" href="([^"]*)">([^<]*)</a>', html)
                if rel.startswith("book" + os.sep):
                    self.assertEqual(bars, [], rel)
                    continue
                seen += 1
                self.assertEqual(len(bars), 1, rel)
                href, text = bars[0]
                self.assertIn("1,200 AED", text)
                if href.startswith("http"):
                    self.assertTrue(href.endswith("/book/"), rel)
                else:
                    target = os.path.normpath(os.path.join(dp, href))
                    self.assertEqual(target, os.path.join(docs, "book"), rel)
        self.assertGreater(seen, 5)

    def test_book_placeholder_exists(self):
        with open(os.path.join(ROOT, "docs", "book", "index.html"), encoding="utf-8") as f:
            html = f.read()
        self.assertIn("<h1", html)
        self.assertIn("wa.me", html)


    def test_book_stepper_aria_disabled_style(self):
        css = open(os.path.join(ROOT, "docs", "assets", "style.css"), encoding="utf-8").read()
        self.assertIn('.book .stepper button[aria-disabled="true"]', css)
        self.assertNotIn('stepper button:disabled', css)
        js = open(os.path.join(ROOT, "docs", "assets", "book.mjs"), encoding="utf-8").read()
        self.assertNotIn("request.setAttribute('aria-disabled'", js)

    def test_book_page_request_mode(self):
        import json, re
        with open(os.path.join(ROOT, "docs", "book", "index.html"), encoding="utf-8") as f:
            html = f.read()
        self.assertNotIn("Pay deposit", html)
        self.assertRegex(html, r'<script type="module" src="\.\./assets/book\.mjs(?:\?v=[a-f0-9]+)?"[^>]*></script>')
        for step in ("service", "extras", "date", "contact"):
            self.assertIn(f'data-step="{step}"', html)
        m = re.search(r"<noscript>(.*?)</noscript>", html, re.S)
        self.assertIsNotNone(m)
        self.assertIn("https://wa.me/", m.group(1))
        self.assertNotIn("terms", html.lower().split("<main")[1].split("</main>")[0])
        with open(os.path.join(ROOT, "content.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f).get("booking_api"), "")
        req = re.search(r'<a class="btn" data-request href="([^"]*)"[^>]*>', html)
        self.assertIsNotNone(req)
        self.assertTrue(req.group(1).startswith("https://wa.me/") and "text=" in req.group(1))
        self.assertNotIn("aria-disabled", req.group(0))
        self.assertIn("<script nomodule>", html)
        self.assertIn("data-nomodule", html)
        self.assertTrue(os.path.exists(os.path.join(ROOT, "docs", "assets", "book-ui.mjs")))
        self.assertTrue(os.path.exists(os.path.join(ROOT, "docs", "assets", "book.mjs")))


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


def _temp_site(approved, terms=None, api=None):
    with open(os.path.join(ROOT, "content.json"), encoding="utf-8") as f:
        content = json.load(f)
    content["terms_approved"] = approved
    if api is not None:
        content["booking_api"] = api
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
    def test_nav_work_points_to_hub(self):
        p = _parse(os.path.join(ROOT, "docs", "index.html"))
        self.assertEqual([t for t, _ in p.nav], ["Main", "Work", "Prices", "Reviews", "Contact"])
        self.assertEqual(dict(p.nav)["Work"], "work/")
        more = [h for sec, h, c in _home().links if sec == "work" and "more" in c.split()]
        self.assertEqual(more, ["work/"])

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

    def test_prices_has_faq_and_jump_links(self):
        path = os.path.join(ROOT, "docs", "prices", "index.html")
        p = _parse(path)
        for h in ("#rates", "#packages", "#addons", "#faq"):
            self.assertIn(h, p.hrefs)
        for i in ("rates", "packages", "addons", "faq"):
            self.assertIn(i, p.ids)
        content = json.load(open(os.path.join(ROOT, "content.json"), encoding="utf-8"))
        self.assertEqual(p.details, len(content["faq"]))

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


TERMS = [{"h": "Scope", "p": ["Test paragraph."]}]


class LiveBookTests(unittest.TestCase):
    def _read(self, out, *parts):
        with open(os.path.join(out, *parts), encoding="utf-8") as f:
            return f.read()

    def test_request_mode_output_unchanged(self):
        tmp, cpath, out = _temp_site(False, api="")
        try:
            r = _build(cpath, out)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(self._read(out, "book", "index.html"),
                             self._read(os.path.join(ROOT, "docs"), "book", "index.html"))
            self.assertFalse(os.path.exists(os.path.join(out, "book", "thanks")))
            self.assertFalse(os.path.exists(os.path.join(out, "book", "cancelled")))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_live_mode_builds_pages(self):
        import re
        tmp, cpath, out = _temp_site(True, TERMS, api="https://booking.example.test/")
        try:
            r = _build(cpath, out)
            self.assertEqual(r.returncode, 0, r.stderr)
            book = self._read(out, "book", "index.html")
            m = re.search(r'data-book="([^"]*)"', book)
            import html as h
            cfg = json.loads(h.unescape(m.group(1)))
            self.assertEqual(cfg["api"], "https://booking.example.test")
            self.assertEqual(cfg["horizonDays"], 60)
            self.assertIn("data-pay", book)
            self.assertIn("Pay deposit", book)
            self.assertIn("data-days", book)
            self.assertIn("Dubai time (UTC+4)", book)
            self.assertIn('href="../terms/"', book)
            self.assertIn('id="f-terms"', book)
            self.assertNotIn('id="f-date"', book)
            self.assertIn("data-request", book)
            self.assertIn("<noscript>", book)
            self.assertNotIn("noindex", book)
            for page in ("thanks", "cancelled"):
                t = self._read(out, "book", page, "index.html")
                self.assertIn('<meta name="robots" content="noindex">', t, page)
                self.assertNotIn("bookbar", t, page)
                self.assertIn('class="bar"', t, page)
                self.assertIn("<footer>", t, page)
                self.assertIn("https://wa.me/", t, page)
                self.assertIn('href="../"', t, page)
            thanks = self._read(out, "book", "thanks", "index.html")
            m = re.search(r'data-status="([^"]*)"', thanks)
            self.assertEqual(json.loads(h.unescape(m.group(1)))["api"], "https://booking.example.test")
            self.assertRegex(thanks, r'<script type="module" src="\.\./\.\./assets/book-status\.mjs"></script>')
            self.assertTrue(os.path.isfile(os.path.join(out, "assets", "book-status.mjs")))
            self.assertIn("15 minutes", self._read(out, "book", "cancelled", "index.html"))
            for fid, n in (("f-name", 80), ("f-reach", 120), ("f-notes", 1000)):
                self.assertRegex(book, rf'id="{fid}"[^>]*maxlength="{n}"')
            sm = self._read(out, "sitemap.xml")
            self.assertNotIn("/book/thanks/", sm)
            self.assertNotIn("/book/cancelled/", sm)
            self.assertEqual(check_site.check(out), [])
            # switching back to request mode removes the live-only pages
            with open(cpath, encoding="utf-8") as f:
                c = json.load(f)
            c["booking_api"] = ""
            with open(cpath, "w", encoding="utf-8") as f:
                json.dump(c, f)
            r = _build(cpath, out)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertFalse(os.path.exists(os.path.join(out, "book", "thanks")))
            self.assertFalse(os.path.exists(os.path.join(out, "book", "cancelled")))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_live_mode_allows_localhost_http(self):
        tmp, cpath, out = _temp_site(True, TERMS, api="http://localhost:8787")
        try:
            r = _build(cpath, out)
            self.assertEqual(r.returncode, 0, r.stderr)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_live_mode_requires_approved_terms(self):
        tmp, cpath, out = _temp_site(False, api="https://booking.example.test")
        try:
            r = _build(cpath, out)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("booking_api", r.stderr)
            self.assertIn("terms_approved", r.stderr)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_live_mode_rejects_bad_api(self):
        for api in ("http://booking.example.test", "ftp://x.test", "booking.example.test", "https://",
                    "https://u:p@booking.example.test", "https://booking.example.test/?a=1", "javascript:alert(1)"):
            tmp, cpath, out = _temp_site(True, TERMS, api=api)
            try:
                r = _build(cpath, out)
                self.assertNotEqual(r.returncode, 0, api)
                self.assertIn("booking_api", r.stderr, api)
            finally:
                shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
