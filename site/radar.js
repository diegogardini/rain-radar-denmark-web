// Reads one DMI radar composite (ODIM HDF5) in the browser and turns it into
// what the page draws and computes with: the same as the widget's
// helpers/dmi-radar-convert.py in the widget repository (keep the two in step;
// tests/radar.test.cjs compares them on a real scan).
//
//   grid   {cols, rows, bounds, values}: 224 x 160 cells over the map, each the
//          mean rain rate over its radar pixels (dry ones as 0)
//   image  640 x 458 RGBA pixels over the map, evenly spaced in longitude and
//          latitude, each the mean of its wet radar pixels, coloured with
//          ColorScale (pass it in: the page loads the widget's ColorScale.js)
//
// DMI's files have one layout (HDF5 superblock 0, v1 object headers, one
// chunked and deflated byte grid); this reads that and stops with an error on
// anything else. Deflate is the browser's own (DecompressionStream).

var WEST = 5.0, SOUTH = 53.9, EAST = 16.5, NORTH = 58.5
var PNG_W = 640, PNG_H = 458
var GRID_COLS = 224, GRID_ROWS = 160
var RATE_FLOOR = 0.05
var LATTICE = 16
var NO_CELL = 0xFFFF
// Limits, far above DMI's files (as helpers/dmi-radar-convert.py)
var MAX_FILE_BYTES = 20000000, MAX_GRID_SIDE = 8192, MAX_GRID_BYTES = 32000000
var MAX_MESSAGES = 1024, MAX_TREE_DEPTH = 16, MAX_ATTR_VALUES = 4096
var MAX_GROUP_ENTRIES = 1024 // B-tree entries and symbols read for one group (DMI's have under 10)

function Unsupported(message) { this.message = "unsupported radar file: " + message }
Unsupported.prototype = Object.create(Error.prototype)

// Inflates one chunk, never past `max` bytes.
async function inflate(bytes, max) {
  var reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate")).getReader()
  var out = new Uint8Array(max), n = 0
  for (;;) {
    var r = await reader.read()
    if (r.done) break
    if (n + r.value.length > max) { reader.cancel(); throw new Unsupported("a chunk inflates past its size") }
    out.set(r.value, n)
    n += r.value.length
  }
  return out.subarray(0, n)
}

// ---- HDF5 (superblock 0, v1 object headers, v1 B-trees) ----

function H5(buffer) {
  if (buffer.byteLength > MAX_FILE_BYTES) throw new Unsupported("the file is too large")
  this.d = new Uint8Array(buffer)
  this.v = new DataView(buffer)
  var sig = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]
  for (var i = 0; i < 8; i++) if (this.d[i] !== sig[i]) throw new Unsupported("not an HDF5 file")
  if (this.d[8] !== 0) throw new Unsupported("HDF5 superblock version " + this.d[8])
  if (this.d[13] !== 8 || this.d[14] !== 8) throw new Unsupported("offsets are not 8 bytes")
  this.root = this.u64(56 + 8)
}
H5.prototype.check = function(o, n) {
  if (!(o >= 0) || o + (n || 1) > this.d.length) throw new Unsupported("a pointer leaves the file")
  return o
}
H5.prototype.u8 = function(o) { return this.d[this.check(o)] }
H5.prototype.u16 = function(o) { return this.v.getUint16(o, true) }
H5.prototype.u32 = function(o) { return this.v.getUint32(o, true) }
H5.prototype.u64 = function(o) { return this.v.getUint32(o, true) + this.v.getUint32(o + 4, true) * 4294967296 }
H5.prototype.tag = function(o) { this.check(o, 4); return String.fromCharCode(this.d[o], this.d[o + 1], this.d[o + 2], this.d[o + 3]) }
H5.prototype.cstr = function(o, max) {
  var s = ""
  this.check(o)
  for (var i = o; i < o + (max || 256) && i < this.d.length && this.d[i] !== 0; i++) s += String.fromCharCode(this.d[i])
  return s
}
H5.prototype.messages = function(addr) {
  if (this.u8(addr) !== 1) throw new Unsupported("object header version " + this.u8(addr))
  var count = Math.min(this.u16(addr + 2), MAX_MESSAGES), blocks = [[addr + 16, this.u32(addr + 8)]], out = [], seen = {}
  while (blocks.length && out.length < count) {
    var b = blocks.shift(), o = b[0]
    if (seen[o]) throw new Unsupported("an object header loops")
    seen[o] = true
    this.check(b[0], b[1])
    while (o + 8 <= b[0] + b[1] && out.length < count) {
      var type = this.u16(o), size = this.u16(o + 2), body = o + 8
      this.check(body, size)
      if (type === 0x10) blocks.push([this.u64(body), this.u64(body + 8)])
      out.push({ type: type, o: body, size: size })
      o = body + size
    }
  }
  return out
}
H5.prototype.children = function(addr) {
  var msgs = this.messages(addr), table = null
  for (var i = 0; i < msgs.length; i++) if (msgs[i].type === 0x11) table = msgs[i]
  if (!table) return {}
  var btree = this.u64(table.o), heap = this.u64(table.o + 8)
  if (this.tag(heap) !== "HEAP") throw new Unsupported("group without a local heap")
  var heapData = this.u64(heap + 24), out = {}, self = this, seen = {}, budget = MAX_GROUP_ENTRIES
  function spend(n) { budget -= n; if (budget < 0) throw new Unsupported("a group lists more entries than a radar file has") }
  ;(function node(a, depth) {
    if (depth > MAX_TREE_DEPTH || seen[a]) throw new Unsupported("a group B-tree loops or is too deep")
    seen[a] = true
    if (self.tag(a) !== "TREE") throw new Unsupported("bad group B-tree")
    var level = self.u8(a + 5), used = self.u16(a + 6), o = a + 24 + 8
    spend(used)
    for (var k = 0; k < used; k++) {
      var child = self.u64(o)
      o += 16
      if (level > 0) { node(child, depth + 1); continue }
      if (seen[child]) throw new Unsupported("a symbol node is listed twice")
      seen[child] = true
      if (self.tag(child) !== "SNOD") throw new Unsupported("bad symbol node")
      var symbols = self.u16(child + 6)
      spend(symbols)
      for (var s = 0; s < symbols; s++) {
        var e = child + 8 + 40 * s
        out[self.cstr(heapData + self.u64(e))] = self.u64(e + 8)
      }
    }
  })(btree, 0)
  return out
}
H5.prototype.path = function(p) {
  var addr = this.root, parts = p.split("/").filter(Boolean)
  for (var i = 0; i < parts.length; i++) {
    var kids = this.children(addr)
    if (!(parts[i] in kids)) throw new Unsupported("no " + p + " in the file")
    addr = kids[parts[i]]
  }
  return addr
}
function pad8(n) { return (n + 7) & ~7 }
H5.prototype.decode = function(o, dt, count) {
  var cls = this.u8(dt) & 0x0F, bits0 = this.u8(dt + 1), size = this.u32(dt + 4)
  if (count > MAX_ATTR_VALUES || size > 65536) throw new Unsupported("an attribute is too large")
  this.check(o, size * count)
  if (cls === 3) return this.cstr(o, size)
  var read
  if (cls === 0) {
    var signed = !!(bits0 & 0x08)
    read = size === 1 ? (signed ? this.v.getInt8.bind(this.v) : this.v.getUint8.bind(this.v))
      : size === 2 ? (signed ? (q) => this.v.getInt16(q, true) : (q) => this.v.getUint16(q, true))
      : size === 4 ? (signed ? (q) => this.v.getInt32(q, true) : (q) => this.v.getUint32(q, true))
      : (q) => Number(signed ? this.v.getBigInt64(q, true) : this.v.getBigUint64(q, true))
  } else if (cls === 1) {
    read = size === 4 ? (q) => this.v.getFloat32(q, true) : (q) => this.v.getFloat64(q, true)
  } else return null
  var vals = []
  for (var i = 0; i < count; i++) vals.push(read(o + i * size))
  return count === 1 ? vals[0] : vals
}
H5.prototype.attrs = function(addr) {
  var out = {}, msgs = this.messages(addr)
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i], o = m.o
    if (m.type !== 0x0C || this.u8(o) !== 1) continue
    var nameLen = this.u16(o + 2), dtLen = this.u16(o + 4), dsLen = this.u16(o + 6)
    var nameO = o + 8, dtO = nameO + pad8(nameLen), dsO = dtO + pad8(dtLen), dataO = dsO + pad8(dsLen)
    var rank = this.u8(dsO + 1), count = 1
    for (var k = 0; k < rank; k++) count *= this.u64(dsO + 8 + 8 * k)
    out[this.cstr(nameO, nameLen)] = this.decode(dataO, dtO, count)
  }
  return out
}
H5.prototype.datasetU8 = async function(addr) {
  var msgs = this.messages(addr), shape = null, layout = null, filters = []
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i], o = m.o
    if (m.type === 0x01) {
      var ver = this.u8(o), rank = this.u8(o + 1), base = o + (ver === 1 ? 8 : 4)
      shape = []
      for (var k = 0; k < rank; k++) shape.push(this.u64(base + 8 * k))
    } else if (m.type === 0x03) {
      if ((this.u8(o) & 0x0F) !== 0 || this.u32(o + 4) !== 1) throw new Unsupported("the radar data are not single bytes")
    } else if (m.type === 0x08) {
      layout = o
    } else if (m.type === 0x0B) {
      var fver = this.u8(o), n = this.u8(o + 1), p = o + (fver === 1 ? 8 : 2)
      for (var f = 0; f < n; f++) {
        var id = this.u16(p), nameLen = (fver === 1 || id >= 256) ? this.u16(p + 2) : 0, nvals = this.u16(p + 6)
        filters.push(id)
        p += 8 + (fver === 1 ? pad8(nameLen) : nameLen) + 4 * nvals
        if (fver === 1 && nvals % 2) p += 4
      }
    }
  }
  if (!shape || shape.length !== 2 || layout === null) throw new Unsupported("the radar dataset is not a 2-D grid")
  if (!(shape[0] > 0 && shape[0] <= MAX_GRID_SIDE && shape[1] > 0 && shape[1] <= MAX_GRID_SIDE && shape[0] * shape[1] <= MAX_GRID_BYTES))
    throw new Unsupported("the radar grid is " + shape[0] + " x " + shape[1])
  if (this.u8(layout) !== 3 || this.u8(layout + 1) !== 2) throw new Unsupported("the radar dataset is not stored in chunks")
  if (filters.some(function(x) { return x !== 1 })) throw new Unsupported("filters other than deflate")
  var dims = this.u8(layout + 2), btree = this.u64(layout + 3)
  if (dims !== 3) throw new Unsupported("the radar chunks have " + dims + " dimensions")
  var crow = this.u32(layout + 11), ccol = this.u32(layout + 15)
  var rows = shape[0], cols = shape[1]
  if (!(crow > 0 && crow <= rows && ccol > 0 && ccol <= cols) || this.u32(layout + 19) !== 1) throw new Unsupported("bad chunk size")
  var out = new Uint8Array(rows * cols), jobs = [], self = this, seen = {}, placed = {}
  var budget = 4 * Math.ceil(rows / crow) * Math.ceil(cols / ccol) + 64 // entries read, leaves and inner nodes
  ;(function node(a, depth) {
    if (depth > MAX_TREE_DEPTH || seen[a]) throw new Unsupported("a chunk B-tree loops or is too deep")
    seen[a] = true
    if (self.tag(a) !== "TREE" || self.u8(a + 4) !== 1) throw new Unsupported("bad chunk B-tree")
    var level = self.u8(a + 5), used = self.u16(a + 6), key = 8 + 8 * dims, o = a + 24
    budget -= used
    if (budget < 0) throw new Unsupported("the chunk tree lists more chunks than the grid holds")
    for (var k = 0; k < used; k++) {
      var size = self.u32(o), mask = self.u32(o + 4), r0 = self.u64(o + 8), c0 = self.u64(o + 16)
      var child = self.u64(o + key)
      if (level > 0) node(child, depth + 1)
      else {
        if (r0 >= rows || c0 >= cols || r0 % crow || c0 % ccol) throw new Unsupported("a chunk lies outside the grid")
        if (placed[r0 + "," + c0]) throw new Unsupported("a chunk is listed twice")
        placed[r0 + "," + c0] = true
        self.check(child, size)
        jobs.push({ raw: self.d.subarray(child, child + size), plain: (mask & 1) || !filters.length, r0: r0, c0: c0 })
      }
      o += key + 8
    }
  })(btree, 0)
  var want = crow * ccol
  var blocks = await Promise.all(jobs.map(function(j) { return j.plain ? j.raw : inflate(j.raw, want) }))
  for (var b = 0; b < jobs.length; b++) {
    var j = jobs[b], block = blocks[b]
    if (block.length !== want) throw new Unsupported("a chunk has the wrong size")
    var h = Math.min(crow, rows - j.r0), w = Math.min(ccol, cols - j.c0)
    for (var r = 0; r < h; r++) out.set(block.subarray(r * ccol, r * ccol + w), (j.r0 + r) * cols + j.c0)
  }
  return { rows: rows, cols: cols, data: out }
}

// ---- PROJ's ellipsoidal oblique stereographic (+proj=stere) ----

function Stere(projdef) {
  var p = {}
  projdef.replace(/\+(\w+)=(\S+)/g, function(_, k, v) { p[k] = v })
  if (p.proj !== "stere") throw new Unsupported("projection " + p.proj)
  if ((p.ellps || "WGS84") !== "WGS84") throw new Unsupported("ellipsoid " + p.ellps)
  this.a = 6378137.0
  var f = 1 / 298.257223563
  this.e = Math.sqrt(f * (2 - f))
  this.lon0 = parseFloat(p.lon_0 || 0)
  var phi0 = (parseFloat(p.lat_0 || 90)) * Math.PI / 180
  if (Math.abs(Math.abs(phi0) - Math.PI / 2) < 1e-9) throw new Unsupported("polar stereographic")
  var k0 = parseFloat(p.k || p.k_0 || 1), t = Math.sin(phi0)
  var X = 2 * Math.atan(this.ssfn(phi0, t)) - Math.PI / 2
  this.akm1 = 2 * k0 * Math.cos(phi0) / Math.sqrt(1 - Math.pow(this.e * t, 2))
  this.sinX1 = Math.sin(X)
  this.cosX1 = Math.cos(X)
}
Stere.prototype.ssfn = function(phit, sinphi) {
  sinphi *= this.e
  return Math.tan(0.5 * (Math.PI / 2 + phit)) * Math.pow((1 - sinphi) / (1 + sinphi), 0.5 * this.e)
}
Stere.prototype.forward = function(lon, lat) {
  var lam = (lon - this.lon0) * Math.PI / 180, phi = lat * Math.PI / 180
  var X = 2 * Math.atan(this.ssfn(phi, Math.sin(phi))) - Math.PI / 2
  var sX = Math.sin(X), cX = Math.cos(X), cl = Math.cos(lam)
  var A = this.akm1 / (this.cosX1 * (1 + this.sinX1 * sX + this.cosX1 * cX * cl))
  return [this.a * A * cX * Math.sin(lam), this.a * A * (this.cosX1 * sX - this.sinX1 * cX * cl)]
}
Stere.prototype.inverse = function(x, y) {
  x /= this.a; y /= this.a
  var rho = Math.hypot(x, y), tp = 2 * Math.atan2(rho * this.cosX1, this.akm1)
  var cosphi = Math.cos(tp), sinphi = Math.sin(tp)
  var phiL = rho === 0 ? Math.asin(cosphi * this.sinX1) : Math.asin(cosphi * this.sinX1 + y * sinphi * this.cosX1 / rho)
  tp = Math.tan(0.5 * (Math.PI / 2 + phiL))
  x *= sinphi
  y = rho * this.cosX1 * cosphi - y * this.sinX1 * sinphi
  var phi = phiL
  for (var i = 0; i < 15; i++) {
    var s = this.e * Math.sin(phiL)
    phi = 2 * Math.atan(tp * Math.pow((1 + s) / (1 - s), 0.5 * this.e)) - Math.PI / 2
    if (Math.abs(phiL - phi) < 1e-11) break
    phiL = phi
  }
  var lam = (x === 0 && y === 0) ? 0 : Math.atan2(x, y)
  return [lam * 180 / Math.PI + this.lon0, phi * 180 / Math.PI]
}

// Where each radar pixel falls on the map; the same for every scan of one
// radar grid, so kept between scans.
var geometryCache = {}
function geometry(proj, rows, cols, x0, y0, px, py, key) {
  if (geometryCache[key]) return geometryCache[key]
  var edge = []
  for (var k = 0; k <= 100; k++) {
    var t = k / 100
    ;[[WEST + (EAST - WEST) * t, SOUTH], [WEST + (EAST - WEST) * t, NORTH],
      [WEST, SOUTH + (NORTH - SOUTH) * t], [EAST, SOUTH + (NORTH - SOUTH) * t]].forEach(function(ll) {
      var xy = proj.forward(ll[0], ll[1])
      edge.push([(y0 - xy[1]) / py, (xy[0] - x0) / px])
    })
  }
  var rmin = Math.max(0, Math.floor(Math.min.apply(null, edge.map(function(e) { return e[0] }))) - 2)
  var rmax = Math.min(rows - 1, Math.floor(Math.max.apply(null, edge.map(function(e) { return e[0] }))) + 2)
  var cmin = Math.max(0, Math.floor(Math.min.apply(null, edge.map(function(e) { return e[1] }))) - 2)
  var cmax = Math.min(cols - 1, Math.floor(Math.max.apply(null, edge.map(function(e) { return e[1] }))) + 2)
  var width = cmax - cmin + 1, height = rmax - rmin + 1

  function steps(lo, hi) {
    var s = []
    for (var v = lo; v <= hi; v += LATTICE) s.push(v)
    if (s[s.length - 1] !== hi) s.push(hi)
    return s
  }
  var latRows = steps(rmin, rmax), latCols = steps(cmin, cmax)
  var lattice = latRows.map(function(r) {
    return latCols.map(function(c) { return proj.inverse(x0 + (c + 0.5) * px, y0 - (r + 0.5) * py) })
  })

  var gx = GRID_COLS / (EAST - WEST), gy = GRID_ROWS / (NORTH - SOUTH)
  var mx = PNG_W / (EAST - WEST), my = PNG_H / (NORTH - SOUTH)
  var cellOf = new Uint16Array(width * height).fill(NO_CELL)
  var pixOf = new Uint32Array(width * height)
  var cellAll = new Uint32Array(GRID_COLS * GRID_ROWS)
  var j = 0
  for (var r = rmin; r <= rmax; r++) {
    while (j + 1 < latRows.length - 1 && latRows[j + 1] < r) j++
    var fr = (r - latRows[j]) / (latRows[j + 1] - latRows[j])
    var top = lattice[j], bottom = lattice[j + 1], i = (r - rmin) * width
    for (var s = 0; s < latCols.length - 1; s++) {
      var c0 = latCols[s], c1 = latCols[s + 1]
      var lon0 = top[s][0] + (bottom[s][0] - top[s][0]) * fr, lat0 = top[s][1] + (bottom[s][1] - top[s][1]) * fr
      var lon1 = top[s + 1][0] + (bottom[s + 1][0] - top[s + 1][0]) * fr, lat1 = top[s + 1][1] + (bottom[s + 1][1] - top[s + 1][1]) * fr
      var dlon = (lon1 - lon0) / (c1 - c0), dlat = (lat1 - lat0) / (c1 - c0)
      var last = s === latCols.length - 2 ? c1 + 1 : c1
      for (var c = c0; c < last; c++) {
        var lon = lon0 + dlon * (c - c0), lat = lat0 + dlat * (c - c0)
        if (lon >= WEST && lon < EAST && lat > SOUTH && lat <= NORTH) {
          var cell = Math.floor((NORTH - lat) * gy) * GRID_COLS + Math.floor((lon - WEST) * gx)
          cellOf[i + c - cmin] = cell
          pixOf[i + c - cmin] = Math.floor((NORTH - lat) * my) * PNG_W + Math.floor((lon - WEST) * mx)
          cellAll[cell]++
        }
      }
    }
  }
  return (geometryCache[key] = { rmin: rmin, rmax: rmax, cmin: cmin, cmax: cmax, width: width, cellOf: cellOf, pixOf: pixOf, cellAll: cellAll })
}

// Converts one scan (an ArrayBuffer of the .h5 file). `colorAt(mm)` gives
// {r, g, b, a} (ColorScale.colorAt).
async function convert(buffer, colorAt) {
  try {
    return await convertChecked(buffer, colorAt)
  } catch (e) {
    if (e instanceof Unsupported) throw e
    throw new Unsupported(e && e.message ? e.message : String(e)) // a damaged file
  }
}

async function convertChecked(buffer, colorAt) {
  var h5 = new H5(buffer)
  var what = h5.attrs(h5.path("/what")), how = h5.attrs(h5.path("/how")), where = h5.attrs(h5.path("/where"))
  var meta = Object.assign({}, what)
  ;["/dataset1/what", "/dataset1/data1/what"].forEach(function(p) {
    try { Object.assign(meta, h5.attrs(h5.path(p))) } catch (e) { if (!(e instanceof Unsupported)) throw e }
  })
  var ds = await h5.datasetU8(h5.path("/dataset1/data1/data"))
  var rows = ds.rows, cols = ds.cols, raw = ds.data
  var gain = +(meta.gain !== undefined ? meta.gain : 0.5), offset = +(meta.offset !== undefined ? meta.offset : -32)
  var nodata = meta.nodata !== undefined ? +meta.nodata : 255, undetect = meta.undetect !== undefined ? +meta.undetect : 0
  var zrA = +(how["zr-a"] || 200), zrB = +(how["zr-b"] || 1.6)

  // byte -> rain rate; class 0 dry, 1 wet, 2 outside radar range
  var rate = new Float64Array(256), cls = new Uint8Array(256)
  for (var b = 0; b < 256; b++) {
    if (b === nodata) { cls[b] = 2; continue }
    if (b === undetect) continue
    var v = Math.pow(Math.pow(10, (b * gain + offset) / 10) / zrA, 1 / zrB)
    if (v >= RATE_FLOOR) { rate[b] = v; cls[b] = 1 }
  }

  var proj = new Stere(where.projdef)
  var ul = proj.forward(+where.UL_lon, +where.UL_lat)
  var x0 = ul[0], y0 = ul[1]
  var px = (proj.forward(+where.UR_lon, +where.UR_lat)[0] - x0) / cols
  var py = (y0 - proj.forward(+where.LL_lon, +where.LL_lat)[1]) / rows
  var geo = geometry(proj, rows, cols, x0, y0, px, py, [where.projdef, x0, y0, px, py, rows, cols].join("|"))

  var cellSum = new Float64Array(GRID_COLS * GRID_ROWS), cellOut = new Uint32Array(GRID_COLS * GRID_ROWS)
  var mapSum = new Float64Array(PNG_W * PNG_H), mapN = new Uint32Array(PNG_W * PNG_H)
  for (var r = geo.rmin; r <= geo.rmax; r++) {
    var base = r * cols + geo.cmin, g = (r - geo.rmin) * geo.width
    for (var k = 0; k < geo.width; k++) {
      var kind = cls[raw[base + k]]
      if (kind === 0) continue
      var cell = geo.cellOf[g + k]
      if (cell === NO_CELL) continue
      if (kind === 1) {
        var val = rate[raw[base + k]]
        cellSum[cell] += val
        var pix = geo.pixOf[g + k]
        mapSum[pix] += val
        mapN[pix]++
      } else cellOut[cell]++
    }
  }

  var values = new Float32Array(GRID_COLS * GRID_ROWS)
  for (var c = 0; c < values.length; c++) {
    var n = geo.cellAll[c] - cellOut[c]
    values[c] = n > 0 ? Math.round(cellSum[c] / n * 1000) / 1000 : 0
  }
  var rgba = new Uint8ClampedArray(PNG_W * PNG_H * 4)
  for (var p = 0; p < PNG_W * PNG_H; p++) {
    if (!mapN[p]) continue
    var col = colorAt(mapSum[p] / mapN[p])
    rgba[4 * p] = col.r; rgba[4 * p + 1] = col.g; rgba[4 * p + 2] = col.b; rgba[4 * p + 3] = col.a
  }
  return {
    grid: { cols: GRID_COLS, rows: GRID_ROWS, bounds: { west: WEST, south: SOUTH, east: EAST, north: NORTH }, values: values },
    image: { width: PNG_W, height: PNG_H, data: rgba }
  }
}

if (typeof module !== "undefined") module.exports = { convert: convert, Stere: Stere, Unsupported: Unsupported, PNG_W: PNG_W, PNG_H: PNG_H }
