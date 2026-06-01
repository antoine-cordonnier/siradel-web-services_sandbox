/* Leaflet map view — manages basemaps, markers (draggable), and simulated links. */

const SEATTLE = [47.6062, -122.3321];

const BASEMAPS = {
  plan: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    opts: { subdomains: 'abcd', maxZoom: 20 },
  },
  sat: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    opts: { maxZoom: 19 },
  },
};

/* Color ramp stops — duplicated here so module-level functions are self-contained */
const _STOPS = [
  { v: -120, c: [229, 72, 77]  },
  { v: -105, c: [255, 122, 66] },
  { v:  -90, c: [245, 200, 30] },
  { v:  -78, c: [150, 210, 60] },
  { v:  -60, c: [48,  209, 88] },
];

// Returns null if v < cMin (→ transparent), rgb array otherwise
function _powerColorRGB(v, cMin, cMax) {
  if (v < cMin) return null;   // below threshold → transparent
  const normalized = -120 + (v - cMin) / (cMax - cMin) * 60;
  const x = Math.max(-120, Math.min(-60, normalized));
  for (let i = 0; i < _STOPS.length - 1; i++) {
    const a = _STOPS[i], b = _STOPS[i + 1];
    if (x >= a.v && x <= b.v) {
      const t = (x - a.v) / (b.v - a.v);
      return a.c.map((ca, k) => Math.round(ca + (b.c[k] - ca) * t));
    }
  }
  return [48, 209, 88];
}


/* Resolve the GeoTIFF library from globalThis (set by local geotiff.browser.js) */
function getGeoTIFF() {
  const lib = window.GeoTIFF;
  if (lib && lib.fromArrayBuffer) return lib;
  throw new Error('GeoTIFF.js not available — check that geotiff.browser.js is loaded');
}

/* GeoTIFF → canvas → Leaflet overlay, with CRS reprojection via proj4 */
async function renderCoverageTif(buffer, map, overlayRef, bandRef, colorMin, colorMax) {
  const lib = getGeoTIFF();

  const tiff  = await lib.fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  const bbox  = image.getBoundingBox();  // [xmin, ymin, xmax, ymax] in native CRS
  const W     = image.getWidth();
  const H     = image.getHeight();

  // Detect EPSG from GeoKeys
  const geoKeys = image.getGeoKeys();
  const epsg = geoKeys.ProjectedCSTypeGeoKey      // projected CRS
            || geoKeys.GeographicTypeGeoKey        // geographic CRS
            || 4326;
  console.log('[Coverage] TIF EPSG:', epsg, 'bbox:', bbox, 'size:', W, 'x', H);

  // Build proj4 reprojection function (native CRS → WGS84)
  let toWGS84 = (x, y) => ({ x, y }); // identity fallback
  if (epsg !== 4326 && window.proj4) {
    const srcDef = `EPSG:${epsg}`;
    try {
      // proj4 knows common EPSG codes out of the box
      toWGS84 = (x, y) => {
        const [lon, lat] = proj4(srcDef, 'EPSG:4326', [x, y]);
        return { x: lon, y: lat };
      };
      // Test it works
      toWGS84(bbox[0], bbox[1]);
    } catch(e) {
      console.warn('[Coverage] proj4 reprojection failed for EPSG:' + epsg + ', trying +proj=utm', e.message);
      // Fallback: build UTM string from EPSG code
      // EPSG 326xx = UTM zone xx North, 327xx = UTM zone xx South
      const zone = epsg % 100;
      const south = epsg >= 32700 && epsg < 32800;
      const utmDef = `+proj=utm +zone=${zone}${south ? ' +south' : ''} +datum=WGS84`;
      try {
        toWGS84 = (x, y) => {
          const [lon, lat] = proj4(utmDef, 'EPSG:4326', [x, y]);
          return { x: lon, y: lat };
        };
        toWGS84(bbox[0], bbox[1]);
      } catch(e2) {
        console.error('[Coverage] Fallback reprojection also failed:', e2.message);
      }
    }
  }

  // Convert bbox corners to WGS84
  const sw = toWGS84(bbox[0], bbox[1]);
  const ne = toWGS84(bbox[2], bbox[3]);
  const bounds = [[sw.y, sw.x], [ne.y, ne.x]];
  console.log('[Coverage] WGS84 bounds:', bounds);

  // Read raster
  const rasters = await image.readRasters({ interleave: false });
  const band = rasters[0];

  let nodata = null;
  try { nodata = image.getGDALNoData(); } catch(e) {}

  const clean = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const v = band[i];
    clean[i] = (nodata !== null && v === nodata) ? -Infinity : v;
  }

  const bboxWGS84 = [sw.x, sw.y, ne.x, ne.y];
  // Store parsed band for live re-rendering on color scale change
  if (bandRef) bandRef.current = { band: clean, W, H, bboxWGS84 };

  // Initial render with current color scale
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const v = clean[i];
    if (!isFinite(v) || v < -500) { img.data[i*4+3] = 0; continue; }
    const rgb = _powerColorRGB(v, colorMin, colorMax);
    if (!rgb) { img.data[i*4+3] = 0; continue; }  // below colorMin → transparent
    img.data[i*4]=rgb[0]; img.data[i*4+1]=rgb[1]; img.data[i*4+2]=rgb[2]; img.data[i*4+3]=200;
  }
  ctx.putImageData(img, 0, 0);

  if (overlayRef.current) { map.removeLayer(overlayRef.current); }
  overlayRef.current = L.imageOverlay(canvas.toDataURL('image/png'), bounds,
    { opacity: 0.75, interactive: false, zIndex: 300 }).addTo(map);
  map.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
  console.log('[Coverage] overlay added, bounds:', bounds);
}

function MapView({ transmitters, receivers, links, basemap, mode, onAddPoint, onMoveMarker, onSelect, onDelete, selectedId, mapApiRef, linkWeight = 2, linkGlow = true, coverageTif = null, coverageVisible = true, colorMin = POWER_MIN, colorMax = POWER_MAX }) {
  const elRef = React.useRef(null);
  const mapRef = React.useRef(null);
  const coverageOverlayRef = React.useRef(null);
  const coverageBandRef = React.useRef(null);
  const [ctxMenu, setCtxMenu] = React.useState(null); // { x, y, id }
  const tileRef = React.useRef(null);
  const markerLayer = React.useRef(null);
  const linkLayer = React.useRef(null);
  const markersById = React.useRef({});
  // keep latest mode/handlers without re-binding map click
  const modeRef = React.useRef(mode);
  modeRef.current = mode;
  const addRef = React.useRef(onAddPoint);
  addRef.current = onAddPoint;

  // init once
  React.useEffect(() => {
    const map = L.map(elRef.current, { zoomControl: false, attributionControl: false }).setView(SEATTLE, 11);
    mapRef.current = map;
    markerLayer.current = L.layerGroup().addTo(map);
    linkLayer.current = L.layerGroup().addTo(map);
    map.on('click', (e) => {
      if (modeRef.current === 'tx' || modeRef.current === 'rx') {
        addRef.current(modeRef.current, e.latlng.lat, e.latlng.lng);
      }
    });
    if (mapApiRef) mapApiRef.current = map;
    setTimeout(() => map.invalidateSize(), 80);
    return () => map.remove();
  }, []);

  // basemap
  React.useEffect(() => {
    if (!mapRef.current) return;
    if (tileRef.current) mapRef.current.removeLayer(tileRef.current);
    const b = BASEMAPS[basemap];
    tileRef.current = L.tileLayer(b.url, b.opts).addTo(mapRef.current);
    tileRef.current.bringToBack();
  }, [basemap]);

  // crosshair cursor
  React.useEffect(() => {
    if (!elRef.current) return;
    elRef.current.closest('.map-region')?.classList.toggle('placing', mode === 'tx' || mode === 'rx');
  }, [mode]);

  // markers
  React.useEffect(() => {
    const layer = markerLayer.current;
    if (!layer) return;
    layer.clearLayers();
    markersById.current = {};
    const build = (list, kind) => {
      const color = kind === 'tx' ? getCSS('--tx') : getCSS('--rx');
      list.forEach((d) => {
        const sel = selectedId === d.id;
        const html = `<div style="position:relative">${markerSVG(kind, color)}<span class="mlabel" style="${sel ? 'border-color:' + color : ''}">${d.name || ''}</span></div>`;
        const icon = L.divIcon({ className: 'marker', html, iconSize: [30, 30], iconAnchor: [15, 15] });
        const m = L.marker([d.lat, d.lon], { icon, draggable: true }).addTo(layer);
        m.on('dragend', (e) => { const ll = e.target.getLatLng(); onMoveMarker(d.id, ll.lat, ll.lng); });
        m.on('click', (e) => { L.DomEvent.stopPropagation(e); onSelect(d.id); setCtxMenu(null); });
        // Listen on the DOM element directly — more reliable than Leaflet's contextmenu event on divIcon
        m.on('add', () => {
          const el = m.getElement();
          if (!el) return;
          el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const rect = elRef.current.getBoundingClientRect();
            setCtxMenu({ x: e.clientX - rect.left, y: e.clientY - rect.top, id: d.id });
          });
        });
        markersById.current[d.id] = m;
      });
    };
    build(transmitters, 'tx');
    build(receivers, 'rx');
  }, [transmitters, receivers, selectedId]);

  // links
  React.useEffect(() => {
    const layer = linkLayer.current;
    if (!layer) return;
    layer.clearLayers();
    const txById = Object.fromEntries(transmitters.map((t) => [t.id, t]));
    const rxById = Object.fromEntries(receivers.map((r) => [r.id, r]));
    links.forEach((lk) => {
      const tx = txById[lk.txId], rx = rxById[lk.rxId];
      if (!tx || !rx) return;
      const belowMin = lk.receivedPower < colorMin;
      const col = belowMin ? '#222222' : powerColor(lk.receivedPower);
      const opacity = belowMin ? 0.5 : 0.92;
      if (linkGlow && !belowMin) L.polyline([[tx.lat, tx.lon], [rx.lat, rx.lon]], { color: col, weight: linkWeight + 5, opacity: 0.16, lineCap: 'round' }).addTo(layer);
      const line = L.polyline([[tx.lat, tx.lon], [rx.lat, rx.lon]], { color: col, weight: linkWeight, opacity }).addTo(layer);
      line.bindTooltip(
        `<div class="tip"><b>${tx.name} → ${rx.name}</b><br/>RX <b>${lk.receivedPower} dBm</b> · ${qualityLabel(lk.receivedPower)}<br/>${lk.distanceKm.toFixed(2)} km · loss ${lk.pathLoss} dB</div>`,
        { sticky: true, className: 'rf-tip' }
      );
    });
  }, [links, transmitters, receivers, linkWeight, linkGlow, colorMin, colorMax]);

  // Re-render coverage canvas from stored band when color scale changes
  function applyColorToBand() {
    const map = mapRef.current;
    const stored = coverageBandRef.current;
    if (!map || !stored) return;
    if (coverageOverlayRef.current) { map.removeLayer(coverageOverlayRef.current); }
    const { band, W, H, bboxWGS84 } = stored;

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(W, H);
    for (let i = 0; i < W * H; i++) {
      const v = band[i];
      if (!isFinite(v) || v < -500) { img.data[i*4+3] = 0; continue; }
      const rgb = _powerColorRGB(v, colorMin, colorMax);
      if (!rgb) { img.data[i*4+3] = 0; continue; }  // below colorMin → transparent
      img.data[i*4]=rgb[0]; img.data[i*4+1]=rgb[1]; img.data[i*4+2]=rgb[2]; img.data[i*4+3]=200;
    }
    ctx.putImageData(img, 0, 0);
    const bounds = [[bboxWGS84[1], bboxWGS84[0]], [bboxWGS84[3], bboxWGS84[2]]];
    coverageOverlayRef.current = L.imageOverlay(canvas.toDataURL('image/png'), bounds,
      { opacity: 0.75, interactive: false, zIndex: 300 }).addTo(map);
  }

  // Coverage overlay — parse TIF (once) then render; re-render on color change
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (coverageOverlayRef.current) { map.removeLayer(coverageOverlayRef.current); coverageOverlayRef.current = null; }
    if (!coverageTif) { coverageBandRef.current = null; return; }

    if (coverageTif.isMock) {
      coverageBandRef.current = { band: coverageTif.band, W: coverageTif.width, H: coverageTif.height, bboxWGS84: coverageTif.bbox };
      applyColorToBand();
      if (coverageOverlayRef.current) map.fitBounds(coverageOverlayRef.current.getBounds(), { padding: [40,40], maxZoom: 13 });
    } else if (coverageTif.buffer) {
      renderCoverageTif(coverageTif.buffer, map, coverageOverlayRef, coverageBandRef, colorMin, colorMax)
        .catch((e) => console.error('[Coverage] GeoTIFF render error:', e));
    }
  }, [coverageTif]);

  // Re-render when color scale changes (band already parsed)
  React.useEffect(() => { applyColorToBand(); }, [colorMin, colorMax]);

  // Show/hide coverage overlay
  React.useEffect(() => {
    if (!coverageOverlayRef.current) return;
    if (coverageVisible) coverageOverlayRef.current.addTo(mapRef.current);
    else mapRef.current.removeLayer(coverageOverlayRef.current);
  }, [coverageVisible]);


  // Close context menu when clicking the map
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const close = () => setCtxMenu(null);
    map.on('click', close);
    return () => map.off('click', close);
  }, []);

  return (
    <div id="map" ref={elRef} style={{ position: 'relative' }}>
      {ctxMenu && (
        <div
          style={{ position: 'absolute', left: ctxMenu.x, top: ctxMenu.y, zIndex: 2000 }}
          onMouseLeave={() => setCtxMenu(null)}
        >
          <div className="map-ctx-menu">
            <button onClick={() => { onDelete && onDelete(ctxMenu.id); setCtxMenu(null); }}>
              <Icon name="trash" size={13} /> Supprimer
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function getCSS(v) {
  return getComputedStyle(document.documentElement).getPropertyValue(v).trim() || '#fff';
}

window.MapView = MapView;
