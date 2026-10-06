// Where the page downloads DMI's radar scans: the local dev server's proxy
// (tools/dev-server.py), or the Cloudflare Worker (worker/) once deployed.
window.RAIN_CONFIG = {
  downloadBase: /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? "dmi/"
    : "https://rain-radar-denmark.WORKER-SUBDOMAIN.workers.dev/download/",
}
