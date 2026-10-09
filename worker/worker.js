// Cloudflare Worker: lets the web page download DMI's radar scans, and shares
// DMI's list of them.
//
//   /list          the scans of the last two hours over the map, as DMI's
//                  open-data API lists them, fetched once a minute at most and
//                  given to every visitor: DMI sees a few requests a minute
//                  however many people watch, not one per visitor every 5 min.
//   /download/NAME one scan. DMI's scan files come without CORS headers, so a
//                  browser may not read them; this fetches the scan, adds the
//                  header, and caches it: a scan never changes once published,
//                  so DMI sends each one to Cloudflare once.
//
// The list's query is fixed here, and only DMI composite file names are
// accepted (dk.com.YYYYMMDDHHMM.500_max.h5), so this cannot be used to fetch
// anything else.

const API = "https://opendataapi.dmi.dk/v1/radardata"
const NAME = /^dk\.com\.\d{12}\.500_max\.h5$/
// the map's data area, as the widget's MapModel.dmiBbox (west,south,east,north)
const BBOX = "5,53.9,16.5,58.5"
const LIST_HOURS = 2
const LIST_SECONDS = 60

export default {
  async fetch(request, env, ctx) {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS" }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors })
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: cors })

    const url = new URL(request.url)
    if (url.pathname === "/list") return list(url, ctx, cors)
    const name = url.pathname.replace(/^\/(download\/)?/, "")
    if (!NAME.test(name)) return new Response("not a DMI radar scan", { status: 404, headers: cors })

    const cache = caches.default
    const key = new Request(url.origin + "/download/" + name)
    let response = await cache.match(key)
    if (!response) {
      const upstream = await fetch(API + "/download/" + name)
      if (!upstream.ok) return new Response("DMI answered " + upstream.status, { status: upstream.status === 404 ? 404 : 502, headers: cors })
      response = new Response(upstream.body, {
        headers: {
          "Content-Type": "application/x-hdf5",
          "Cache-Control": "public, max-age=604800, immutable",
          ...cors,
        },
      })
      ctx.waitUntil(cache.put(key, response.clone()))
    }
    return response
  },
}

// DMI's list of the last LIST_HOURS of scans, the same query the page made
// itself before (RadarModel.buildItemsUrl), kept LIST_SECONDS. DMI publishes a
// scan every 10 minutes, 12-13 minutes after its time, so a list up to a
// minute old misses at most a minute of a new one.
async function list(url, ctx, cors) {
  const cache = caches.default
  const key = new Request(url.origin + "/list")
  let response = await cache.match(key)
  if (!response) {
    const end = new Date(), start = new Date(end.getTime() - LIST_HOURS * 3600000)
    const upstream = await fetch(API + "/collections/composite/items?bbox=" + encodeURIComponent(BBOX)
      + "&datetime=" + encodeURIComponent(start.toISOString() + "/" + end.toISOString()) + "&limit=300")
    if (!upstream.ok) return new Response("DMI answered " + upstream.status, { status: 502, headers: cors })
    response = new Response(await upstream.text(), {
      headers: {
        "Content-Type": "application/geo+json",
        "Cache-Control": "public, max-age=" + LIST_SECONDS,
        ...cors,
      },
    })
    ctx.waitUntil(cache.put(key, response.clone()))
  }
  return response
}
