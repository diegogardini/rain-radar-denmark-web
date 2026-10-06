// The rain at one place over a real time axis, as the widget's PointGraph.qml
// draws it (keep the two in step): the last hour observed (solid), the nowcast
// (finely dashed), a strip under the axis shaded by the chance of rain from
// "now" on, a "now" marker, and a cursor that follows the map's playback with
// its reading. Uses the widget's GraphModel.js for the scale and the curve.
"use strict"

const PAST_MS = 60 * 60000, AHEAD_MS = 90 * 60000
const LEVELS = [
  { value: 0, label: "" }, { value: 0.1, label: "0.1" }, { value: 1, label: "1" },
  { value: 2.5, label: "2.5" }, { value: 10, label: "10" }, { value: 50, label: "50" },
]

// Plot rectangle and time window for a canvas of `w` x `h` CSS pixels.
function graphLayout(w, h, series) {
  const compact = w < 260, stripH = 9
  const plotLeft = 10, plotRight = w - 30, plotTop = compact ? 32 : 28, plotBottom = h - (24 + stripH + 4)
  const windowStart = series && series.nowMs !== null ? series.nowMs - PAST_MS : 0
  const windowEnd = series && series.nowMs !== null ? series.nowMs + AHEAD_MS : 1
  const xFor = (ms) => plotLeft + (ms - windowStart) / (windowEnd - windowStart) * (plotRight - plotLeft)
  const msFor = (x) => windowStart + (x - plotLeft) / (plotRight - plotLeft) * (windowEnd - windowStart)
  return { compact, stripH, plotLeft, plotRight, plotTop, plotBottom, windowStart, windowEnd, xFor, msFor }
}

// opts: {series, chance, cursorMs, GraphModel, fg, accent, chanceColor, font, rgba(colour, alpha), clock(ms)}
function drawPointGraph(ctx, w, h, opts) {
  const G = opts.GraphModel, a = opts.rgba, fg = opts.fg, accent = opts.accent, series = opts.series
  const L = graphLayout(w, h, series)
  const { plotLeft, plotRight, plotTop, plotBottom, stripH, xFor, compact } = L
  ctx.clearRect(0, 0, w, h)
  if (plotRight <= plotLeft || plotBottom <= plotTop) return
  ctx.font = opts.font
  ctx.textBaseline = "middle"
  ctx.textAlign = "left"

  // a scale label too close to the one below it (a small graph, on a phone) or
  // to the unit above is left out; its line stays
  const gap = parseFloat(opts.font) + 1
  let lastLabelY = Infinity
  for (const lv of LEVELS) {
    const y = G.yFor(lv.value, plotTop, plotBottom)
    ctx.strokeStyle = a(fg, lv.value === 0 ? 0.35 : 0.12)
    ctx.lineWidth = 1
    ctx.setLineDash(lv.value === 0 ? [] : [3, 5])
    ctx.beginPath(); ctx.moveTo(plotLeft, y); ctx.lineTo(plotRight, y); ctx.stroke()
    if (lv.label && lastLabelY - y >= gap && y - (plotTop - 8) >= gap) {
      ctx.fillStyle = a(fg, 0.55)
      ctx.fillText(lv.label, plotRight + 6, y)
      lastLabelY = y
    }
  }
  ctx.setLineDash([])
  ctx.fillStyle = a(fg, 0.55)
  ctx.fillText("mm/h", plotRight + 2, plotTop - 8)

  const pts = series && series.points
  if (!pts || !pts.length || series.nowMs === null) return

  // time axis: the hour marks, and "now" (an hour mark that would collide with it is left out)
  ctx.textBaseline = "top"; ctx.textAlign = "center"; ctx.fillStyle = a(fg, 0.55)
  const nowX = xFor(series.nowMs), labelY = plotBottom + stripH + 12
  if (compact) {
    for (let m = 30; m * 60000 <= AHEAD_MS; m += 30) ctx.fillText(m + "m", xFor(series.nowMs + m * 60000), labelY)
  } else {
    for (let t = Math.ceil(L.windowStart / 3600000) * 3600000; t <= L.windowEnd; t += 3600000) {
      const hx = xFor(t)
      const room = (ctx.measureText(opts.clock(t)).width + ctx.measureText("now").width) / 2 + 4
      if (Math.abs(hx - nowX) < room || hx < plotLeft + 14 || hx > plotRight - 14) continue
      ctx.fillText(opts.clock(t), hx, labelY)
    }
  }

  const xy = pts.map((p) => ({ x: xFor(p.ms), y: G.yFor(p.mm, plotTop, plotBottom) }))
  const tangents = G.tangents(xy)
  let lastObserved = -1, firstNowcast = -1, lastNowcast = -1
  pts.forEach((p, i) => {
    if (p.kind === "observed") lastObserved = i
    else if (p.kind === "nowcast") { lastNowcast = i; if (firstNowcast < 0) firstNowcast = i }
  })
  const trace = (from, to) => {
    ctx.moveTo(xy[from].x, xy[from].y)
    for (let i = from; i < to; i++) {
      const dx = xy[i + 1].x - xy[i].x
      ctx.bezierCurveTo(xy[i].x + dx / 3, xy[i].y + tangents[i] * dx / 3,
        xy[i + 1].x - dx / 3, xy[i + 1].y - tangents[i + 1] * dx / 3, xy[i + 1].x, xy[i + 1].y)
    }
  }
  const fillUnder = (from, to, top, bottom) => {
    const grad = ctx.createLinearGradient(0, plotTop, 0, plotBottom)
    grad.addColorStop(0, top); grad.addColorStop(1, bottom)
    ctx.fillStyle = grad
    ctx.beginPath(); trace(from, to)
    ctx.lineTo(xy[to].x, plotBottom); ctx.lineTo(xy[from].x, plotBottom); ctx.closePath(); ctx.fill()
  }
  const stroke = (from, to, dash, colour) => {
    ctx.setLineDash(dash); ctx.strokeStyle = colour; ctx.lineWidth = 2
    ctx.beginPath(); trace(from, to); ctx.stroke(); ctx.setLineDash([])
  }
  if (lastObserved >= 1) fillUnder(0, lastObserved, a(accent, 0.42), a(accent, 0.10))
  if (firstNowcast >= 0) fillUnder(Math.max(0, firstNowcast - 1), lastNowcast, a(accent, 0.20), a(accent, 0.05))
  ctx.lineJoin = "round"; ctx.lineCap = "round"
  if (lastObserved >= 1) stroke(0, lastObserved, [], accent)
  if (firstNowcast >= 0) stroke(Math.max(0, firstNowcast - 1), lastNowcast, [1.5, 2.5], a(accent, 0.85))

  // the chance of rain: a strip under the axis from "now" on
  const chance = opts.chance || []
  if (chance.length) {
    const sy = plotBottom + 3
    ctx.fillStyle = a(fg, 0.07)
    ctx.fillRect(nowX, sy, plotRight - nowX, stripH)
    for (const c of G.chanceFromNow(chance, series.nowMs)) {
      const x0 = Math.max(nowX, xFor(c.ms - 5 * 60000)), x1 = Math.min(plotRight, xFor(c.ms + 5 * 60000))
      if (x1 <= x0 || c.chance <= 0) continue
      ctx.fillStyle = a(opts.chanceColor, G.stripAlpha(c.chance))
      ctx.fillRect(x0, sy, x1 - x0, stripH)
    }
    ctx.fillStyle = a(opts.chanceColor, 0.9); ctx.textAlign = "right"; ctx.textBaseline = "middle"
    const label = ctx.measureText("chance of rain").width <= nowX - plotLeft - 5 ? "chance of rain" : "chance"
    ctx.fillText(label, nowX - 5, sy + stripH / 2)
  }

  ctx.strokeStyle = a(fg, 0.55); ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(nowX, plotTop); ctx.lineTo(nowX, plotBottom); ctx.stroke()
  ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = a(fg, 0.8)
  ctx.fillText("now", nowX, labelY)

  // the playback cursor and its reading: the time, the rain (blue) and, ahead of now, the chance (amber)
  const cursorMs = opts.cursorMs
  if (cursorMs >= L.windowStart && cursorMs <= L.windowEnd) {
    let near = 0, gap = Infinity
    pts.forEach((p, i) => { const g = Math.abs(p.ms - cursorMs); if (g < gap) { gap = g; near = i } })
    const cx = xFor(cursorMs)
    ctx.strokeStyle = a(accent, 0.9); ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(cx, plotTop); ctx.lineTo(cx, plotBottom); ctx.stroke()
    ctx.fillStyle = accent
    ctx.beginPath(); ctx.arc(cx, xy[near].y, 3.5, 0, 2 * Math.PI); ctx.fill()
    const p = pts[near]
    const parts = [
      { text: opts.clock(cursorMs) + (compact ? " " : "  "), colour: a(fg, 0.9) },
      { text: p.mm.toFixed(p.mm < 10 ? 1 : 0) + " mm/h", colour: accent },
    ]
    if (p.kind === "nowcast" && p.ms >= series.nowMs && chance.length) {
      let best = null, bestGap = Infinity
      for (const c of chance) { const g = Math.abs(c.ms - p.ms); if (g < bestGap) { bestGap = g; best = c } }
      if (best && bestGap < 6 * 60000) {
        parts.push({ text: compact ? " · " : "  ·  ", colour: a(fg, 0.5) })
        parts.push({ text: Math.round(best.chance * 100) + (compact ? "%" : "% chance"), colour: opts.chanceColor })
      }
    }
    const width = parts.reduce((s, q) => s + ctx.measureText(q.text).width, 0)
    let lx = Math.max(plotLeft, Math.min(plotRight - width, cx - width / 2))
    ctx.textBaseline = "middle"; ctx.textAlign = "left"
    for (const q of parts) { ctx.fillStyle = q.colour; ctx.fillText(q.text, lx, plotTop - 22); lx += ctx.measureText(q.text).width }
  }
}
