import json
import os
import sys
import tempfile
import unittest

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


if __name__ == "__main__":
    unittest.main()
