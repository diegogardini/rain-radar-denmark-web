const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const WebRadar = require('../site/radar.js')

// The site converts DMI's scans in the browser (site/radar.js); it must give
// exactly what the widget's helpers/dmi-radar-convert.py gives, on the widget's
// own real-scan fixture. The widget checkout: $WIDGET_DIR, else next door.
const widget = path.resolve(process.env.WIDGET_DIR || path.join(__dirname, '..', '..', 'omarchy-rain-radar-denmark-widget'))
const ColorScale = require(path.join(widget, 'ColorScale.js'))
const fixturePath = path.join(widget, 'tests', 'fixtures', 'dmi-scan-20260730-1830.h5')
test('site/radar.js converts a real scan exactly as the widget\'s Python converter', async () => {
  const fixture = fixturePath
  const buf = fs.readFileSync(fixture)
  const out = await WebRadar.convert(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), ColorScale.colorAt)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rain-radar-web-'))
  try {
    execFileSync('python3', [path.join(widget, 'helpers', 'dmi-radar-convert.py'), fixture, path.join(dir, 'scan')])
    const py = JSON.parse(fs.readFileSync(path.join(dir, 'scan.nowcast-grid.json'), 'utf8'))
    assert.equal(out.grid.values.length, py.values.length)
    let worst = 0
    for (let i = 0; i < py.values.length; i++) worst = Math.max(worst, Math.abs(out.grid.values[i] - py.values[i]))
    assert.ok(worst < 1e-3, `largest difference ${worst}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(out.image.width, 640)
  assert.equal(out.image.height, 458)
  let coloured = 0
  for (let i = 3; i < out.image.data.length; i += 4) coloured += out.image.data[i] > 0
  assert.ok(coloured > 40000, `${coloured} rain pixels on the map`)
})

test('site/radar.js refuses a file that is not a DMI scan', async () => {
  const bytes = new TextEncoder().encode('not an HDF5 file')
  await assert.rejects(WebRadar.convert(bytes.buffer, ColorScale.colorAt), /unsupported radar file/)
})

test('site/radar.js refuses a damaged scan', async () => {
  const whole = fs.readFileSync(fixturePath)
  const cut = whole.subarray(0, 60000)
  await assert.rejects(WebRadar.convert(cut.buffer.slice(cut.byteOffset, cut.byteOffset + cut.length), ColorScale.colorAt), /unsupported radar file/)
  const bent = Buffer.from(whole)
  for (let i = 20000; i < 20400; i++) bent[i] ^= 0x5a
  await assert.rejects(WebRadar.convert(bent.buffer.slice(bent.byteOffset, bent.byteOffset + bent.length), ColorScale.colorAt), /unsupported radar file/)
})
