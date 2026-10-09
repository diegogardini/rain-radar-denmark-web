// Rain Radar Denmark on the web: the Omarchy widget's own models (lib/*.js,
// copied from the widget repository at build time), DMI's scans converted in
// the browser (radar.js), and the rain drawn as the widget draws it
// (RadarMap.qml in the widget repository), on a phone-sized map of Denmark
// with Bornholm in an inset, and a bar graph of the place that is also the
// map's timeline (graph.js).
"use strict"

const OBSERVED_SCANS = 7    // one hour of full-range scans, as the widget
const MOTION_SCANS = 4      // the nowcast's motion: the last 30 minutes
const FRAME_MS = 774        // one 10-minute step on screen at 1×: half the widget's pace (387 ms, here 2×)
const SPEEDS = [0.5, 1, 2]  // the speed button cycles through these
const REFRESH_MS = 5 * 60000
const STORE_KEY = "rain-radar-denmark.place"
// ".speed" held a choice on the old scale (1× = 387 ms); a new key starts everyone at the new 1×
const SPEED_KEY = "rain-radar-denmark.playback-speed"
// What the map shows: Denmark from the North Sea coast to Zealand, Skagen to
// the German border (the data area, MapModel.bounds, is larger: rain still
// comes in from beyond it). Bornholm has its own inset, 104 x 104 CSS pixels,
// with the sea around the island (about 1.2 degrees of longitude by 0.65 of latitude).
const VIEW = { west: 7.5, east: 13.6, south: 54.3, north: 58.155 }
const BORNHOLM = { longitude: 14.92, latitude: 55.14, scale: 160 } // px per degree of latitude

const $ = (id) => document.getElementById(id)
// ?at=2026-07-30T18:43Z replays a past moment (DMI keeps 180 days of scans)
const AT = Date.parse(new URLSearchParams(location.search).get("at") || "")
const now = () => isFinite(AT) ? AT : Date.now()
const L = {}                // the widget's models, by file name
const state = {
  items: [], scans: {}, frames: [], nowcast: [], motion: null, hasEdgeGuess: false,
  pos: 0, playing: true, speed: 1, dragging: false, place: null, series: null, error: "",
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
  if (state.pos >= state.frames.length) state.pos = 0
  for (const v of views) clearLayers(v)
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
  $("legend-edge").hidden = !state.hasEdgeGuess
  updateForecast()
  draw()
}

// ---- The maps: Denmark, and Bornholm's inset ----

let theme = null
function colours() {
  const s = getComputedStyle(document.documentElement)
  const v = (n) => s.getPropertyValue(n).trim()
  return {
    ink: v("--ink"), muted: v("--muted"), accent: v("--accent"), surface: v("--surface"),
    land: v("--land"), neighbour: v("--neighbour"), coast: v("--coast"), neighbourCoast: v("--neighbour-coast"),
    past: v("--past"), dry: v("--dry"), band: v("--band"), grid: v("--grid"), axis: v("--axis"),
  }
}
function rgba(colour, a) {
  const c = document.createElement("canvas").getContext("2d")
  c.fillStyle = colour
  const h = c.fillStyle
  if (h[0] === "#") {
    const n = parseInt(h.slice(1), 16)
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`
  }
  return h.replace(/rgba?\(([^)]+)\)/, (m, inner) => `rgba(${inner.split(",").slice(0, 3).join(",")},${a})`)
}

// A local equirectangular projection (MapModel's longitude scale) centred on
// a point, `scale` CSS pixels per degree of latitude, in a w x h box.
function projection(lon0, lat0, scale, w, h) {
  const k = L.MapModel.longitudeScale * scale
  return {
    w, h, scale,
    x: (lon) => w / 2 + (lon - lon0) * k,
    y: (lat) => h / 2 - (lat - lat0) * scale,
    lon: (x) => lon0 + (x - w / 2) / k,
    lat: (y) => lat0 - (y - h / 2) / scale,
  }
}

function makeView(canvasId, pinId, project) {
  const canvas = $(canvasId)
  return { canvas, ctx: canvas.getContext("2d"), pin: $(pinId), project, proj: null, dpr: 1, land: null, coast: null, dashed: null, layers: new Map(), margin: null }
}
function clearLayers(v) { v.layers.clear(); v.margin = null }
// The main map: all of VIEW in the box (a phone's box has VIEW's own shape;
// a computer's wider one shows more around it), but never past the radar's
// area (MapModel.bounds), where there is no rain to show.
function fitView(w, h) {
  const k = L.MapModel.longitudeScale, B = L.MapModel.bounds
  const clamp = (v, lo, hi) => lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v))
  const scale = Math.max(
    Math.min(h / (VIEW.north - VIEW.south), w / ((VIEW.east - VIEW.west) * k)),
    h / (B.north - B.south), w / ((B.east - B.west) * k))
  const halfLon = w / 2 / (k * scale), halfLat = h / 2 / scale
  const lon0 = clamp((VIEW.west + VIEW.east) / 2, B.west + halfLon, B.east - halfLon)
  const lat0 = clamp((VIEW.south + VIEW.north) / 2, B.south + halfLat, B.north - halfLat)
  return projection(lon0, lat0, scale, w, h)
}
const views = [
  makeView("map", "pin", fitView),
  makeView("inset", "inset-pin", (w, h) => projection(BORNHOLM.longitude, BORNHOLM.latitude, BORNHOLM.scale, w, h)),
]

function offscreen(v) {
  const c = document.createElement("canvas")
  c.width = v.canvas.width; c.height = v.canvas.height
  const g = c.getContext("2d")
  g.scale(v.dpr, v.dpr)
  return { canvas: c, ctx: g }
}

function traceRings(c, p, rings) {
  c.beginPath()
  for (const ring of rings) {
    ring.forEach((pt, k) => { const x = p.x(pt[0]), y = p.y(pt[1]); k ? c.lineTo(x, y) : c.moveTo(x, y) })
    c.closePath()
  }
}
const neighbourRings = () => L.MapData.neighbours.flatMap((n) => n.rings)

// Sizes a view to its box and paints what stays put: the land under the
// rain, and the coastlines over it (solid for the radar, finely dashed for
// the nowcast, as the widget's Denmark outline).
function setUpView(v) {
  const w = v.canvas.clientWidth, h = v.canvas.clientHeight
  if (!w || !h) return
  v.dpr = Math.min(window.devicePixelRatio || 1, 3)
  v.canvas.width = Math.round(w * v.dpr)
  v.canvas.height = Math.round(h * v.dpr)
  v.proj = v.project(w, h)
  clearLayers(v)
  const land = offscreen(v)
  traceRings(land.ctx, v.proj, neighbourRings()); land.ctx.fillStyle = theme.neighbour; land.ctx.fill()
  traceRings(land.ctx, v.proj, L.MapData.denmarkRings); land.ctx.fillStyle = theme.land; land.ctx.fill()
  v.land = land.canvas
  const coast = (dash) => {
    const o = offscreen(v), c = o.ctx
    c.lineJoin = "round"
    traceRings(c, v.proj, neighbourRings()); c.strokeStyle = theme.neighbourCoast; c.lineWidth = 0.7; c.stroke()
    traceRings(c, v.proj, L.MapData.denmarkRings); c.strokeStyle = theme.coast; c.lineWidth = 0.9
    c.setLineDash(dash); c.stroke()
    return o.canvas
  }
  v.coast = coast([])
  v.dashed = coast([1.5, 2.5])
}

function gridGeometry(p, grid) {
  const b = grid.bounds
  const cellW = (b.east - b.west) / grid.cols * L.MapModel.longitudeScale * p.scale
  const cellH = (b.north - b.south) / grid.rows * p.scale
  const drawW = cellW * 1.15, drawH = cellH * 1.15
  return { x0: p.x(b.west), y0: p.y(b.north), cellW, cellH, drawW, drawH, padX: (drawW - cellW) / 2, padY: (drawH - cellH) / 2 }
}

function hatch(c, opacity) {
  const p = document.createElement("canvas")
  p.width = p.height = 6
  const g = p.getContext("2d")
  g.strokeStyle = rgba(theme.ink, opacity)
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

// An observed scan: DMI's picture, except at the fixed-echo cells, which are
// painted from the filled grid (as the widget). `m`: the margin painted
// around the view.
function drawObserved(c, p, scan, m) {
  const b = L.MapModel.bounds, grid = scan.grid, geo = gridGeometry(p, grid), cells = L.FixedEchoes.CELLS
  c.save()
  c.beginPath()
  c.rect(-m, -m, p.w + 2 * m, p.h + 2 * m)
  for (const [r, col] of cells) {
    const x = geo.x0 + col * geo.cellW, y = geo.y0 + r * geo.cellH
    c.moveTo(x, y); c.lineTo(x, y + geo.cellH); c.lineTo(x + geo.cellW, y + geo.cellH); c.lineTo(x + geo.cellW, y); c.closePath()
  }
  c.clip("nonzero")
  c.drawImage(scan.bitmap, p.x(b.west), p.y(b.north), p.x(b.east) - p.x(b.west), p.y(b.south) - p.y(b.north))
  c.restore()
  for (const [r, col] of cells) drawCell(c, grid, geo, r, col, null)
}

// A nowcast step: its grid cell by cell, only the cells that reach the view
// and its margin `m`.
function drawForecast(c, p, grid, m) {
  const geo = gridGeometry(p, grid), b = grid.bounds
  const patterns = grid.fromEdge ? [0.35, 0.6, 0.9].map((o) => hatch(c, o)) : null
  const colOf = (lon) => Math.floor((lon - b.west) / (b.east - b.west) * grid.cols)
  const rowOf = (lat) => Math.floor((b.north - lat) / (b.north - b.south) * grid.rows)
  const c0 = Math.max(0, colOf(p.lon(-m)) - 2), c1 = Math.min(grid.cols - 1, colOf(p.lon(p.w + m)) + 2)
  const r0 = Math.max(0, rowOf(p.lat(-m)) - 2), r1 = Math.min(grid.rows - 1, rowOf(p.lat(p.h + m)) + 2)
  for (let r = r0; r <= r1; r++) for (let col = c0; col <= c1; col++) drawCell(c, grid, geo, r, col, patterns)
}

// How far a frame's rain moves in one step on this view, at most, in CSS
// pixels: the rain layers are painted that much past the view's edges, so a
// gliding frame never shows a bare strip where it moved away from.
function viewMargin(v) {
  if (v.margin === null) {
    let most = 0
    for (const f of state.frames) {
      if (!f.motion) continue
      const geo = gridGeometry(v.proj, f.grid || f.scan.grid)
      most = Math.max(most, Math.abs(f.motion.dx * geo.cellW), Math.abs(f.motion.dy * geo.cellH))
    }
    v.margin = Math.ceil(most) + 4
  }
  return v.margin
}

// Each frame's rain is painted once per view, then only moved (as the widget).
function rainLayer(v, i) {
  if (v.layers.has(i)) return v.layers.get(i)
  const f = state.frames[i], m = viewMargin(v), o = document.createElement("canvas")
  o.width = Math.round((v.proj.w + 2 * m) * v.dpr)
  o.height = Math.round((v.proj.h + 2 * m) * v.dpr)
  const c = o.getContext("2d")
  c.scale(v.dpr, v.dpr)
  c.translate(m, m)
  c.globalAlpha = f.kind === "forecast" ? 0.85 : 1
  if (f.kind === "observed") drawObserved(c, v.proj, f.scan, m)
  else drawForecast(c, v.proj, f.grid, m)
  v.layers.set(i, o)
  return o
}

// The frame on screen, and how far it has glided along its motion (0 to <1):
// the last frame, and a frame without a measured motion, step whole.
function current() {
  const n = state.frames.length
  if (!n) return { f: null, i: 0, frac: 0 }
  const i = Math.max(0, Math.min(n - 1, Math.floor(state.pos)))
  const f = state.frames[i]
  return { f, i, frac: i < n - 1 && f.motion ? state.pos - i : 0 }
}

function drawView(v, cur) {
  if (!v.proj) return
  const c = v.ctx, f = cur.f
  c.setTransform(1, 0, 0, 1, 0, 0)
  c.clearRect(0, 0, v.canvas.width, v.canvas.height)
  c.drawImage(v.land, 0, 0)
  if (f) {
    const g = f.grid || f.scan.grid, geo = gridGeometry(v.proj, g)
    const dx = cur.frac ? cur.frac * f.motion.dx * geo.cellW : 0, dy = cur.frac ? cur.frac * f.motion.dy * geo.cellH : 0
    const layer = rainLayer(v, cur.i), m = viewMargin(v)
    c.drawImage(layer, (dx - m) * v.dpr, (dy - m) * v.dpr)
  }
  c.drawImage(f && f.kind === "forecast" ? v.dashed : v.coast, 0, 0)
  const p = state.place, pin = v.pin
  const inside = p && v.proj && (() => { const x = v.proj.x(p.longitude), y = v.proj.y(p.latitude); return x >= 0 && x <= v.proj.w && y >= 0 && y <= v.proj.h })()
  pin.hidden = !inside
  if (inside) { pin.style.left = v.proj.x(p.longitude) + "px"; pin.style.top = v.proj.y(p.latitude) + "px" }
}

function draw() {
  if (!theme) return
  const cur = current()
  for (const v of views) drawView(v, cur)
  drawChip(cur)
  drawGraph(cur)
}

// ---- The time chip and the graph (graph.js) ----

// The time shown for a moment of the animation: to the nearest 10 minutes,
// as the widget (Timeline.shownMs); the rain still glides on exactly.
const shownMs = (ms) => Math.round(ms / 600000) * 600000

function clock(ms) {
  const d = new Date(ms)
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0")
}

// the moment the map shows, gliding between steps as the map does
function cursorMs(cur) {
  if (!cur.f) return -1
  const t = Date.parse(cur.f.time), next = state.frames[cur.i + 1]
  return cur.frac > 0 && next ? t + cur.frac * (Date.parse(next.time) - t) : t
}

function drawChip(cur) {
  $("chip").hidden = !cur.f
  if (!cur.f) return
  const projected = cur.f.kind === "forecast"
  $("chip-kind").textContent = projected ? "PROJECTED" : "PAST"
  $("chip-kind").classList.toggle("projected", projected)
  $("chip-time").textContent = clock(shownMs(cursorMs(cur)))
}

const graphCanvas = $("graph"), graphCtx = graphCanvas.getContext("2d")
let graphSize = { w: 0, h: 0, dpr: 1 }

function sizeGraph() {
  const w = graphCanvas.clientWidth, h = graphCanvas.clientHeight
  const dpr = Math.min(window.devicePixelRatio || 1, 3)
  if (!w || !h || (w === graphSize.w && h === graphSize.h && dpr === graphSize.dpr)) return
  graphCanvas.width = Math.round(w * dpr)
  graphCanvas.height = Math.round(h * dpr)
  graphSize = { w, h, dpr }
}

function graphBars() {
  const pts = state.series ? state.series.points : []
  return state.frames.map((f) => {
    const ms = Date.parse(f.time), p = pts.find((q) => q.ms === ms)
    return { ms, kind: f.kind, mm: p ? p.mm : null }
  })
}

function drawGraph(cur) {
  sizeGraph()
  if (!graphSize.w) return
  const n = state.frames.length, wrap = $("graph-wrap")
  wrap.setAttribute("aria-valuemax", String(Math.max(0, n - 1)))
  wrap.setAttribute("aria-valuenow", String(cur.i))
  if (cur.f) wrap.setAttribute("aria-valuetext", (cur.f.kind === "forecast" ? "Projected " : "Past ") + clock(shownMs(cursorMs(cur))))
  graphCtx.setTransform(graphSize.dpr, 0, 0, graphSize.dpr, 0, 0)
  drawBarGraph(graphCtx, graphSize.w, graphSize.h, {
    bars: graphBars(), pos: Math.min(state.pos, Math.max(0, n - 1)),
    nowMs: state.series ? state.series.nowMs : now(),
    heightFraction: L.GraphModel.heightFraction, clock,
    fontFamily: getComputedStyle(document.body).fontFamily, colours: theme,
  })
}

// ---- Playback, and the graph as the timeline ----

let last = 0
function tick(t) {
  const dt = last ? Math.min(t - last, 100) : 0
  last = t
  const n = state.frames.length
  if (n > 1 && state.playing && !state.dragging) {
    state.pos += dt * state.speed / FRAME_MS
    if (state.pos >= n) state.pos -= n // the last frame holds one step, then the loop starts over
    draw()
  }
  requestAnimationFrame(tick)
}

const PAUSE = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor"/></svg>'
const PLAY = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/></svg>'

function setPlaying(on) {
  state.playing = on
  $("play").innerHTML = on ? PAUSE : PLAY
  $("play").setAttribute("aria-label", on ? "Pause" : "Play")
}

const speedLabel = (s) => (s === 0.5 ? "½" : String(s)) + "×"
function setSpeed(s, save = true) {
  state.speed = s
  $("speed").textContent = speedLabel(s)
  $("speed").setAttribute("aria-label", "Playback speed " + speedLabel(s) + ". Change it")
  if (save) {
    try { localStorage.setItem(SPEED_KEY, String(s)) } catch (e) { /* private mode */ }
  }
}

function setUpTimeline() {
  const wrap = $("graph-wrap")
  const posAt = (e) => {
    const r = wrap.getBoundingClientRect()
    return graphPosAt(e.clientX - r.left, r.width, state.frames.length)
  }
  wrap.addEventListener("pointerdown", (e) => {
    if (!state.frames.length) return
    setPlaying(false)
    state.dragging = true
    wrap.setPointerCapture(e.pointerId)
    state.pos = posAt(e)
    draw()
  })
  wrap.addEventListener("pointermove", (e) => {
    if (!state.dragging) return
    state.pos = posAt(e)
    draw()
  })
  // let go: settle on the nearest real frame
  const end = () => {
    if (!state.dragging) return
    state.dragging = false
    state.pos = Math.round(state.pos)
    draw()
  }
  wrap.addEventListener("pointerup", end)
  wrap.addEventListener("pointercancel", end)
  wrap.addEventListener("keydown", (e) => {
    const n = state.frames.length
    const to = { ArrowLeft: Math.round(state.pos) - 1, ArrowRight: Math.round(state.pos) + 1, Home: 0, End: n - 1 }[e.key]
    if (to === undefined || !n) return
    e.preventDefault()
    setPlaying(false)
    state.pos = Math.max(0, Math.min(n - 1, to))
    draw()
  })
  $("play").onclick = () => setPlaying(!state.playing)
  $("speed").onclick = () => setSpeed(SPEEDS[(SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length])
  let saved = 1
  try { saved = Number(localStorage.getItem(SPEED_KEY)) } catch (e) { /* none */ }
  setSpeed(SPEEDS.includes(saved) ? saved : 1, false)
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
  $("search").value = place.name
  closeResults()
  updateForecast()
  draw()
}

function updateForecast() {
  const p = state.place
  state.series = null
  $("stale").hidden = true
  $("chances").hidden = true
  if (!p) {
    $("where").textContent = ""
    $("headline").textContent = "Pick a place"
    $("sentence").textContent = "Search above, tap the map, or use your location to see the rain there and what to expect over the next 90 minutes."
    return
  }
  $("where").textContent = p.name + " · " + clock(now())
  if (!state.nowcast.length) {
    $("headline").textContent = state.error ? "No radar right now" : "Loading…"
    $("sentence").textContent = state.error || "Reading DMI's latest radar scans."
    return
  }
  const PS = L.PointSeries, CM = L.ChanceModel
  const observed = state.items.filter((it) => state.scans[it.id]).map((it) => ({ time: it.datetime, grid: state.scans[it.id].grid }))
  const series = PS.build(observed, state.nowcast, p.latitude, p.longitude, now())
  const chance = CM.compute(state.nowcast, p.latitude, p.longitude, series.scanMs, undefined, series.nowMs)
  const rainChance = chance ? CM.rainWithin(chance, PS.coveredMinutes(series)) : null
  const dryBy = chance ? CM.dryForGoodBy(chance, 1 - PS.NO_RAIN_CHANCE) : undefined
  state.series = series

  // "Light rain now · may ease off": the headline, then the rest as a sentence
  const [head, ...rest] = PS.summary(series, rainChance, dryBy).split(" · ")
  const more = rest.join(", ")
  $("headline").textContent = head
  $("sentence").textContent = more ? more.charAt(0).toUpperCase() + more.slice(1) + "." : ""

  const parts = CM.parts(chance, PS.currentMm(series))
  $("chances").hidden = !parts
  if (parts) {
    const raining = parts.title !== "Rain within"
    $("chances-title").textContent = raining ? "Chance it's dry for good" : "Chance of rain here"
    $("tiles").replaceChildren(...parts.items.map((it) => {
      const tile = document.createElement("div")
      tile.className = "tile"
      const b = document.createElement("b"), span = document.createElement("span")
      b.textContent = it.percent
      span.textContent = (raining ? "by " : "within ") + it.label
      tile.append(b, span)
      return tile
    }))
  }
  const age = series.scanMs === null ? 0 : Math.round((now() - series.scanMs) / 60000)
  if (age > 45) {
    $("stale").hidden = false
    $("stale").textContent = "Radar from " + clock(series.scanMs) + " · " + PS.formatLead(age) + " ago · DMI may be delayed"
  }
}

// A tap on the map (or the inset) picks the spot, if it is in Denmark.
function pickOn(v, evt) {
  if (!v.proj) return
  const r = v.canvas.getBoundingClientRect()
  const lat = v.proj.lat(evt.clientY - r.top), lon = v.proj.lon(evt.clientX - r.left)
  if (!L.LocationModel.inDenmark(L.MapData.denmarkRings, lat, lon, 3)) return
  setPlace({ name: L.LocationModel.nameForPoint(lat, lon, L.Towns.towns),
    latitude: Math.round(lat * 1e4) / 1e4, longitude: Math.round(lon * 1e4) / 1e4 })
}

// ---- Search and "my location" ----

function showResults(nodes) {
  $("results").replaceChildren(...nodes)
  $("results").hidden = !nodes.length
}
function closeResults() { $("results").hidden = true }
function note(text) {
  const d = document.createElement("div")
  d.className = "note"; d.setAttribute("role", "status"); d.textContent = text
  return d
}
function choice(label, onPick) {
  const b = document.createElement("button")
  b.textContent = label
  b.onclick = onPick
  return b
}

// The towns matching what is typed; with nothing typed (or the place's own
// name), the big cities.
function renderResults() {
  const q = $("search").value.trim()
  if (!q || (state.place && q === state.place.name)) {
    showResults(L.LocationModel.cities.slice(0, 5).map((c) =>
      choice(c.name, () => setPlace({ name: c.name, latitude: c.latitude, longitude: c.longitude }))))
    return []
  }
  const matches = L.LocationModel.searchTowns(L.Towns.towns, q, 6)
  showResults(matches.length ? matches.map((m) => choice(m.label, () => setPlace(placeOf(m)))) : [note("No Danish town or place by that name.")])
  return matches
}

// "My location": the device's own position, after the browser asks. A failure says why.
function useMyLocation() {
  const button = $("locate")
  const fail = (message) => { button.removeAttribute("aria-busy"); showResults([note(message)]) }
  if (!navigator.geolocation || !window.isSecureContext) {
    fail("This browser cannot share your location here. Search for a place instead.")
    return
  }
  button.setAttribute("aria-busy", "true")
  showResults([note("Finding your location…")])
  navigator.geolocation.getCurrentPosition((pos) => {
    button.removeAttribute("aria-busy")
    const lat = pos.coords.latitude, lon = pos.coords.longitude
    if (!L.LocationModel.inDenmark(L.MapData.denmarkRings, lat, lon, 3)) {
      fail("You seem to be outside Denmark. Search for a place instead.")
      return
    }
    setPlace({ name: L.LocationModel.nameForPoint(lat, lon, L.Towns.towns), latitude: Math.round(lat * 1e4) / 1e4,
      longitude: Math.round(lon * 1e4) / 1e4 })
  }, (err) => {
    fail(err && err.code === 1
      ? "Location access is blocked for this site. Allow it in your browser's site settings, or search for a place."
      : err && err.code === 3
        ? "Finding your location took too long. Try again, or search for a place."
        : "Your device could not tell where it is (is location turned on?). Search for a place instead.")
  }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 })
}

function setUpSearch() {
  const search = $("search")
  search.addEventListener("focus", () => { search.select(); renderResults() })
  search.addEventListener("input", renderResults)
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { const m = renderResults(); if (m.length) setPlace(placeOf(m[0])); search.blur() }
    if (e.key === "Escape") { search.value = state.place ? state.place.name : ""; closeResults(); search.blur() }
  })
  // a tap anywhere else closes the list
  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest(".search")) {
      closeResults()
      if (state.place && document.activeElement !== search) search.value = state.place.name
    }
  })
  $("locate").onclick = useMyLocation
}

// ---- Start ----

function resize() {
  // Bornholm's inset only when the map itself leaves Bornholm out (a phone)
  views[0].proj = null
  setUpView(views[0])
  const p = views[0].proj
  $("inset-wrap").hidden = !!p && p.x(15.16) <= p.w && p.x(14.68) >= 0 && p.y(55.3) >= 0 && p.y(54.98) <= p.h
  setUpView(views[1])
  graphSize = { w: 0, h: 0, dpr: 1 }
  draw()
}

async function main() {
  const names = ["MapModel", "MapData", "ColorScale", "FixedEchoes", "Interpolation", "Timeline", "PointSeries",
    "ChanceModel", "LocationModel", "RadarModel", "Towns", "GraphModel"]
  const libs = await Promise.all(names.map(loadLib))
  names.forEach((n, i) => { L[n] = libs[i] })

  const stops = L.ColorScale.stops
  const top = stops[stops.length - 1].mm
  $("legend-bar").style.background = "linear-gradient(90deg," + stops.slice(1).map((s) =>
    `rgba(${s.r},${s.g},${s.b},${Math.max(0.35, s.a / 255)}) ${(Math.log(s.mm / 0.1) / Math.log(top / 0.1) * 100).toFixed(1)}%`).join(",") + ")"

  setPlaying(true)
  setUpSearch()
  setUpTimeline()
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
  if (state.place) $("search").value = state.place.name

  theme = colours()
  resize()
  window.addEventListener("resize", resize)
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { theme = colours(); resize() })
  views[0].canvas.addEventListener("click", (e) => pickOn(views[0], e))
  views[1].canvas.addEventListener("click", (e) => pickOn(views[1], e))

  updateForecast()
  draw()
  requestAnimationFrame(tick)
  await refresh()
  setInterval(refresh, REFRESH_MS)
  setInterval(() => { updateForecast(); draw() }, 60000) // the clock moves on
}

main().catch((e) => { $("map-status").textContent = "Something went wrong: " + (e.message || e); console.error(e) })
