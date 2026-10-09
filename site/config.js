// Where the page gets DMI's radar: the local dev server's proxy
// (tools/dev-server.py), or the Cloudflare Worker (worker/) once deployed.
//   listUrl       the shared list of the last two hours of scans
//   downloadBase  one scan, by name
const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
window.RAIN_CONFIG = {
  listUrl: LOCAL ? "dmi-list" : "https://rain-radar-denmark.rainradardenmark.workers.dev/list",
  downloadBase: LOCAL ? "dmi/" : "https://rain-radar-denmark.rainradardenmark.workers.dev/download/",
}
