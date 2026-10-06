// Cloudflare Worker: lets the web page download DMI's radar scans.
//
// DMI's open-data API lists its scans to any web page (it sends CORS headers),
// but the scan files themselves come without them, so a browser may not read
// them. This fetches a scan from DMI, adds the header, and caches it: a scan
// never changes once published, so DMI sends each one to Cloudflare once,
// however many people look.
//
// Only DMI composite file names are accepted (dk.com.YYYYMMDDHHMM.500_max.h5),
// so this cannot be used to fetch anything else.

const DMI = "https://opendataapi.dmi.dk/v1/radardata/download/"
const NAME = /^dk\.com\.\d{12}\.500_max\.h5$/

export default {
  async fetch(request, env, ctx) {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS" }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors })
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: cors })

    const url = new URL(request.url)
    const name = url.pathname.replace(/^\/(download\/)?/, "")
    if (!NAME.test(name)) return new Response("not a DMI radar scan", { status: 404, headers: cors })

    const cache = caches.default
    const key = new Request(url.origin + "/download/" + name)
    let response = await cache.match(key)
    if (!response) {
      const upstream = await fetch(DMI + name)
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
