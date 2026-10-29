// Fetches and measures one z13 tile (~5 km) of roads, entirely in the browser: every road owned by
// the tile gets its ~1 mile corridor metrics. Scoring stays on the main thread so weight sliders never
// refetch.
importScripts("https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js", "https://unpkg.com/pmtiles@3.2.1/dist/pmtiles.js");

const CELL = 25;          // raster resolution in meters
const NEAR = 3;           // "alongside the road" = within 3 cells
const SAMPLE = 25;        // spacing of measurement points along each road
const BUFFER = 1000;     // meters of context fetched around the tile (corridors, junctions)
const CORRIDOR = 1600;
const BIG_BUILDING_M2 = 1500;

const INCLUDE = new Set(["motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
  "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified", "residential", "living_street", "road"]);
const DRIVABLE = new Set([...INCLUDE, "service", "track"]);
const STOP_WEIGHT = { signal: 1, rail: 1, stop: 0.5, yield: 0.25 };
const POINT_KIND = { traffic_signals: "signal", stop: "stop", give_way: "yield" };
const OPEN_COVER = new Set([10, 20, 30, 40, 60, 90, 95, 100]);
const KMH_PER_MPH = 1.609344;

self.onmessage = async e => {
  const { id, x, y, z } = e.data;
  const stage = s => postMessage({ id, stage: s });
  try {
    postMessage({ id, ok: true, ...(await measureTile(x, y, z, stage)) });
  } catch (err) {
    postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};

// ---------------------------------------------------------------- geometry

const tileLon = (x, z) => x / 2 ** z * 360 - 180;
const tileLat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) * 180 / Math.PI;

function projection(lat0, lon0) {
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  return {
    xy: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    latlon: (x, y) => [lat0 + y / ky, lon0 + x / kx],
  };
}

function simplify(pts, tol) {
  if (pts.length < 3) return pts.map((_, i) => i);
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(), [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, seg = Math.hypot(dx, dy);
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      const d = seg === 0 ? Math.hypot(px - ax, py - ay) : Math.abs(dy * px - dx * py + bx * ay - by * ax) / seg;
      if (d > best) { best = d; bi = i; }
    }
    if (best > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return [...keep.keys()].filter(i => keep[i]);
}

function turningDegrees(pts) {
  let total = 0, prev = null;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
    if (Math.hypot(dx, dy) < 0.5) continue;
    const h = Math.atan2(dy, dx);
    if (prev !== null) { const d = Math.abs(h - prev); total += Math.min(d, 2 * Math.PI - d) * 180 / Math.PI; }
    prev = h;
  }
  return total;
}

function resample(xy, step) {
  const dist = [0];
  for (let i = 1; i < xy.length; i++) dist.push(dist[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  const L = dist[dist.length - 1], out = [];
  let j = 0;
  for (let t = 0; ; t += step) {
    if (t > L) t = L;
    while (j < xy.length - 2 && dist[j + 1] < t) j++;
    const seg = dist[j + 1] - dist[j], f = seg > 0 ? (t - dist[j]) / seg : 0;
    out.push([xy[j][0] + f * (xy[j + 1][0] - xy[j][0]), xy[j][1] + f * (xy[j + 1][1] - xy[j][1])]);
    if (t >= L) break;
  }
  return { pts: out, length: L };
}

function parseMaxspeed(v) {
  if (!v) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?/.exec(v.split(";")[0]);
  if (!m) return null;
  return m[2] === "mph" ? +m[1] : +m[1] / KMH_PER_MPH;
}

const median = a => { const s = [...a].sort((p, q) => p - q), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

// ---------------------------------------------------------------- raster

class Raster {
  constructor(x0, y1, w, h) { Object.assign(this, { x0, y1, w, h }); }
  cell(x, y) {
    const c = Math.min(this.w - 1, Math.max(0, Math.floor((x - this.x0) / CELL)));
    const r = Math.min(this.h - 1, Math.max(0, Math.floor((this.y1 - y) / CELL)));
    return r * this.w + c;
  }
  center(i) { return [this.x0 + (i % this.w + 0.5) * CELL, this.y1 - (Math.floor(i / this.w) + 0.5) * CELL]; }
  boxSum(grid, half) {
    const { w, h } = this, W = w + 1, pre = new Float64Array(W * (h + 1)), out = new Float32Array(w * h);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++)
      pre[(r + 1) * W + c + 1] = grid[r * w + c] + pre[r * W + c + 1] + pre[(r + 1) * W + c] - pre[r * W + c];
    for (let r = 0; r < h; r++) {
      const r0 = Math.max(0, r - half), r1 = Math.min(h, r + half + 1);
      for (let c = 0; c < w; c++) {
        const c0 = Math.max(0, c - half), c1 = Math.min(w, c + half + 1);
        out[r * w + c] = pre[r1 * W + c1] - pre[r0 * W + c1] - pre[r1 * W + c0] + pre[r0 * W + c0];
      }
    }
    return out;
  }
  polygonMask(polys, proj) {
    const cv = new OffscreenCanvas(this.w, this.h), ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff";
    for (const rings of polys) {
      ctx.beginPath();
      for (const ring of rings) ring.forEach(([lat, lon], i) => {
        const [x, y] = proj.xy(lat, lon), px = (x - this.x0) / CELL, py = (this.y1 - y) / CELL;
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      });
      ctx.fill("evenodd");
    }
    const d = ctx.getImageData(0, 0, this.w, this.h).data, out = new Uint8Array(this.w * this.h);
    for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3] > 127 ? 1 : 0;
    return out;
  }
}

// ---------------------------------------------------------------- data sources

// ---------------------------------------------------------------- map data providers
// Three ways to get the same OpenStreetMap data, tried in order (like Fairway Atlas): Postpass
// (Geofabrik's SQL-over-OSM service, fastest), the OSM editing API, then Overpass. Each gets a
// deadline covering the whole download; a 429 benches that provider for a while. Everything is
// normalized to one shape, with nodes identified by their exact coordinates (Postpass doesn't
// return node ids, but OSM ways that share a node share its coordinates exactly).

const ROAD_VALUES = [...DRIVABLE];
const PROVIDERS = [
  { name: "Postpass", deadline: 10000, fetch: postpass },
  { name: "OSM API", deadline: 12000, fetch: editingApi },
  { name: "Overpass", deadline: 25000, fetch: overpass },
];
const benched = new Map();   // provider name -> time it may be used again
const nodeKey = (lat, lon) => Math.round(lon * 1e7) + "," + Math.round(lat * 1e7);

async function fetchArea(s, w, n, e, stage, proj, osmBuildings) {
  const errors = [];
  for (const p of PROVIDERS) {
    if ((benched.get(p.name) || 0) > Date.now()) { errors.push(`${p.name} rate-limited`); continue; }
    const c = new AbortController(), timer = setTimeout(() => c.abort(), p.deadline), t0 = Date.now();
    try {
      const data = await p.fetch(s, w, n, e, c.signal, mb => stage(`${p.name} · ${mb.toFixed(1)} MB`), stage, proj, osmBuildings);
      data.provider = p.name;
      return data;
    } catch (err) {
      const msg = c.signal.aborted ? `${p.name} too slow (${Math.round((Date.now() - t0) / 1000)}s)` : `${p.name}: ${err.message || err}`;
      if (err.status === 429) benched.set(p.name, Date.now() + 60000);
      errors.push(msg);
      stage(msg + ", trying next");
    } finally { clearTimeout(timer); }
  }
  throw new Error(errors.join("; "));
}

async function download(url, init, signal, progress) {
  const r = await fetch(url, { ...init, signal });
  if (!r.ok) { const err = new Error(`HTTP ${r.status}`); err.status = r.status; throw err; }
  const reader = r.body.getReader(), chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); bytes += value.length; progress(bytes / 1e6);
  }
  return JSON.parse(await new Blob(chunks).text());
}

function pointKind(tags) {
  return tags.railway === "level_crossing" ? "rail" : POINT_KIND[tags.highway];
}

async function postpass(s, w, n, e, signal, progress, stage, proj, osmBuildings) {
  const env = `geom && ST_MakeEnvelope(${w},${s},${e},${n},4326)`, list = a => a.map(v => `'${v}'`).join(",");
  const q1 = `SELECT osm_id, osm_type, tags, geom FROM postpass_pointlinepolygon WHERE ${env} AND (` +
    `tags->>'highway' IN (${list([...ROAD_VALUES, ...Object.keys(POINT_KIND)])}) OR tags->>'railway'='level_crossing' OR ` +
    `(osm_type<>'N' AND tags->>'landuse' IN ('commercial','retail','industrial')))`;
  // Buildings come back as one point each with the footprint area, computed server-side.
  const q2 = `SELECT osm_id, osm_type, json_build_object('a', round(ST_Area(geom::geography))) AS tags, ` +
    `ST_PointOnSurface(geom) AS geom FROM postpass_polygon WHERE ${env} AND tags ? 'building'`;
  const mb = [0, 0], post = (q, i) => download("https://postpass.geofabrik.de/api/interpreter", {
    method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded" },
  }, signal, v => { mb[i] = v; progress(mb[0] + mb[1]); });
  const [a, b] = await Promise.all([post(q1, 0), osmBuildings ? post(q2, 1) : { features: [] }]);
  const out = { roads: [], points: new Map(), buildings: [], polys: [] };
  const ring = cs => cs.map(([lon, lat]) => ({ lat, lon }));
  for (const f of a.features) {
    const p = f.properties, tags = typeof p.tags === "string" ? JSON.parse(p.tags) : p.tags || {}, g = f.geometry;
    if (!g) continue;
    if (g.type === "Point") { const k = pointKind(tags); if (k) out.points.set(nodeKey(g.coordinates[1], g.coordinates[0]), k); }
    else if (tags.highway && DRIVABLE.has(tags.highway)) {
      const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates
        : g.type === "Polygon" ? [g.coordinates[0]] : [];
      for (const cs of lines) out.roads.push({ id: +p.osm_id, tags, geometry: ring(cs) });
    } else if (g.type === "Polygon") out.polys.push(g.coordinates.slice(0, 1).map(r => r.map(([lon, lat]) => [lat, lon])));
    else if (g.type === "MultiPolygon") out.polys.push(g.coordinates.map(poly => poly[0].map(([lon, lat]) => [lat, lon])));
  }
  for (const f of b.features) if (f.geometry) {
    const p = f.properties, t = typeof p.tags === "string" ? JSON.parse(p.tags) : p.tags;
    out.buildings.push([f.geometry.coordinates[1], f.geometry.coordinates[0], t.a]);
  }
  return out;
}

// Shared by the editing API and Overpass, which both return OSM elements.
function fromElements(elements, proj) {
  const nodes = new Map(), out = { roads: [], points: new Map(), buildings: [], polys: [] };
  for (const el of elements) if (el.type === "node") {
    nodes.set(el.id, el);
    const k = el.tags && pointKind(el.tags);
    if (k) out.points.set(nodeKey(el.lat, el.lon), k);
  }
  const geom = el => el.geometry || (el.nodes && el.nodes.every(id => nodes.has(id)) ? el.nodes.map(id => nodes.get(id)) : null);
  for (const el of elements) {
    const t = el.tags || {};
    if (el.type === "way" && t.highway && DRIVABLE.has(t.highway)) {
      const g = geom(el);
      if (g) out.roads.push({ id: el.id, tags: t, geometry: g.map(({ lat, lon }) => ({ lat, lon })) });
    } else if (el.type === "way" && (t.building || el.bounds && !t.landuse && !el.geometry)) {
      let b = el.bounds;
      if (!b) { const g = geom(el); if (!g) continue;
        b = { minlat: Math.min(...g.map(p => p.lat)), maxlat: Math.max(...g.map(p => p.lat)), minlon: Math.min(...g.map(p => p.lon)), maxlon: Math.max(...g.map(p => p.lon)) }; }
      const [ax, ay] = proj.xy(b.minlat, b.minlon), [cx, cy] = proj.xy(b.maxlat, b.maxlon);
      out.buildings.push([(b.minlat + b.maxlat) / 2, (b.minlon + b.maxlon) / 2, (cx - ax) * (cy - ay) * 0.75]);   // bbox → rough footprint
    } else if (el.type === "way" && /^(commercial|retail|industrial)$/.test(t.landuse)) {
      const g = geom(el); if (g) out.polys.push([g.map(p => [p.lat, p.lon])]);
    } else if (el.type === "relation" && /^(commercial|retail|industrial)$/.test(t.landuse) && el.members) {
      out.polys.push(el.members.filter(m => m.geometry && m.role !== "inner").map(m => m.geometry.map(p => [p.lat, p.lon])));
    }
  }
  return out;
}

// The OSM editing API is meant for editors; fine for this personal map, not for broad distribution.
// It refuses areas over 50,000 nodes, so dense neighborhoods fall through to Overpass.
async function editingApi(s, w, n, e, signal, progress, stage, proj) {
  const d = await download(`https://api.openstreetmap.org/api/0.6/map.json?bbox=${w},${s},${e},${n}`, {}, signal, progress);
  return fromElements(d.elements, proj);
}

async function overpass(s, w, n, e, signal, progress, stage, proj) {
  const q = `[out:json][timeout:25][bbox:${s},${w},${n},${e}];
way["highway"~"^(${ROAD_VALUES.join("|")})$"]->.r;
.r out body geom qt;
(node(w.r)["highway"~"^(traffic_signals|stop|give_way)$"];node(w.r)["railway"="level_crossing"];);
out tags qt;
way["building"];
out ids bb qt;
(way["landuse"~"^(commercial|retail|industrial)$"];relation["landuse"~"^(commercial|retail|industrial)$"];);
out geom qt;`;
  const d = await download("https://overpass-api.de/api/interpreter", { method: "POST", body: "data=" + encodeURIComponent(q),
    headers: { "Content-Type": "application/x-www-form-urlencoded" } }, signal, progress);
  // `out tags` drops node coordinates, so look them up from the road geometry instead.
  const ids = new Map();
  for (const el of d.elements) if (el.type === "way" && el.nodes && el.geometry) el.nodes.forEach((id, i) => ids.set(id, el.geometry[i]));
  for (const el of d.elements) if (el.type === "node" && el.lat == null && ids.has(el.id)) Object.assign(el, ids.get(el.id));
  return fromElements(d.elements, proj);
}

// ---------------------------------------------------------------- Overture buildings
// OSM is missing house footprints in many suburbs (whole Jefferson County subdivisions read as
// 0 buildings/mi), so buildings come from Overture, which adds Microsoft and Google footprints,
// so suburbs read as built up. Read from Overture's PMTiles (z14 vector tiles) by range request.
const OVERTURE_BUILDINGS = "https://tiles.overturemaps.org/2026-10-21.0/buildings.pmtiles";
let overtureArchive = null;

// Minimal Mapbox Vector Tile reader: [lat, lon, area m²] for each polygon in the "building" layer.
function mvtBuildings(buf, z, x, y) {
  const b = new Uint8Array(buf), out = [];
  let pos = 0;
  const varint = () => { let v = 0, s = 1, c; do { c = b[pos++]; v += (c & 0x7f) * s; s *= 128; } while (c & 0x80); return v; };
  const skip = wt => { if (wt === 0) varint(); else if (wt === 1) pos += 8; else if (wt === 2) { const L = varint(); pos += L; } else if (wt === 5) pos += 4; };
  const zz = n => (n >>> 1) ^ -(n & 1);
  while (pos < b.length) {
    const tag = varint();
    if (tag >> 3 !== 3 || (tag & 7) !== 2) { skip(tag & 7); continue; }
    const layerEnd = varint() + pos;
    let name = "", extent = 4096;
    const geoms = [];
    while (pos < layerEnd) {
      const t = varint(), f = t >> 3;
      if (f === 1) { const L = varint(); name = new TextDecoder().decode(b.subarray(pos, pos + L)); pos += L; }
      else if (f === 5) extent = varint();
      else if (f === 2) {
        const featEnd = varint() + pos;
        let type = 0, g = null;
        while (pos < featEnd) {
          const ft = varint(), ff = ft >> 3;
          if (ff === 3) type = varint();
          else if (ff === 4) { const L = varint(); g = [pos, pos + L]; pos += L; }
          else skip(ft & 7);
        }
        if (type === 3 && g) geoms.push(g);
      } else skip(t & 7);
    }
    if (name !== "building") { pos = layerEnd; continue; }
    const save = pos, n2 = 2 ** z;
    for (const [g0, g1] of geoms) {
      pos = g0;
      let cx = 0, cy = 0, sx = 0, sy = 0, cnt = 0, area = 0, ring = [];
      const flush = () => {
        if (ring.length < 3) return;
        let a = 0;
        for (let i = 0; i < ring.length; i++) { const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length]; a += x1 * y2 - x2 * y1; }
        area += a / 2;     // outer rings and holes have opposite signs, so this nets out holes
        if (!cnt) for (const [px, py] of ring) { sx += px; sy += py; cnt++; }
      };
      while (pos < g1) {
        const cmd = varint(), id = cmd & 7, count = cmd >> 3;
        if (id === 7) { flush(); ring = []; continue; }
        for (let i = 0; i < count; i++) { cx += zz(varint()); cy += zz(varint()); if (id === 1) { flush(); ring = []; } ring.push([cx, cy]); }
      }
      flush();
      if (!cnt) continue;
      const lon = (x + sx / cnt / extent) / n2 * 360 - 180;
      const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + sy / cnt / extent) / n2))) * 180 / Math.PI;
      const m = 40075016 * Math.cos(lat * Math.PI / 180) / n2 / extent;   // meters per tile unit
      out.push([lat, lon, Math.abs(area) * m * m]);
    }
    pos = Math.max(save, layerEnd);
  }
  return out;
}

// Overture's CDN occasionally drops one of many parallel range requests; retry those a few times.
// pmtiles caches a failed header or directory fetch inside the archive object, so a retry has to
// start from a fresh archive, or one early failure breaks every later area in this worker.
async function withRetry(fn, tries = 4) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (err) {
      if (i >= tries - 1) throw err;
      overtureArchive = null;
      await new Promise(r => setTimeout(r, 400 * 2 ** i));
    }
  }
}

async function overtureBuildings(s, w, n, e) {
  const Z = 14, N = 2 ** Z, jobs = [];
  const tx = lon => Math.floor((lon + 180) / 360 * N), ty = lat => Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * N);
  for (let x = tx(w); x <= tx(e); x++) for (let y = ty(n); y <= ty(s); y++)
    jobs.push(withRetry(() => (overtureArchive ||= new pmtiles.PMTiles(OVERTURE_BUILDINGS)).getZxy(Z, x, y))
      .then(t => t ? mvtBuildings(t.data, Z, x, y) : []));
  // A building crossing a tile edge appears in both tiles; the double count is small and even.
  return (await Promise.all(jobs)).flat().filter(([lat, lon]) => lat >= s && lat <= n && lon >= w && lon <= e);
}

let sasToken = null;
async function landcoverToken() {
  if (sasToken && sasToken.expires > Date.now() + 120000) return sasToken.token;
  const j = await (await fetch("https://planetarycomputer.microsoft.com/api/sas/v1/token/ai4edataeuwest/esa-worldcover")).json();
  sasToken = { token: j.token, expires: Date.parse(j["msft:expiry"]) || Date.now() + 1800000 };
  return sasToken.token;
}

// ESA WorldCover classes for every raster cell (0 where unknown). Reads only the needed window
// of each 3° source tile, at roughly the raster's resolution, so a tile costs a few hundred KB.
async function landcover(raster, proj, s, w, n, e) {
  const token = await landcoverToken(), out = new Uint8Array(raster.w * raster.h);
  for (let la = Math.floor(s / 3) * 3; la < n; la += 3) for (let lo = Math.floor(w / 3) * 3; lo < e; lo += 3) {
    const name = (la >= 0 ? "N" : "S") + String(Math.abs(la)).padStart(2, "0") + (lo >= 0 ? "E" : "W") + String(Math.abs(lo)).padStart(3, "0");
    const url = `https://ai4edataeuwest.blob.core.windows.net/esa-worldcover/v200/2021/map/ESA_WorldCover_10m_2021_v200_${name}_Map.tif?${token}`;
    const bs = Math.max(s, la), bw = Math.max(w, lo), bn = Math.min(n, la + 3), be = Math.min(e, lo + 3);
    const ow = Math.ceil((be - bw) * 111320 * Math.cos(bs * Math.PI / 180) / 20), oh = Math.ceil((bn - bs) * 110540 / 20);
    const tiff = await GeoTIFF.fromUrl(url, { allowFullFile: false });
    const [band] = await tiff.readRasters({ bbox: [bw, bs, be, bn], width: ow, height: oh, resampleMethod: "nearest" });
    for (let i = 0; i < out.length; i++) {
      const [lat, lon] = proj.latlon(...raster.center(i));
      if (lat < bs || lat >= bn || lon < bw || lon >= be) continue;
      const px = Math.min(ow - 1, Math.floor((lon - bw) / (be - bw) * ow)), py = Math.min(oh - 1, Math.floor((bn - lat) / (bn - bs) * oh));
      out[i] = band[py * ow + px];
    }
  }
  return out;
}

// Mapterhorn Terrarium tiles (512 px) at z12, decoded to meters.
async function elevation(s, w, n, e) {
  const Z = 12, N = 2 ** Z, tiles = new Map();
  const tx = lon => (lon + 180) / 360 * N;
  const ty = lat => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * N;
  const jobs = [];
  for (let x = Math.floor(tx(w)); x <= Math.floor(tx(e)); x++) for (let y = Math.floor(ty(n)); y <= Math.floor(ty(s)); y++)
    jobs.push((async () => {
      const r = await fetch(`https://tiles.mapterhorn.com/${Z}/${x}/${y}.webp`);
      if (!r.ok) return;
      const bmp = await createImageBitmap(await r.blob()), S = bmp.width;
      const cv = new OffscreenCanvas(S, S), ctx = cv.getContext("2d");
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, S, S).data, dem = new Float32Array(S * S);
      for (let i = 0; i < dem.length; i++) dem[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
      tiles.set(x + "/" + y, { S, dem });
    })());
  await Promise.all(jobs);
  return (lat, lon) => {
    const fx = tx(lon), fy = ty(lat), t = tiles.get(Math.floor(fx) + "/" + Math.floor(fy));
    if (!t) return null;
    const px = Math.min(t.S - 1, Math.floor((fx % 1) * t.S)), py = Math.min(t.S - 1, Math.floor((fy % 1) * t.S));
    return t.dem[py * t.S + px];
  };
}

// ---------------------------------------------------------------- measure

async function measureTile(tx, ty, tz, stage) {
  const tn = tileLat(ty, tz), ts = tileLat(ty + 1, tz), tw = tileLon(tx, tz), te = tileLon(tx + 1, tz);
  const lat0 = (tn + ts) / 2, lon0 = (tw + te) / 2, proj = projection(lat0, lon0);
  const dLat = BUFFER / 110540, dLon = BUFFER / (111320 * Math.cos(lat0 * Math.PI / 180));
  const s = ts - dLat, n = tn + dLat, w = tw - dLon, e = te + dLon;
  const [x0, y0] = proj.xy(s, w), [x1, y1] = proj.xy(n, e);
  const raster = new Raster(x0, y1, Math.ceil((x1 - x0) / CELL), Math.ceil((y1 - y0) / CELL));

  // Land cover and elevation load alongside the map data.
  const coverP = landcover(raster, proj, s, w, n, e).catch(err => (console.warn("land cover:", err), null));
  const elevP = elevation(s, w, n, e).catch(err => (console.warn("elevation:", err), null));
  let overtureError = "";
  const overtureP = overtureBuildings(s, w, n, e).catch(err => (overtureError = String(err && err.message || err), null));
  stage("Postpass · connecting");
  // Only ask OSM for buildings if Overture already failed; otherwise it's wasted download.
  const early = await Promise.race([overtureP, new Promise(r => setTimeout(() => r(undefined), 50))]);
  const osm = await fetchArea(s, w, n, e, stage, proj, early === null);
  const overture = await overtureP;
  if (overture) { osm.buildings = overture; osm.buildingSource = "Overture"; }
  else if (early === null) osm.buildingSource = "OSM";
  // Scoring without buildings would paint every suburb as remote backroads; fail and retry instead.
  else throw new Error(`Overture buildings didn't load: ${overtureError || "unknown error"}`);
  stage(`Measuring roads (data from ${osm.provider})`);
  const [cover, elev] = await Promise.all([coverP, elevP]);

  const ways = osm.roads, points = osm.points, polys = osm.polys;
  const grid = new Float32Array(raster.w * raster.h), big = new Uint8Array(grid.length);
  for (const [lat, lon, area] of osm.buildings) {
    const i = raster.cell(...proj.xy(lat, lon));
    grid[i]++;
    if (area >= BIG_BUILDING_M2) big[i] = 1;
  }
  for (const wy of ways) wy.keys = wy.geometry.map(g => nodeKey(g.lat, g.lon));

  const nearBuildings = raster.boxSum(grid, NEAR);
  const boxM = (2 * NEAR + 1) * CELL, boxCells = (2 * NEAR + 1) ** 2;
  const com0 = raster.polygonMask(polys, proj);
  for (let i = 0; i < com0.length; i++) com0[i] |= big[i];
  const comNear = raster.boxSum(com0, NEAR);
  let nature = null;
  if (cover) {
    const open = new Uint8Array(cover.length);
    let any = 0;
    for (let i = 0; i < cover.length; i++) if (OPEN_COVER.has(cover[i])) { open[i] = 1; any++; }
    if (any) nature = raster.boxSum(open, NEAR);
  }

  const degree = new Map();
  for (const wy of ways) {
    if (!DRIVABLE.has(wy.tags.highway)) continue;
    const L = wy.keys.length;
    wy.keys.forEach((nd, k) => degree.set(nd, (degree.get(nd) || 0) + (k > 0) + (k < L - 1)));
  }

  const roads = [];
  for (const wy of ways) {
    const t = wy.tags;
    if (!INCLUDE.has(t.highway) || t.access === "private" || t.access === "no" || t.area === "yes") continue;
    const xy = wy.geometry.map(g => proj.xy(g.lat, g.lon));
    const { pts, length } = resample(xy, SAMPLE);
    if (length < 1) continue;
    let bsum = 0, com = 0, nat = 0;
    const el = [];
    for (const [px, py] of pts) {
      const i = raster.cell(px, py);
      bsum += nearBuildings[i]; com += comNear[i] > 0; nat += nature ? nature[i] / boxCells : 0;
      if (elev) { const v = elev(...proj.latlon(px, py)); if (v !== null) el.push(v); }
    }
    let relief = 0;
    if (el.length >= 5) {
      const sm = [];
      for (let i = 0; i + 5 <= el.length; i++) sm.push((el[i] + el[i + 1] + el[i + 2] + el[i + 3] + el[i + 4]) / 5);
      for (let i = 1; i < sm.length; i++) relief += Math.abs(sm[i] - sm[i - 1]);
    } else for (let i = 1; i < el.length; i++) relief += Math.abs(el[i] - el[i - 1]);
    const ends = new Set([wy.keys[0], wy.keys[wy.keys.length - 1]]);
    let stops = 0, access = 0;
    for (const nd of wy.keys) {
      const f = ends.has(nd) ? 0.5 : 1;
      stops += (STOP_WEIGHT[points.get(nd)] || 0) * f;
      if ((degree.get(nd) || 0) >= 3) access += f;
    }
    const mid = wy.geometry[wy.geometry.length >> 1];
    roads.push({
      way: wy, xy, length, n: pts.length, bsum, com, nat, stops, access, relief,
      turning: turningDegrees(simplify(xy, 2).map(i => xy[i])),
      speed: parseMaxspeed(t.maxspeed),
      own: mid.lat >= ts && mid.lat < tn && mid.lon >= tw && mid.lon < te,
    });
  }

  // Corridors: each owned road plus same-named neighbors out to ~CORRIDOR meters.
  const key = r => r.way.tags.name || r.way.tags.ref, byEnd = new Map();
  roads.forEach((r, i) => {
    const k = key(r);
    if (k) for (const nd of [r.way.keys[0], r.way.keys[r.way.keys.length - 1]]) {
      const kk = k + "\u0000" + nd;
      byEnd.has(kk) ? byEnd.get(kk).push(i) : byEnd.set(kk, [i]);
    }
  });
  const out = [];
  roads.forEach((rd, i) => {
    if (!rd.own) return;
    const k = key(rd), group = [i];
    if (k && rd.length < CORRIDOR) {
      const seen = new Set([i]), queue = [i];
      let total = rd.length;
      while (queue.length && total < CORRIDOR) {
        const j = queue.shift();
        for (const nd of [roads[j].way.keys[0], roads[j].way.keys[roads[j].way.keys.length - 1]])
          for (const m of byEnd.get(k + "\u0000" + nd) || [])
            if (!seen.has(m) && total < CORRIDOR) { seen.add(m); queue.push(m); group.push(m); total += roads[m].length; }
      }
    }
    const mem = group.map(g => roads[g]);
    const L = mem.reduce((a, r) => a + r.length, 0), km = L / 1000, mi = L / 1609.344, nn = mem.reduce((a, r) => a + r.n, 0);
    const sum = f => mem.reduce((a, r) => a + r[f], 0);
    let speed = rd.speed, src = speed != null ? "posted" : null;
    if (speed == null) {
      const near = mem.map(r => r.speed).filter(v => v != null);
      if (near.length) { speed = median(near); src = "street"; }
    }
    const keep = simplify(rd.xy, 5), g = rd.way.geometry;
    const p = {
      id: rd.way.id, h: rd.way.tags.highway, l: Math.round(rd.length),
      c: sum("turning") / km, e: sum("relief") / km, st: sum("stops") / mi, a: sum("access") / mi,
      b: sum("bsum") / nn / boxM * 1609.344, cm: sum("com") / nn, nt: nature ? sum("nat") / nn : null,
    };
    if (speed != null) { p.s = Math.round(speed); p.ss = src; }
    if (k) p.n = k;
    out.push({ type: "Feature", properties: p, geometry: { type: "LineString",
      coordinates: keep.map(j => [+g[j].lon.toFixed(5), +g[j].lat.toFixed(5)]) } });
  });

  return { roads: out, sources: { provider: osm.provider, landcover: !!nature, elevation: !!elev, buildings: osm.buildings.length, buildingSource: osm.buildingSource } };
}
