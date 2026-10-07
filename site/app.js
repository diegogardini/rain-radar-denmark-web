// Rain Radar Denmark on the web: the Omarchy widget's own models (lib/*.js,
// copied from the widget repository at build time), DMI's scans converted in
// the browser (radar.js), and the map drawn as the widget draws it
// (RadarMap.qml in the widget repository).
"use strict"

const OBSERVED_SCANS = 7    // one hour of full-range scans, as the widget
const MOTION_SCANS = 4      // the nowcast's motion: the last 30 minutes
const FRAME_MS = 387        // one 10-minute step on screen, as the widget (twice 5% slower than the first 350)
const REFRESH_MS = 5 * 60000
const STORE_KEY = "rain-radar-denmark.place"

const $ = (id) => document.getElementById(id)
// ?at=2026-07-30T18:43Z replays a past moment (DMI keeps 180 days of scans)
const AT = Date.parse(new URLSearchParams(location.search).get("at") || "")
const now = () => isFinite(AT) ? AT : Date.now()
const L = {}                // the widget's models, by file name
const state = {
  items: [], scans: {}, frames: [], nowIndex: 0, nowcast: [], motion: null, hasEdgeGuess: false,
  index: 0, fraction: 0, playing: true, holdUntil: 0, place: null, error: "",
}

// ---- Loading the widget's models: each file is plain JavaScript that sets
// module.exports when there is a `module` (as in the widget's Node tests) ----

async function loadLib(name) {
  const text = await (await fetch("lib/" + name + ".js")).text()
  const module = { exports: {} }
  new Function("module", "exports", text)(module, module.exports)
  return module.exports
}

// ---- Radar ----

async function fetchItems() {
  const end = new Date(now()), start = new Date(end.getTime() - 2 * 3600000)
  const url = L.RadarModel.buildItemsUrl(L.MapModel.dmiBbox, start.toISOString(), end.toISOString())
  const res = await fetch(url)
  if (!res.ok) throw new Error("DMI's radar list answered " + res.status)
  let items = L.RadarModel.fullRangeOnly(L.RadarModel.parseItemsResponse(await res.text()))
  // a replay sees only what DMI had published by then (12-13 minutes after each scan)
  if (isFinite(AT)) items = items.filter((it) => Date.parse(it.datetime) <= AT - 13 * 60000)
  return items.slice(-OBSERVED_SCANS)
}

async function loadScan(item) {
  if (state.scans[item.id]) return state.scans[item.id]
  const res = await fetch(window.RAIN_CONFIG.downloadBase + item.id)
  if (!res.ok) throw new Error("scan " + item.id + ": " + res.status)
  const out = await convert(await res.arrayBuffer(), L.ColorScale.colorAt)
  L.FixedEchoes.fill(out.grid)
  const bitmap = await createImageBitmap(new ImageData(out.image.data, out.image.width, out.image.height))
  return (state.scans[item.id] = { id: item.id, datetime: item.datetime, grid: out.grid, bitmap })
}

// The nowcast as the widget builds it (DataService.computeRadarNowcast).
function buildNowcast() {
  const T = L.Timeline, I = L.Interpolation
  const run = T.trailingRegularRun(state.items, MOTION_SCANS, (it) => !!state.scans[it.id])
  if (run.length < 2) { state.nowcast = []; state.motion = null; return }
  const last = run[run.length - 1], prev = run[run.length - 2]
  const stepMin = T.stepMinutes(prev.datetime, last.datetime)
  const ageMin = (now() - Date.parse(last.datetime)) / 60000
  const steps = T.nowcastSteps(stepMin, ageMin, L.PointSeries.HORIZON_MINUTES, 150)
  const vectors = []
  for (let p = 0; p + 1 < run.length; p++) vectors.push(pairMotion(run[p].id, run[p + 1].id))
  const vector = I.meanMotion(vectors) || { dx: 0, dy: 0 }
  const grids = I.extrapolateSequence(state.scans[prev.id].grid, state.scans[last.id].grid, steps, 8, 6, null, vector)
  const times = T.nowcastTimes(last.datetime, stepMin, steps)
  state.motion = vector
  state.nowcast = grids.map((grid, i) => ({ time: times[i], grid }))
  state.hasEdgeGuess = grids.some((g) => g.fromEdge && g.values.some((v, i) => g.fromEdge[i] && v > 0.05))
}

const pairCache = {}
function pairMotion(a, b) {
  const key = a + "|" + b
  if (pairCache[key] === undefined) pairCache[key] = L.Interpolation.pairMotion(state.scans[a].grid, state.scans[b].grid, 8, 6) || false
  return pairCache[key] || null
}

function buildFrames() {
  const observed = state.items.filter((it) => state.scans[it.id]).map((it, i, all) => ({
    kind: "observed", time: it.datetime, scan: state.scans[it.id],
    // as the widget: a pair without a measurable motion (little rain on the map)
    // glides along the nowcast's 30-minute motion instead of standing still
    motion: (i + 1 < all.length ? pairMotion(it.id, all[i + 1].id) : null) || state.motion,
  }))
  const forecast = state.nowcast.map((s) => ({ kind: "forecast", time: s.time, grid: s.grid, motion: state.motion }))
  state.frames = observed.concat(forecast)
  state.nowIndex = observed.length
  if (state.index >= state.frames.length) state.index = 0
  layers.clear()
}

async function refresh() {
  try {
    const items = await fetchItems()
    if (!items.length) throw new Error("DMI lists no radar scans right now.")
    for (const it of items) {
      try { await loadScan(it) } catch (e) { console.warn(e) }
    }
    state.items = items
    for (const id of Object.keys(state.scans)) if (!items.some((it) => it.id === id)) delete state.scans[id]
    buildNowcast()
    buildFrames()
    state.error = state.frames.length ? "" : "Could not read DMI's radar scans."
  } catch (e) {
    state.error = state.frames.length ? "" : String(e.message || e)
  }
  $("map-status").textContent = state.error
  $("map-status").hidden = !state.error
  $("legend-edge").classList.toggle("on", state.hasEdgeGuess)
  updateForecast()
  draw()
}

// ---- The map (as RadarMap.qml) ----

const canvas = $("map")
const ctx = canvas.getContext("2d")
let size = { w: 0, h: 0, dpr: 1 }
const layers = new Map() // frame index -> offscreen canvas with that frame's rain

function colours() {
  const s = getComputedStyle(document.documentElement)
  const v = (n) => s.getPropertyValue(n).trim()
  return { fg: v("--fg"), surface: v("--surface"), pin: v("--rain") }
}
function rgba(hex, a) {
  const c = document.createElement("canvas").getContext("2d")
  c.fillStyle = hex
  const h = c.fillStyle
  if (h[0] === "#") {
    const n = parseInt(h.slice(1), 16)
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`
  }
  return h.replace(/rgba?\(([^)]+)\)/, (m, inner) => `rgba(${inner.split(",").slice(0, 3).join(",")},${a})`)
}
let theme = null

function resize() {
  const w = canvas.parentElement.clientWidth
  const h = Math.round((w - 16) / L.MapModel.aspect + 16)
  const dpr = Math.min(window.devicePixelRatio || 1, 3)
  canvas.style.height = h + "px"
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  size = { w, h, dpr }
  theme = colours()
  layers.clear()
}

const vp = () => L.MapModel.viewport(size.w, size.h)
const project = (lat, lon) => L.MapModel.project(lat, lon, size.w, size.h)
function mapRect() {
  const v = vp(), view = L.MapModel.view
  return { x: v.x, y: v.y, w: (view.east - view.west) * L.MapModel.longitudeScale * v.scale, h: (view.north - view.south) * v.scale }
}

function traceRings(c, rings) {
  c.beginPath()
  for (const ring of rings) {
    ring.forEach((pt, k) => { const p = project(pt[1], pt[0]); k ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y) })
    c.closePath()
  }
}
const neighbourRings = () => L.MapData.neighbours.flatMap((n) => n.rings)

function gridGeometry(grid) {
  const v = vp(), view = L.MapModel.view
  const cellW = (grid.bounds.east - grid.bounds.west) / grid.cols * L.MapModel.longitudeScale * v.scale
  const cellH = (grid.bounds.north - grid.bounds.south) / grid.rows * v.scale
  const drawW = cellW * 1.15, drawH = cellH * 1.15
  return {
    x0: v.x + (grid.bounds.west - view.west) * L.MapModel.longitudeScale * v.scale,
    y0: v.y + (view.north - grid.bounds.north) * v.scale,
    cellW, cellH, drawW, drawH, padX: (drawW - cellW) / 2, padY: (drawH - cellH) / 2,
  }
}

function hatch(c, opacity) {
  const p = document.createElement("canvas")
  p.width = p.height = 6
  const g = p.getContext("2d")
  g.strokeStyle = rgba(theme.fg, opacity)
  g.lineWidth = 1
  g.beginPath(); g.moveTo(0, 6); g.lineTo(6, 0); g.stroke()
  return c.createPattern(p, "repeat")
}

function drawCell(c, grid, geo, row, col, patterns) {
  const idx = row * grid.cols + col, value = grid.values[idx]
  if (value <= 0.05) return
  const guessed = patterns && grid.fromEdge && grid.fromEdge[idx]
  if (guessed) {
    c.fillStyle = patterns[value < 4 ? 0 : value < 15 ? 1 : 2]
    c.fillRect(geo.x0 + col * geo.cellW, geo.y0 + row * geo.cellH, geo.cellW, geo.cellH)
  } else {
    c.fillStyle = L.ColorScale.cssColorAt(value)
    c.fillRect(geo.x0 + col * geo.cellW - geo.padX, geo.y0 + row * geo.cellH - geo.padY, geo.drawW, geo.drawH)
  }
}

function drawObserved(c, scan) {
  const v = vp(), b = L.MapModel.bounds, m = mapRect(), grid = scan.grid
  const corner = project(b.north, b.west)
  const w = (b.east - b.west) * L.MapModel.longitudeScale * v.scale, h = (b.north - b.south) * v.scale
  // the fixed-echo cells come from the filled grid, cut out of the image
  const geo = gridGeometry(grid), cells = L.FixedEchoes.CELLS
  c.save()
  c.beginPath()
  c.rect(m.x, m.y, m.w, m.h)
  for (const [r, col] of cells) {
    const x = geo.x0 + col * geo.cellW, y = geo.y0 + r * geo.cellH
    c.moveTo(x, y); c.lineTo(x, y + geo.cellH); c.lineTo(x + geo.cellW, y + geo.cellH); c.lineTo(x + geo.cellW, y); c.closePath()
  }
  c.clip("nonzero")
  c.drawImage(scan.bitmap, corner.x, corner.y, w, h)
  c.restore()
  for (const [r, col] of cells) drawCell(c, grid, geo, r, col, null)
}

function rainLayer(i) {
  if (layers.has(i)) return layers.get(i)
  const f = state.frames[i]
  const layer = document.createElement("canvas")
  layer.width = canvas.width; layer.height = canvas.height
  const c = layer.getContext("2d")
  c.scale(size.dpr, size.dpr)
  c.globalAlpha = f.kind === "forecast" ? 0.85 : 1
  if (f.kind === "observed") drawObserved(c, f.scan)
  else {
    const geo = gridGeometry(f.grid), patterns = f.grid.fromEdge ? [0.35, 0.6, 0.9].map((o) => hatch(c, o)) : null
    for (let r = 0; r < f.grid.rows; r++) for (let col = 0; col < f.grid.cols; col++) drawCell(c, f.grid, geo, r, col, patterns)
  }
  layers.set(i, layer)
  return layer
}

function draw() {
  if (!size.w || !theme) return
  const c = ctx, m = mapRect()
  c.setTransform(size.dpr, 0, 0, size.dpr, 0, 0)
  c.clearRect(0, 0, size.w, size.h)
  c.save()
  c.beginPath(); c.rect(m.x, m.y, m.w, m.h); c.clip()
  traceRings(c, neighbourRings()); c.fillStyle = rgba(theme.fg, 0.045); c.fill()
  traceRings(c, L.MapData.denmarkRings); c.fillStyle = rgba(theme.fg, 0.08); c.fill()

  const f = state.frames[state.index]
  const frac = glide(f)
  if (f) {
    const g = f.grid || f.scan.grid, v = vp()
    let dx = 0, dy = 0
    if (frac > 0) {
      dx = frac * f.motion.dx * (g.bounds.east - g.bounds.west) / g.cols * L.MapModel.longitudeScale * v.scale
      dy = frac * f.motion.dy * (g.bounds.north - g.bounds.south) / g.rows * v.scale
    }
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.drawImage(rainLayer(state.index), Math.round(dx * size.dpr), Math.round(dy * size.dpr))
    c.setTransform(size.dpr, 0, 0, size.dpr, 0, 0)
  }

  traceRings(c, neighbourRings()); c.strokeStyle = rgba(theme.fg, 0.3); c.lineWidth = 0.8; c.setLineDash([]); c.stroke()
  traceRings(c, L.MapData.denmarkRings); c.strokeStyle = rgba(theme.fg, 0.75); c.lineWidth = 1.2
  if (f && f.kind === "forecast") c.setLineDash([1.5, 2.5])
  c.stroke(); c.setLineDash([])
  c.restore()
  c.strokeStyle = rgba(theme.fg, 0.14); c.lineWidth = 1; c.strokeRect(m.x, m.y, m.w, m.h)

  c.font = "9px " + getComputedStyle(document.body).fontFamily
  c.textAlign = "center"; c.textBaseline = "middle"; c.fillStyle = rgba(theme.fg, 0.4)
  for (const lab of L.MapData.labels) { const p = project(lab.lat, lab.lon); c.fillText(lab.name, p.x, p.y) }

  if (state.place && L.MapModel.inView(state.place.latitude, state.place.longitude)) {
    const p = project(state.place.latitude, state.place.longitude)
    c.beginPath(); c.arc(p.x, p.y, 13, 0, 2 * Math.PI); c.fillStyle = rgba(theme.pin, 0.18); c.fill()
    c.strokeStyle = rgba(theme.pin, 0.6); c.lineWidth = 1; c.stroke()
    c.beginPath(); c.arc(p.x, p.y, 5, 0, 2 * Math.PI); c.fillStyle = theme.pin; c.fill()
    c.strokeStyle = theme.surface; c.lineWidth = 2; c.stroke()
  }
  drawChrome(f)
  drawGraph(f)
}

// ---- The graph (graph.js, as PointGraph.qml) ----

const graphCanvas = $("graph")
const graphCtx = graphCanvas.getContext("2d")
let graphSize = { w: 0, h: 0, dpr: 1 }

// The box over Sweden, as the widget's (Panel.qml: 58.42 N 11.9 E to 56.35 N 16.42 E).
function placeGraphBox() {
  if (!size.w) return
  const tl = project(58.42, 11.9), br = project(56.35, 16.42), box = $("graph-box").style
  box.left = tl.x + "px"; box.top = tl.y + "px"
  box.width = (br.x - tl.x) + "px"; box.height = (br.y - tl.y) + "px"
}

function sizeGraph() {
  placeGraphBox()
  const w = graphCanvas.clientWidth, h = graphCanvas.clientHeight
  if (!w || !h) return
  const dpr = Math.min(window.devicePixelRatio || 1, 3)
  if (w === graphSize.w && h === graphSize.h && dpr === graphSize.dpr) return
  graphCanvas.width = Math.round(w * dpr)
  graphCanvas.height = Math.round(h * dpr)
  graphSize = { w, h, dpr }
}

// the time the map shows, gliding between steps as the map does
function cursorMs(f) {
  if (!f) return -1
  const t = Date.parse(f.time), next = state.frames[state.index + 1], g = glide(f)
  return g > 0 && next ? t + g * (Date.parse(next.time) - t) : t
}

function drawGraph(f) {
  if ($("graph-box").hidden || !state.series) return
  sizeGraph()
  if (!graphSize.w) return
  const s = getComputedStyle(document.documentElement)
  graphCtx.setTransform(graphSize.dpr, 0, 0, graphSize.dpr, 0, 0)
  drawPointGraph(graphCtx, graphSize.w, graphSize.h, {
    series: state.series, chance: state.chanceSteps, cursorMs: cursorMs(f), GraphModel: L.GraphModel,
    fg: theme.fg, accent: s.getPropertyValue("--rain").trim(), chanceColor: s.getPropertyValue("--chance").trim(),
    font: (graphSize.w < 260 ? "9px " : "11px ") + getComputedStyle(document.body).fontFamily, rgba, clock, shownMs,
  })
}


// The time shown for a moment of the animation: to the nearest 10 minutes,
// as the widget (Timeline.shownMs); the rain still glides on exactly.
const shownMs = (ms) => Math.round(ms / 600000) * 600000

function clock(ms) {
  const d = new Date(ms)
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0")
}

function drawChrome(f) {
  const badge = $("badge")
  badge.hidden = !f
  if (f) {
    badge.textContent = (f.kind === "observed" ? "PAST" : "PROJECTED") + "  " + clock(shownMs(cursorMs(f)))
  }
  const n = state.frames.length
  const pos = n > 1 ? (state.index + glide(f)) / (n - 1) : 0
  $("fill").style.width = (pos * 100) + "%"
  const showNow = n > 1 && state.nowIndex > 0 && state.nowIndex < n
  $("now-tick").hidden = $("now-label").hidden = !showNow
  if (showNow) {
    const x = state.nowIndex / (n - 1) * 100
    $("now-tick").style.left = `calc(${x}% - 1px)`
    $("now-label").style.left = x + "%"
  }
}

// ---- Playback (as PlaybackController.qml, gliding continuously) ----

// How far the current frame has glided along its motion (0 to <1): the
// last frame, and a frame without a measured motion, step whole.
function glide(f) {
  return f && f.motion && state.index < state.frames.length - 1 ? state.fraction : 0
}

let last = 0
function tick(t) {
  const dt = last ? Math.min(t - last, 100) : 0
  last = t
  if (state.frames.length > 1 && state.playing && t >= state.holdUntil) {
    state.fraction += dt / FRAME_MS
    if (state.fraction >= 1) { state.fraction = 0; state.index = (state.index + 1) % state.frames.length }
    draw()
  }
  requestAnimationFrame(tick)
}

function seekTo(x) {
  const r = $("track").getBoundingClientRect(), n = state.frames.length
  if (n < 2) return
  state.index = Math.max(0, Math.min(n - 1, Math.round((x - r.left) / r.width * (n - 1))))
  state.fraction = 0
  state.holdUntil = performance.now() + 4000
  draw()
}

// ---- The place and the forecast (as Panel.qml) ----

function placeOf(m) {
  // a quick-pick city as on its chip (name and point), else the place itself
  const city = L.LocationModel.cityByName(m.name)
  return city ? { name: city.name, latitude: city.latitude, longitude: city.longitude }
    : { name: m.name, latitude: m.latitude, longitude: m.longitude }
}

function setPlace(place, save = true) {
  state.place = place
  if (save) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(place)) } catch (e) { /* private mode */ }
  }
  showPlaces(false)
  updateForecast()
  draw()
}

function updateForecast() {
  const p = state.place
  $("place-name").textContent = p ? p.name : "Pick a place"
  $("change-place").hidden = !p
  const ready = p && state.nowcast.length
  $("summary").hidden = $("chances").hidden = $("graph-box").hidden = !ready
  $("stale").hidden = true
  state.series = null
  state.chanceSteps = []
  if (!ready) return
  const PS = L.PointSeries, CM = L.ChanceModel
  const observed = state.items.filter((it) => state.scans[it.id]).map((it) => ({ time: it.datetime, grid: state.scans[it.id].grid }))
  const series = PS.build(observed, state.nowcast, p.latitude, p.longitude, now())
  const chance = CM.compute(state.nowcast, p.latitude, p.longitude, series.scanMs, undefined, series.nowMs)
  const rainChance = chance ? CM.rainWithin(chance, PS.coveredMinutes(series)) : null
  const dryBy = chance ? CM.dryForGoodBy(chance, 1 - PS.NO_RAIN_CHANCE) : undefined
  state.series = series
  state.chanceSteps = chance ? chance.steps : []
  sizeGraph()
  $("summary").textContent = PS.summary(series, rainChance, dryBy)
  const parts = CM.parts(chance, PS.currentMm(series))
  const box = $("chances")
  box.replaceChildren()
  box.hidden = !parts
  if (parts) {
    const title = document.createElement("span")
    title.className = "title"; title.textContent = parts.title
    box.append(title)
    for (const it of parts.items) {
      const cell = document.createElement("span")
      cell.className = "cell"
      cell.innerHTML = "<small></small><b></b>"
      cell.querySelector("small").textContent = it.label
      cell.querySelector("b").textContent = it.percent
      box.append(cell)
    }
  }
  const age = series.scanMs === null ? 0 : Math.round((now() - series.scanMs) / 60000)
  if (age > 45) {
    $("stale").hidden = false
    $("stale").textContent = "Radar from " + clock(series.scanMs) + " · " + PS.formatLead(age) + " ago · DMI may be delayed"
  }
}

function showPlaces(open) {
  $("places").hidden = !open
  $("places-hint").hidden = !!state.place
  $("change-place").textContent = open && state.place ? "Done" : "Change place"
  if (open) {
    $("search").value = ""
    $("results").replaceChildren()
    $("locate-note").hidden = true
    if (state.place) $("card").scrollIntoView({ behavior: "smooth", block: "start" })
  }
}

function pickOnMap(evt) {
  const r = canvas.getBoundingClientRect()
  const ll = L.MapModel.unproject(evt.clientX - r.left, evt.clientY - r.top, size.w, size.h)
  if (!ll || !L.MapModel.inView(ll.latitude, ll.longitude)) return
  if (!L.LocationModel.inDenmark(L.MapData.denmarkRings, ll.latitude, ll.longitude, 3)) return
  setPlace({ name: L.LocationModel.nameForPoint(ll.latitude, ll.longitude, L.Towns.towns),
    latitude: Math.round(ll.latitude * 1e4) / 1e4, longitude: Math.round(ll.longitude * 1e4) / 1e4 })
}

// "My location": the device's own position, after the browser asks. The chip
// says it is working, and a failure says why, next to the chips.
function useMyLocation(chip) {
  const note = $("locate-note")
  const done = (message) => {
    chip.removeAttribute("aria-busy")
    chip.textContent = "📍 My location"
    note.hidden = !message
    note.textContent = message || ""
  }
  if (!navigator.geolocation || !window.isSecureContext) {
    done("This browser cannot share your location here. Pick a place instead.")
    return
  }
  chip.setAttribute("aria-busy", "true")
  chip.textContent = "📍 Locating…"
  note.hidden = true
  navigator.geolocation.getCurrentPosition((pos) => {
    const lat = pos.coords.latitude, lon = pos.coords.longitude
    if (!L.LocationModel.inDenmark(L.MapData.denmarkRings, lat, lon, 3)) {
      done("You seem to be outside Denmark. Pick a place instead.")
      return
    }
    done("")
    setPlace({ name: L.LocationModel.nameForPoint(lat, lon, L.Towns.towns), latitude: Math.round(lat * 1e4) / 1e4,
      longitude: Math.round(lon * 1e4) / 1e4 })
  }, (err) => {
    done(err && err.code === 1
      ? "Location access is blocked for this site. Allow it in your browser's site settings (the icon left of the address), or pick a place."
      : err && err.code === 3
        ? "Finding your location took too long. Try again, or pick a place."
        : "Your device could not tell where it is (is location turned on?). Pick a place instead.")
  }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 })
}

function setUpPlaces() {
  const chips = $("chips")
  const mine = document.createElement("button")
  mine.className = "chip"; mine.textContent = "📍 My location"
  mine.onclick = () => useMyLocation(mine)
  if (navigator.geolocation) chips.append(mine)
  for (const c of L.LocationModel.cities.slice(0, 4)) {
    const b = document.createElement("button")
    b.className = "chip"; b.textContent = c.name
    b.onclick = () => setPlace({ name: c.name, latitude: c.latitude, longitude: c.longitude })
    chips.append(b)
  }
  const search = $("search"), results = $("results")
  const render = () => {
    const matches = L.LocationModel.searchTowns(L.Towns.towns, search.value, 6)
    results.replaceChildren(...matches.map((m) => {
      const b = document.createElement("button")
      b.textContent = m.label
      b.onclick = () => setPlace(placeOf(m))
      return b
    }))
    return matches
  }
  search.addEventListener("input", render)
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { const m = render(); if (m.length) setPlace(placeOf(m[0])) }
    if (e.key === "Escape") { search.value = ""; render() }
  })
  $("change-place").onclick = () => showPlaces($("places").hidden)
  $("place-button").onclick = () => showPlaces($("places").hidden)
}

const PAUSE = '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="3" y="2" width="3.5" height="12" rx="1" fill="currentColor"/><rect x="9.5" y="2" width="3.5" height="12" rx="1" fill="currentColor"/></svg>'
const PLAY = '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 2.5v11a.8.8 0 0 0 1.2.7l9-5.5a.8.8 0 0 0 0-1.4l-9-5.5A.8.8 0 0 0 4 2.5z" fill="currentColor"/></svg>'

// ---- Start ----

async function main() {
  const names = ["MapModel", "MapData", "ColorScale", "FixedEchoes", "Interpolation", "Timeline", "PointSeries",
    "ChanceModel", "LocationModel", "RadarModel", "Towns", "GraphModel"]
  const libs = await Promise.all(names.map(loadLib))
  names.forEach((n, i) => { L[n] = libs[i] })

  const stops = L.ColorScale.stops
  const top = stops[stops.length - 1].mm
  $("legend-bar").style.background = "linear-gradient(90deg," + stops.slice(1).map((s) =>
    `rgba(${s.r},${s.g},${s.b},${Math.max(0.35, s.a / 255)}) ${(Math.log(s.mm / 0.1) / Math.log(top / 0.1) * 100).toFixed(1)}%`).join(",") + ")"

  $("play").innerHTML = PAUSE
  setUpPlaces()
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null")
    if (saved && typeof saved.latitude === "number") state.place = saved
  } catch (e) { /* none */ }
  // a shared link: ?place=Odense (the first town search match) wins for this visit
  const asked = new URLSearchParams(location.search).get("place")
  if (asked) {
    const m = L.LocationModel.searchTowns(L.Towns.towns, asked, 1)[0]
    if (m) state.place = placeOf(m)
  }
  showPlaces(!state.place)

  resize()
  window.addEventListener("resize", () => { resize(); sizeGraph(); draw() })
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { theme = colours(); layers.clear(); draw() })
  canvas.addEventListener("click", pickOnMap)
  $("play").onclick = () => {
    state.playing = !state.playing
    state.holdUntil = 0
    $("play").innerHTML = state.playing ? PAUSE : PLAY
    $("play").setAttribute("aria-label", state.playing ? "Pause" : "Play")
  }
  const track = $("track")
  track.addEventListener("pointerdown", (e) => { track.setPointerCapture(e.pointerId); seekTo(e.clientX) })
  track.addEventListener("pointermove", (e) => { if (e.buttons) seekTo(e.clientX) })

  updateForecast()
  draw()
  requestAnimationFrame(tick)
  await refresh()
  setInterval(refresh, REFRESH_MS)
  setInterval(updateForecast, 60000) // the clock moves on
}

main().catch((e) => { $("map-status").textContent = "Something went wrong: " + (e.message || e); console.error(e) })
