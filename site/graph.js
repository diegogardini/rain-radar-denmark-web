// The rain at the place, one bar per frame of the map: the last hour of radar
// on a shaded band, then the nowcast in the accent colour. The bars use the
// widget's scale (GraphModel.heightFraction: mm / (2 + mm), never off the
// top), and the graph is the map's timeline: a cursor and a handle show the
// frame on the map, and app.js lets the viewer drag along it.
"use strict"

// The top row (the labels) and the time row take 22 px each; the bars fill
// what is between, so a taller graph (a computer) has taller bars.
const GRAPH_TOP = 22, GRAPH_BOTTOM = 22
const SCALE_LEVELS = [1, 2.5, 10, 50] // mm/h, as the widget's graph

// The frame position (0 = the first bar's centre) under x, for a graph `w` wide with `n` bars.
function graphPosAt(x, w, n) {
  return Math.max(0, Math.min(n - 1, x / w * n - 0.5))
}

// opts: {bars: [{ms, mm (null = no reading), kind: "observed"|"forecast"}], pos, nowMs,
//        heightFraction(mm), clock(ms), font, fontFamily,
//        colours: {ink, muted, accent, past, dry, band, grid, axis, surface}}
function drawBarGraph(ctx, w, h, opts) {
  const bars = opts.bars, n = bars.length, c = opts.colours
  ctx.clearRect(0, 0, w, h)
  if (!n) return
  const GRAPH_BASE = h - GRAPH_BOTTOM, LABEL_Y = h - 5
  const slot = w / n, barW = Math.min(14, slot * 0.64), plotH = GRAPH_BASE - GRAPH_TOP
  const observed = bars.filter((b) => b.kind === "observed").length
  const centre = (i) => (i + 0.5) * slot
  ctx.textBaseline = "alphabetic"

  // the past hour's band
  if (observed) {
    ctx.fillStyle = c.band
    roundRect(ctx, 0, 0, observed * slot, GRAPH_BASE, 8)
    ctx.fill()
  }

  // the scale: the widget's levels, each a faint line with its value (the
  // top one with the unit); a level whose label would crowd the one below
  // it, or the top row, is left out, so a short graph (a phone) shows fewer
  const gap = 14
  const levels = []
  for (const mm of SCALE_LEVELS) {
    const y = GRAPH_BASE - opts.heightFraction(mm) * plotH
    const below = levels.length ? levels[levels.length - 1].y : GRAPH_BASE + gap
    if (below - y >= gap && y - 10 >= GRAPH_TOP) levels.push({ mm, y })
  }
  ctx.font = "10px " + opts.fontFamily
  ctx.textAlign = "right"
  levels.forEach((lv, k) => {
    ctx.strokeStyle = c.grid; ctx.lineWidth = 1; ctx.setLineDash([2, 4])
    line(ctx, 0, lv.y, w, lv.y)
    ctx.setLineDash([])
    ctx.fillStyle = c.muted
    ctx.fillText(lv.mm + (k === levels.length - 1 ? " mm/h" : ""), w, lv.y - 4)
  })
  ctx.strokeStyle = c.axis
  line(ctx, 0, GRAPH_BASE + 0.5, w, GRAPH_BASE + 0.5)

  // the bars: grey for the radar, the accent for the nowcast, a stub when dry
  bars.forEach((b, i) => {
    if (b.mm === null || b.mm === undefined) return
    const wet = b.mm > 0.02
    const bh = wet ? Math.max(3, opts.heightFraction(b.mm) * plotH) : 2
    ctx.fillStyle = !wet ? c.dry : b.kind === "observed" ? c.past : c.accent
    roundRect(ctx, centre(i) - barW / 2, GRAPH_BASE - bh, barW, bh, Math.min(3, barW / 2))
    ctx.fill()
  })

  // times on the half hour, under their own bars, in the bars' colours
  ctx.textAlign = "center"
  ctx.font = "500 11px " + opts.fontFamily
  let lastRight = -Infinity
  bars.forEach((b, i) => {
    if (new Date(b.ms).getMinutes() % 30) return
    const text = opts.clock(b.ms), tw = ctx.measureText(text).width
    const x = Math.max(tw / 2, Math.min(w - tw / 2, centre(i))) // kept inside the graph
    if (x - tw / 2 < lastRight + 6) return
    ctx.fillStyle = b.kind === "observed" ? c.muted : c.accent
    ctx.fillText(text, x, LABEL_Y)
    lastRight = x + tw / 2
  })

  // the top row: "Past hour", "Now" over its moment, "Next 90 min"
  const nowX = xForMs(bars, opts.nowMs, slot)
  ctx.font = "700 11px " + opts.fontFamily
  const nowW = ctx.measureText("Now").width
  const nowLabelX = nowX === null ? null : Math.max(nowW / 2, Math.min(w - nowW / 2, nowX))
  const clear = (x0, x1) => nowLabelX === null || x1 < nowLabelX - nowW / 2 - 6 || x0 > nowLabelX + nowW / 2 + 6
  ctx.font = "600 11px " + opts.fontFamily
  ctx.textAlign = "left"; ctx.fillStyle = c.muted
  if (observed && clear(8, 8 + ctx.measureText("Past hour").width)) ctx.fillText("Past hour", 8, 16)
  ctx.textAlign = "right"; ctx.fillStyle = c.accent
  if (observed < n && clear(w - ctx.measureText("Next 90 min").width, w)) ctx.fillText("Next 90 min", w, 16)
  if (nowX !== null) {
    ctx.strokeStyle = c.ink; ctx.setLineDash([2, 3])
    line(ctx, nowX, GRAPH_TOP, nowX, GRAPH_BASE)
    ctx.setLineDash([])
    ctx.font = "700 11px " + opts.fontFamily
    ctx.textAlign = "center"; ctx.fillStyle = c.ink
    ctx.fillText("Now", nowLabelX, 16)
  }

  // the frame on the map: a thin cursor and the handle (they glide with
  // playback; a filled column there read as a tall bar of rain)
  ctx.strokeStyle = c.ink; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.55
  line(ctx, centre(opts.pos), GRAPH_TOP, centre(opts.pos), GRAPH_BASE)
  ctx.globalAlpha = 1
  ctx.beginPath()
  ctx.arc(centre(opts.pos), GRAPH_BASE, 6, 0, 2 * Math.PI)
  ctx.fillStyle = c.ink; ctx.fill()
  ctx.lineWidth = 2; ctx.strokeStyle = c.surface; ctx.stroke()
}

// x of a moment between the bars' times (10 minutes apart), or null outside them.
function xForMs(bars, ms, slot) {
  if (typeof ms !== "number") return null
  for (let i = 0; i + 1 < bars.length; i++) {
    if (ms >= bars[i].ms && ms <= bars[i + 1].ms)
      return (i + 0.5 + (ms - bars[i].ms) / (bars[i + 1].ms - bars[i].ms)) * slot
  }
  return null
}

function line(ctx, x0, y0, x1, y1) {
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke()
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r)
  else ctx.rect(x, y, w, h)
}
