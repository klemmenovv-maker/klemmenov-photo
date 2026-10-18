"""Static site checker: python3 tools/check_site.py [root]  (default: docs)."""
import os
import sys
from html.parser import HTMLParser
from urllib.parse import unquote

SKIP_PREFIXES = ("#", "mailto:", "tel:", "https:", "http:", "data:", "javascript:", "//")


class _Page(HTMLParser):
    def __init__(self):
        HTMLParser.__init__(self)
        self.urls = []      # (tag, url)
        self.imgs = []      # attrs dicts

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        for name in ("href", "src"):
            if a.get(name) is not None:
                self.urls.append((tag, a[name].strip()))
        if a.get("srcset"):
            for part in a["srcset"].split(","):
                part = part.strip()
                if part:
                    self.urls.append((tag, part.split()[0]))
        if tag == "img":
            self.imgs.append(a)


def _resolve(root, page_dir, url):
    path = unquote(url.split("#", 1)[0].split("?", 1)[0])
    base = root if path.startswith("/") else page_dir
    full = os.path.normpath(os.path.join(base, path.lstrip("/")))
    if os.path.isdir(full):
        full = os.path.join(full, "index.html")
    return os.path.isfile(full)


def check(root):
    """Return a list of problem messages for every .html file under root."""
    problems = []
    for dirpath, _dirs, files in os.walk(root):
        for fn in sorted(files):
            if not fn.endswith(".html"):
                continue
            fpath = os.path.join(dirpath, fn)
            rel = os.path.relpath(fpath, root)
            with open(fpath, encoding="utf-8") as f:
                parser = _Page()
                parser.feed(f.read())
            for tag, url in parser.urls:
                if not url or url.startswith(SKIP_PREFIXES):
                    continue
                if url.startswith("/"):
                    problems.append("%s: absolute path %s (must be relative)" % (rel, url))
                elif not _resolve(root, dirpath, url):
                    problems.append("%s: <%s> unresolved %s" % (rel, tag, url))
            for a in parser.imgs:
                src = a.get("src", "?")
                if a.get("alt") is None:
                    problems.append("%s: <img %s> missing alt" % (rel, src))
                if not a.get("width") or not a.get("height"):
                    problems.append("%s: <img %s> missing width/height" % (rel, src))
    return problems


if __name__ == "__main__":
    out = check(sys.argv[1] if len(sys.argv) > 1 else "docs")
    print("\n".join(out) if out else "ok")
    sys.exit(1 if out else 0)
