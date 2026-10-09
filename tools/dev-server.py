#!/usr/bin/env python3
"""Serves the site locally, as GitHub Pages and the Worker will:

  /             site/ (the page)
  /lib/X.js     the widget's JavaScript models, from a checkout of the widget
                repository ($WIDGET_DIR, else ../omarchy-rain-radar-denmark-widget)
  /dmi/NAME     a DMI radar scan, fetched from DMI (what the Worker's /download does)
  /dmi-list     DMI's list of the last two hours of scans (the Worker's /list)

usage: python3 tools/dev-server.py [port] [--site DIR]     then open http://localhost:8000/

With --site, serves a built folder (tools/build.sh DIR) as GitHub Pages would,
keeping only the /dmi/ proxies.
"""
import datetime
import http.server
import os
import re
import sys
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "site")
WIDGET = os.environ.get("WIDGET_DIR") or os.path.join(ROOT, "..", "omarchy-rain-radar-denmark-widget")
NAME = re.compile(r"^dk\.com\.\d{12}\.500_max\.h5$")
LIB = re.compile(r"^[A-Za-z]+\.js$")


SITE = None


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SITE or WEB, **kwargs)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/dmi-list":
            # the Worker's query (worker/worker.js: BBOX, two hours), uncached here
            end = datetime.datetime.now(datetime.timezone.utc)
            start = end - datetime.timedelta(hours=2)
            iso = lambda t: t.strftime("%Y-%m-%dT%H:%M:%S.000Z")
            url = ("https://opendataapi.dmi.dk/v1/radardata/collections/composite/items?bbox="
                   + urllib.parse.quote("5,53.9,16.5,58.5") + "&datetime="
                   + urllib.parse.quote(iso(start) + "/" + iso(end)) + "&limit=300")
            try:
                with urllib.request.urlopen(url, timeout=20) as r:
                    body = r.read()
            except Exception as e:
                return self.send_error(502, str(e))
            return self.reply(body, "application/geo+json")
        if path.startswith("/dmi/"):
            name = path[5:]
            if not NAME.match(name):
                return self.send_error(404)
            try:
                with urllib.request.urlopen("https://opendataapi.dmi.dk/v1/radardata/download/" + name, timeout=20) as r:
                    body = r.read()
            except Exception as e:
                return self.send_error(502, str(e))
            return self.reply(body, "application/x-hdf5")
        if path.startswith("/lib/") and not SITE:
            name = path[5:]
            if not LIB.match(name) or not os.path.isfile(os.path.join(WIDGET, name)):
                return self.send_error(404)
            with open(os.path.join(WIDGET, name), "rb") as f:
                return self.reply(f.read(), "text/javascript")
        return super().do_GET()

    def reply(self, body, ctype):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--site" in args:
        i = args.index("--site")
        SITE = os.path.abspath(args[i + 1])
        del args[i:i + 2]
    port = int(args[0]) if args else 8000
    print("http://localhost:%d/" % port)
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
