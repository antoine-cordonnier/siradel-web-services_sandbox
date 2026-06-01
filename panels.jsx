/* UI panels: parameters, entity tables, results, log, legend, toolbars. */

/* ═══════════════════════════════════════════════════════════════
   EXPORT HELPERS
═══════════════════════════════════════════════════════════════ */
function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

function toCSV(rows, cols) {
  const header = cols.map((c) => `"${c.label}"`).join(',');
  const lines  = rows.map((r) => cols.map((c) => {
    const v = r[c.key] ?? '';
    return typeof v === 'number' ? v : `"${String(v).replace(/"/g, '""')}"`;
  }).join(','));
  return [header, ...lines].join('\n');
}

function pointsGeoJSON(list, props) {
  return JSON.stringify({
    type: 'FeatureCollection',
    features: list.map((e) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [e.lon, e.lat] },
      properties: props(e),
    })),
  }, null, 2);
}

function linksGeoJSON(links, txById, rxById) {
  return JSON.stringify({
    type: 'FeatureCollection',
    features: links.filter((lk) => txById[lk.txId] && rxById[lk.rxId]).map((lk) => {
      const tx = txById[lk.txId], rx = rxById[lk.rxId];
      return {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[tx.lon, tx.lat], [rx.lon, rx.lat]] },
        properties: {
          tx: tx.name, rx: rx.name,
          receivedPower: lk.receivedPower,
          distanceKm: lk.distanceKm,
          pathLoss: lk.pathLoss,
          quality: qualityLabel(lk.receivedPower),
        },
      };
    }),
  }, null, 2);
}

/* ═══════════════════════════════════════════════════════════════
   EXPORT BUTTON
═══════════════════════════════════════════════════════════════ */
function ExportMenu({ onCSV, onGeoJSON }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!open) return;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="btn ghost sm" onClick={() => setOpen(!open)}>
        <Icon name="download" size={13} /> Export
      </button>
      {open && (
        <div className="export-menu">
          {onCSV     && <button onClick={() => { onCSV();     setOpen(false); }}>CSV</button>}
          {onGeoJSON && <button onClick={() => { onGeoJSON(); setOpen(false); }}>GeoJSON</button>}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   IMPORT HELPERS
═══════════════════════════════════════════════════════════════ */
function parseCSVImport(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
  // detect and skip header if first row has non-numeric 2nd cell
  const rows = lines.map((l) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, '')));
  if (rows.length && isNaN(parseFloat(rows[0][1]))) rows.shift();
  const KEYS = ['name', 'lat', 'lon', 'height', 'power', 'azimuth', 'tilt'];
  return rows.map((cells) => {
    const o = {};
    KEYS.forEach((k, i) => {
      if (cells[i] !== undefined && cells[i] !== '') {
        o[k] = k === 'name' ? cells[i] : parseFloat(cells[i]);
      }
    });
    return o;
  }).filter((o) => !isNaN(o.lat) && !isNaN(o.lon));
}

function parseGeoJSONImport(text) {
  const fc = JSON.parse(text);
  const features = fc.type === 'FeatureCollection' ? fc.features
    : fc.type === 'Feature' ? [fc] : [];
  return features
    .filter((f) => f.geometry?.type === 'Point')
    .map((f) => {
      const [lon, lat] = f.geometry.coordinates;
      const p = f.properties || {};
      return {
        name:    p.name    || p.Name    || p.id   || '',
        lat:     parseFloat(p.lat  ?? p.latitude  ?? lat),
        lon:     parseFloat(p.lon  ?? p.longitude ?? lon),
        height:  parseFloat(p.height  ?? p.h    ?? p.Height  ?? 0)  || 0,
        power:   parseFloat(p.power   ?? p.p    ?? p.Power   ?? '') || '',
        azimuth: parseFloat(p.azimuth ?? p.az   ?? p.Azimuth ?? 0)  || 0,
        tilt:    parseFloat(p.tilt    ?? p.Tilt  ?? 0) || 0,
      };
    })
    .filter((o) => !isNaN(o.lat) && !isNaN(o.lon));
}

function ImportButton({ onImport }) {
  const ref = React.useRef(null);

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';               // reset so same file can be re-selected
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result;
      try {
        let entities;
        if (file.name.endsWith('.geojson') || file.name.endsWith('.json')) {
          entities = parseGeoJSONImport(text);
        } else {
          entities = parseCSVImport(text);
        }
        if (!entities.length) { alert('No valid rows found in file.'); return; }
        onImport(entities, file.name);
      } catch (err) {
        alert('Import error: ' + err.message);
      }
    };
    reader.readAsText(file);
  };

  return (
    <>
      <button className="btn ghost sm" onClick={() => ref.current.click()}>
        <Icon name="layers" size={13} /> Import
      </button>
      <input ref={ref} type="file" accept=".csv,.geojson,.json" style={{ display: 'none' }} onChange={handleFile} />
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════
   ENTITY TABLE (TX / RX)
═══════════════════════════════════════════════════════════════ */
const COLS = [
  { key: 'name',    label: 'Name',     w: 'auto', type: 'text' },
  { key: 'lat',     label: 'Lat',      w: 78,  type: 'num', d: 5 },
  { key: 'lon',     label: 'Lon',      w: 82,  type: 'num', d: 5 },
  { key: 'height',  label: 'H (m)',    w: 52,  type: 'num', d: 0 },
  { key: 'power',   label: 'P (dBm)',  w: 60,  type: 'num', d: 0 },
  { key: 'azimuth', label: 'Az (°)',   w: 52,  type: 'num', d: 0 },
  { key: 'tilt',    label: 'Tilt (°)', w: 52,  type: 'num', d: 0 },
];
const TX_CSV_COLS = COLS.map((c) => ({ key: c.key, label: c.label }));

function parseClipboard(text) {
  const rows = text.replace(/\r/g, '').split('\n').filter((r) => r.trim() !== '');
  const parsed = rows.map((r) => r.split('\t').length > 1 ? r.split('\t') : r.split(/ {2,}|;|,(?=\s*-?\d)/));
  if (parsed.length && parsed[0].length >= 3 && isNaN(parseFloat(parsed[0][1]))) parsed.shift();
  return parsed;
}

function EntityTable({ kind, rows, onEdit, onDelete, onBulkAdd, selectedId, onSelect }) {
  const tag = kind === 'tx' ? 'var(--tx)' : 'var(--rx)';

  const handleExportCSV = () => downloadBlob(toCSV(rows, TX_CSV_COLS), `${kind}.csv`, 'text/csv');
  const handleExportGeoJSON = () => downloadBlob(
    pointsGeoJSON(rows, (e) => ({
      name: e.name, height: e.height, power: e.power, azimuth: e.azimuth, tilt: e.tilt,
    })),
    `${kind}.geojson`, 'application/json'
  );

  const handlePaste = (e) => {
    const text = e.clipboardData.getData('text');
    if (!text || (text.indexOf('\t') === -1 && text.indexOf('\n') === -1)) return;
    e.preventDefault();
    const parsed = parseClipboard(text);
    const entities = parsed.map((cells, i) => {
      const o = {};
      ['name', 'lat', 'lon', 'height', 'power', 'azimuth', 'tilt'].forEach((k, idx) => {
        if (cells[idx] !== undefined && cells[idx] !== '') o[k] = k === 'name' ? cells[idx].trim() : parseFloat(cells[idx]);
      });
      if (!o.name) o.name = `${kind === 'tx' ? 'TX' : 'RX'}-${i + 1}`;
      return o;
    }).filter((o) => !isNaN(o.lat) && !isNaN(o.lon));
    if (entities.length) onBulkAdd(entities);
  };

  const handleImport = (entities, filename) => {
    onBulkAdd(entities);
  };

  return (
    <div className="tbl-wrap" onPaste={handlePaste}>
      <div className="tbl-toolbar">
        <ImportButton onImport={handleImport} />
        <ExportMenu onCSV={rows.length ? handleExportCSV : null} onGeoJSON={rows.length ? handleExportGeoJSON : null} />
      </div>
      <table className="grid">
        <thead>
          <tr>
            {COLS.map((c) => <th key={c.key} style={c.w === 'auto' ? null : { width: c.w }}>{c.label}</th>)}
            <th style={{ width: 24 }}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={selectedId === r.id ? 'selected' : ''} onMouseDown={() => onSelect(r.id)}>
              {COLS.map((c) => (
                <td key={c.key}>
                  {c.key === 'name' ? (
                    <div className="tbl-name-cell">
                      <span className="tbl-tag" style={{ background: tag }}></span>
                      <input value={r.name ?? ''} onChange={(e) => onEdit(r.id, 'name', e.target.value)} />
                    </div>
                  ) : (
                    <input className="tnum" value={r[c.key] ?? ''} onChange={(e) => onEdit(r.id, c.key, e.target.value)} style={{ textAlign: 'right' }} />
                  )}
                </td>
              ))}
              <td><button className="row-del" title="Delete" onClick={() => onDelete(r.id)}><Icon name="trash" size={13} /></button></td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={COLS.length + 1}>
              <div className="paste-hint">
                <Icon name="table" size={14} color="var(--text-2)" />
                Click map to place, or paste rows from Excel (Name, Lat, Lon, H, P, Az, Tilt).
              </div>
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   RESULTS TABLE VIEW
═══════════════════════════════════════════════════════════════ */
const LINK_CSV_COLS = [
  { key: 'txName',        label: 'TX' },
  { key: 'rxName',        label: 'RX' },
  { key: 'distanceKm',    label: 'Distance (km)' },
  { key: 'receivedPower', label: 'Power (dBm)' },
  { key: 'pathLoss',      label: 'Path Loss (dB)' },
  { key: 'quality',       label: 'Quality' },
];

function ResultsTableView({ links, txById, rxById }) {
  const rows = links.map((lk) => ({
    txName:        txById[lk.txId]?.name ?? lk.txId,
    rxName:        rxById[lk.rxId]?.name ?? lk.rxId,
    distanceKm:    lk.distanceKm,
    receivedPower: lk.receivedPower,
    pathLoss:      lk.pathLoss,
    quality:       qualityLabel(lk.receivedPower),
  }));

  if (!rows.length) return (
    <div className="paste-hint" style={{ padding: '20px 14px' }}>
      <Icon name="radio" size={14} color="var(--text-2)" /> Run a simulation to see results here.
    </div>
  );

  return (
    <div className="tbl-wrap">
      <table className="grid">
        <thead>
          <tr>
            <th>TX</th><th>RX</th>
            <th style={{ width: 76 }}>Dist (km)</th>
            <th style={{ width: 76 }}>Power</th>
            <th style={{ width: 76 }}>Quality</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td><div style={{ padding: '5px 9px', color: 'var(--tx)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{r.txName}</div></td>
              <td><div style={{ padding: '5px 9px', color: 'var(--rx)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{r.rxName}</div></td>
              <td><div style={{ padding: '5px 9px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{r.distanceKm?.toFixed(2) ?? '—'}</div></td>
              <td><div style={{ padding: '5px 9px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 11, color: powerColor(r.receivedPower) }}>{r.receivedPower?.toFixed(1) ?? '—'}</div></td>
              <td><div style={{ padding: '5px 9px', fontSize: 11 }}>{r.quality}</div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   RESULTS CHART VIEW
═══════════════════════════════════════════════════════════════ */
function ResultsChartView({ links, threshold }) {
  if (!links.length) return (
    <div className="paste-hint" style={{ padding: '20px 14px' }}>
      <Icon name="radio" size={14} color="var(--text-2)" /> Run a simulation to see the chart.
    </div>
  );

  const valid   = links.filter((l) => l.receivedPower != null);
  const covered = valid.filter((l) => l.receivedPower >= threshold);
  const pct     = valid.length ? Math.round((covered.length / valid.length) * 100) : 0;

  // Bins: every 5 dB from -120 to -60
  const BIN_W = 5;
  const bins = [];
  for (let v = POWER_MIN; v < POWER_MAX; v += BIN_W) {
    bins.push({ lo: v, hi: v + BIN_W, count: 0 });
  }
  valid.forEach((l) => {
    const idx = Math.min(bins.length - 1, Math.max(0, Math.floor((l.receivedPower - POWER_MIN) / BIN_W)));
    bins[idx].count++;
  });
  const maxCount = Math.max(1, ...bins.map((b) => b.count));

  const W = 260, H = 90, PL = 28, PR = 8, PT = 6, PB = 20;
  const chartW = W - PL - PR, chartH = H - PT - PB;
  const bw = chartW / bins.length;

  return (
    <div style={{ padding: '14px 16px' }}>
      {/* Coverage stat */}
      <div className="coverage-stat">
        <div className="cov-big" style={{ color: pct >= 80 ? 'var(--accent)' : pct >= 50 ? 'var(--warn)' : 'var(--danger)' }}>
          {pct}<span style={{ fontSize: 18, fontWeight: 500 }}>%</span>
        </div>
        <div className="cov-label">covered links<br/><span style={{ color: 'var(--text-2)' }}>≥ {threshold} dBm</span></div>
        <div className="cov-detail">
          <div><span className="dim">Covered</span> {covered.length} / {valid.length}</div>
          {valid.length > 0 && <>
            <div><span className="dim">Best</span> {Math.max(...valid.map(l=>l.receivedPower)).toFixed(1)} dBm</div>
            <div><span className="dim">Worst</span> {Math.min(...valid.map(l=>l.receivedPower)).toFixed(1)} dBm</div>
            <div><span className="dim">Mean</span> {(valid.reduce((s,l)=>s+l.receivedPower,0)/valid.length).toFixed(1)} dBm</div>
          </>}
        </div>
      </div>

      {/* Histogram */}
      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 9.5, color: 'var(--text-2)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6 }}>
          Received Power Distribution
        </div>
        <svg width={W} height={H} style={{ overflow: 'visible' }}>
          {/* Y axis */}
          <line x1={PL} y1={PT} x2={PL} y2={PT + chartH} stroke="var(--border)" strokeWidth={1} />
          {/* X axis */}
          <line x1={PL} y1={PT + chartH} x2={PL + chartW} y2={PT + chartH} stroke="var(--border)" strokeWidth={1} />
          {/* Threshold line */}
          {(() => {
            const tx = PL + ((threshold - POWER_MIN) / (POWER_MAX - POWER_MIN)) * chartW;
            return tx >= PL && tx <= PL + chartW ? (
              <g>
                <line x1={tx} y1={PT} x2={tx} y2={PT + chartH} stroke="var(--warn)" strokeWidth={1} strokeDasharray="3,2" />
                <text x={tx + 2} y={PT + 9} fill="var(--warn)" fontSize={8}>{threshold}</text>
              </g>
            ) : null;
          })()}
          {/* Bars */}
          {bins.map((b, i) => {
            const barH = (b.count / maxCount) * chartH;
            const x    = PL + i * bw;
            const mid  = (b.lo + b.hi) / 2;
            const col  = powerColor(mid);
            return (
              <g key={i}>
                <rect x={x + 1} y={PT + chartH - barH} width={bw - 1} height={barH} fill={col} opacity={0.8} />
                {b.count > 0 && barH > 12 && (
                  <text x={x + bw / 2} y={PT + chartH - barH + 9} textAnchor="middle" fill="#fff" fontSize={8} opacity={0.9}>{b.count}</text>
                )}
              </g>
            );
          })}
          {/* X labels */}
          {[POWER_MIN, -100, -80, POWER_MAX].map((v) => {
            const x = PL + ((v - POWER_MIN) / (POWER_MAX - POWER_MIN)) * chartW;
            return <text key={v} x={x} y={PT + chartH + 12} textAnchor="middle" fill="var(--text-2)" fontSize={8}>{v}</text>;
          })}
          {/* Y label */}
          <text x={PL - 4} y={PT + chartH / 2} textAnchor="middle" fill="var(--text-2)" fontSize={8} transform={`rotate(-90, ${PL - 14}, ${PT + chartH / 2})`}>links</text>
        </svg>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   RESULTS PANEL (tab with table/chart toggle + export)
═══════════════════════════════════════════════════════════════ */
function ResultsPanel({ links, transmitters, receivers, threshold }) {
  const [view, setView] = React.useState('table');

  const txById = React.useMemo(() => Object.fromEntries(transmitters.map((t) => [t.id, t])), [transmitters]);
  const rxById = React.useMemo(() => Object.fromEntries(receivers.map((r) => [r.id, r])), [receivers]);

  const handleExportCSV = () => {
    const rows = links.map((lk) => ({
      txName:        txById[lk.txId]?.name ?? lk.txId,
      rxName:        rxById[lk.rxId]?.name ?? lk.rxId,
      distanceKm:    lk.distanceKm,
      receivedPower: lk.receivedPower,
      pathLoss:      lk.pathLoss,
      quality:       qualityLabel(lk.receivedPower),
    }));
    downloadBlob(toCSV(rows, LINK_CSV_COLS), 'results.csv', 'text/csv');
  };

  const handleExportGeoJSON = () => {
    downloadBlob(linksGeoJSON(links, txById, rxById), 'results.geojson', 'application/json');
  };

  return (
    <div className="panel" style={{ height: '100%' }}>
      <div className="panel-head">
        <div className="tabs">
          <button className={view === 'table' ? 'active' : ''} onClick={() => setView('table')}>
            <Icon name="table" size={13} /> Table
          </button>
          <button className={view === 'chart' ? 'active' : ''} onClick={() => setView('chart')}>
            <Icon name="bolt" size={13} /> Chart
          </button>
        </div>
        <div className="sp"></div>
        <span className="count">{links.length} links</span>
        {links.length > 0 && (
          <ExportMenu onCSV={handleExportCSV} onGeoJSON={handleExportGeoJSON} />
        )}
      </div>
      <div className="panel-body" style={{ padding: 0 }}>
        {view === 'table'
          ? <ResultsTableView links={links} txById={txById} rxById={rxById} />
          : <ResultsChartView links={links} threshold={threshold} />}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   PARAMETERS PANEL
═══════════════════════════════════════════════════════════════ */
function ParametersPanel({ p, setP, models, antennas, discovering, onDiscover }) {
  return (
    <div style={{ padding: '14px 15px' }}>
      <div className="field">
        <label>Frequency</label>
        <div className="slider-row">
          <input type="range" min="100" max="10000" step="10" value={p.frequency}
            onChange={(e) => setP({ ...p, frequency: +e.target.value })} />
          <span className="slider-val">{p.frequency >= 1000 ? (p.frequency / 1000).toFixed(2) + ' GHz' : p.frequency + ' MHz'}</span>
        </div>
      </div>

      <div className="field">
        <label style={{ display: 'flex', justifyContent: 'space-between', whiteSpace: 'nowrap' }}>
          <span>Model</span>
          {discovering && <span className="dim" style={{ textTransform: 'none', letterSpacing: 0 }}>discovering…</span>}
        </label>
        <select className="control" value={p.model} onChange={(e) => setP({ ...p, model: e.target.value })} disabled={!models.length}>
          {!models.length && <option>— discover from API —</option>}
          {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </div>

      <div className="field">
        <label>Antenna</label>
        <select className="control" value={p.antenna} onChange={(e) => setP({ ...p, antenna: e.target.value })} disabled={!antennas.length}>
          {!antennas.length && <option>— discover from API —</option>}
          {antennas.map((a) => <option key={a.id} value={a.id}>{a.name}{a.gain != null ? `  ·  ${a.gain} dBi` : ''}</option>)}
        </select>
      </div>

      <div className="field">
        <label>Default TX Power</label>
        <div className="slider-row">
          <input type="range" min="0" max="60" step="1" value={p.txPower}
            onChange={(e) => setP({ ...p, txPower: +e.target.value })} />
          <span className="slider-val">{p.txPower} dBm</span>
        </div>
      </div>

      <div className="field">
        <label>Color Scale Min</label>
        <div className="slider-row">
          <input type="range" min="-200" max="-40" step="1" value={p.colorMin}
            onChange={(e) => setP({ ...p, colorMin: +e.target.value })} />
          <span className="slider-val">{p.colorMin} dBm</span>
        </div>
      </div>

      <div className="field">
        <label>Color Scale Max</label>
        <div className="slider-row">
          <input type="range" min="-200" max="-40" step="1" value={p.colorMax}
            onChange={(e) => setP({ ...p, colorMax: +e.target.value })} />
          <span className="slider-val">{p.colorMax} dBm</span>
        </div>
      </div>

      <div className="field">
        <label>Coverage Threshold</label>
        <div className="slider-row">
          <input type="range" min="-120" max="-60" step="1" value={p.threshold}
            onChange={(e) => setP({ ...p, threshold: +e.target.value })} />
          <span className="slider-val">{p.threshold} dBm</span>
        </div>
      </div>

      <div className="field">
        <label>Coverage Radius</label>
        <div className="slider-row">
          <input type="range" min="500" max="30000" step="500" value={p.coverageRadius}
            onChange={(e) => setP({ ...p, coverageRadius: +e.target.value })} />
          <span className="slider-val">
            {p.coverageRadius >= 1000 ? (p.coverageRadius / 1000).toFixed(1) + ' km' : p.coverageRadius + ' m'}
          </span>
        </div>
      </div>

      <button className="btn ghost sm" style={{ width: '100%', marginTop: 2 }} onClick={onDiscover} disabled={discovering}>
        <Icon name="refresh" size={13} /> {models.length ? 'Re-sync catalogs from API' : 'Discover models & antennas'}
      </button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   LOG CONSOLE
═══════════════════════════════════════════════════════════════ */
function LogConsole({ logs, bodyRef }) {
  return (
    <div className="log-body panel-body" ref={bodyRef}>
      {logs.length === 0 && <div className="log-line"><span className="msg dim">› ready. waiting for input…</span></div>}
      {logs.map((l, i) => (
        <div key={i} className={`log-line lv-${l.level}`}>
          <span className="ts">{l.ts}</span>
          <span className="msg">{l.msg}</span>
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   LEGEND + MAP TOOLBARS
═══════════════════════════════════════════════════════════════ */
function Legend({ colorMin = POWER_MIN, colorMax = POWER_MAX }) {
  const mid = Math.round((colorMin + colorMax) / 2);
  return (
    <div className="legend">
      <div className="lg-title">Received Power · dBm</div>
      <div className="lg-bar" style={{ background: POWER_GRADIENT_CSS }}></div>
      <div className="lg-scale">
        <span>{colorMin}</span><span>{mid}</span><span>{colorMax}</span>
      </div>
    </div>
  );
}

function MapToolbar({ mode, setMode, basemap, setBasemap }) {
  return (
    <div className="map-toolbar">
      <button className={`tool ${mode === 'pan' ? 'active' : ''}`} onClick={() => setMode('pan')}>
        <Icon name="pan" size={15} /> Pan
      </button>
      <div className="divider"></div>
      <button className={`tool tx ${mode === 'tx' ? 'active' : ''}`} onClick={() => setMode('tx')}>
        <Icon name="tx" size={15} /> Add TX
      </button>
      <button className={`tool rx ${mode === 'rx' ? 'active' : ''}`} onClick={() => setMode('rx')}>
        <Icon name="rx" size={15} /> Add RX
      </button>
      <div className="divider"></div>
      <button className={`tool ${basemap === 'plan' ? 'active' : ''}`} onClick={() => setBasemap(basemap === 'plan' ? 'sat' : 'plan')} title="Toggle satellite/plan">
        <Icon name="layers" size={15} /> {basemap === 'plan' ? 'Satellite' : 'Plan'}
      </button>
    </div>
  );
}

function LayerTree({ coverageVisible, onToggleCoverage, links }) {
  return (
    <div className="layer-tree">
      <div className="layer-tree-title"><Icon name="layers" size={12} color="var(--accent)" /> Layers</div>
      <label className="layer-item">
        <input type="checkbox" checked={coverageVisible} onChange={(e) => onToggleCoverage(e.target.checked)} />
        <span className="layer-color" style={{ background: 'linear-gradient(90deg,#e5484d,#f5c81e,#30d158)' }}></span>
        Coverage
      </label>
      {links.length > 0 && (
        <label className="layer-item">
          <input type="checkbox" checked={true} readOnly />
          <span className="layer-color" style={{ background: 'linear-gradient(90deg,#e5484d,#30d158)' }}></span>
          P2P Links ({links.length})
        </label>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   BUY TOKENS MODAL  (Paddle.js)
═══════════════════════════════════════════════════════════════ */
function BuyTokensModal({ onClose }) {
  const cfg      = window.PADDLE_CONFIG || {};
  const prices   = (cfg.prices || []).filter(p => p.id && !p.id.startsWith('pri_xxx'));
  const isLive   = cfg.environment === 'production';
  const initialized = cfg._initialized === true;
  const initError   = cfg._error;
  const [busy, setBusy]       = React.useState(null);
  const [success, setSuccess] = React.useState(null);

  // Listen for Paddle purchase completion
  React.useEffect(() => {
    const handler = (e) => setSuccess(e.detail);
    window.addEventListener('paddle:purchase', handler);
    return () => window.removeEventListener('paddle:purchase', handler);
  }, []);

  const buy = (priceId) => {
    if (!window.Paddle) { alert('Paddle.js not loaded.'); return; }
    setBusy(priceId);
    console.log('[Paddle] opening checkout for price:', priceId);
    try {
      Paddle.Checkout.open({
        items: [{ priceId: priceId, quantity: 1 }],
        settings: {
          displayMode:   'overlay',
          successUrl:    window.location.href,
          theme:         'dark',
        },
      });
    } catch (e) {
      console.error('[Paddle] checkout error:', e);
      alert('Paddle error: ' + e.message);
    }
    setBusy(null);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 2100, background: 'rgba(8,11,17,0.82)', backdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="panel" style={{ width: 480, boxShadow: '0 24px 60px rgba(0,0,0,0.7)' }}>
        <div className="panel-head">
          <Icon name="bolt" size={14} color="var(--accent)" />
          <span className="title">Buy simulation tokens</span>
          <div className="sp"></div>
          {initialized
            ? <span style={{ fontSize: 10, background: 'rgba(52,214,196,0.12)', color: 'var(--accent)', border: '1px solid rgba(52,214,196,0.3)', borderRadius: 4, padding: '2px 7px' }}>
                {isLive ? 'LIVE' : 'SANDBOX'} ✓
              </span>
            : <span style={{ fontSize: 10, background: 'rgba(255,93,93,0.12)', color: 'var(--danger)', border: '1px solid rgba(255,93,93,0.3)', borderRadius: 4, padding: '2px 7px' }}>
                NOT INIT
              </span>
          }
          <button className="btn ghost sm" onClick={onClose} style={{ marginLeft: 8 }}>✕</button>
        </div>

        {success ? (
          <div style={{ padding: '32px 24px', textAlign: 'center' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Purchase complete!</div>
            <div style={{ color: 'var(--text-1)', fontSize: 12, marginBottom: 20 }}>
              Your tokens have been added to your account.<br />
              Order ID: <code style={{ color: 'var(--accent)' }}>{success.transaction_id || '—'}</code>
            </div>
            <button className="btn primary" onClick={onClose}>Close</button>
          </div>
        ) : (
          <div style={{ padding: '20px 20px 24px' }}>
            <p style={{ color: 'var(--text-1)', fontSize: 12.5, marginTop: 0, marginBottom: 20, lineHeight: 1.6 }}>
              Tokens are consumed per simulation. Each point-to-point link costs 1 token.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
              {prices.map((plan) => (
                <div key={plan.id} className={`token-plan${plan.best ? ' best' : ''}`}>
                  {plan.best && <div className="plan-badge">Best value</div>}
                  <div className="plan-tokens">{plan.tokens.toLocaleString()}</div>
                  <div className="plan-label">tokens</div>
                  <div className="plan-price">{plan.price}</div>
                  <button
                    className={`btn${plan.best ? ' primary' : ' ghost'} sm`}
                    style={{ width: '100%', marginTop: 12 }}
                    onClick={() => buy(plan.id)}
                    disabled={busy === plan.id}
                  >
                    {busy === plan.id ? '…' : 'Buy'}
                  </button>
                </div>
              ))}
              {prices.length === 0 && (
                <div style={{ gridColumn: '1/-1', padding: '8px 0' }}>
                  {initError ? (
                    <div style={{ color: 'var(--danger)', fontSize: 11.5, fontFamily: 'var(--font-mono)' }}>
                      Init error: {initError}
                    </div>
                  ) : initialized ? (
                    <div style={{ color: 'var(--text-1)', fontSize: 12, lineHeight: 1.7 }}>
                      <div style={{ color: 'var(--accent)', fontWeight: 600, marginBottom: 8 }}>✓ Paddle SDK initialized (sandbox)</div>
                      <div style={{ color: 'var(--text-2)', fontSize: 11 }}>
                        Pour ajouter des plans d'achat :<br/>
                        1. Crée des <b style={{color:'var(--text-1)'}}>Products</b> dans le <a href="https://sandbox-vendors.paddle.com" target="_blank" style={{color:'var(--accent)'}}>Paddle sandbox dashboard</a><br/>
                        2. Récupère les <b style={{color:'var(--text-1)'}}>Price IDs</b> (format <code style={{color:'var(--accent)'}}>pri_01xxx…</code>)<br/>
                        3. Décommente et remplis <code style={{color:'var(--text-1)'}}>PADDLE_CONFIG.prices</code> dans le HTML
                      </div>
                    </div>
                  ) : (
                    <div style={{ color: 'var(--warn)', fontSize: 11.5 }}>
                      Paddle non initialisé — vérifie la console.
                    </div>
                  )}
                </div>
              )}
            </div>

            <div style={{ padding: '10px 12px', background: 'var(--bg-2)', borderRadius: 'var(--r-md)', fontSize: 10.5, color: 'var(--text-2)', lineHeight: 1.7 }}>
              Payments processed securely by <b style={{ color: 'var(--text-1)' }}>Paddle</b>.{' '}
              {!isLive && <span style={{ color: 'var(--warn)' }}>Sandbox mode — no real charges.</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   LOGIN MODAL
═══════════════════════════════════════════════════════════════ */
function LoginModal({ onConnect, onClose, authStatus }) {
  const [token, setToken]     = React.useState('');
  const [busy, setBusy]       = React.useState(false);
  const [error, setError]     = React.useState('');
  const [showBuy, setShowBuy] = React.useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!token.trim()) { setError('Token required.'); return; }
    setBusy(true); setError('');
    const ok = await onConnect(token.trim());
    if (!ok) setError('Connection failed — token invalid or expired.');
    setBusy(false);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(8,11,17,0.78)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="panel" style={{ width: 400, boxShadow: '0 24px 60px rgba(0,0,0,0.7)' }}>
        <div className="panel-head">
          <Icon name="radio" size={14} color="var(--accent)" />
          <span className="title">Bloonet WS — API Token</span>
          <div className="sp"></div>
          <button className="btn ghost sm" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={submit} style={{ padding: '18px 16px' }}>
          <div className="field">
            <label>Bearer Token</label>
            <textarea className="control" rows={4}
              style={{ resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.5 }}
              value={token} onChange={(e) => setToken(e.target.value)}
              placeholder="eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9…" autoFocus />
          </div>
          {error && <div style={{ color: 'var(--danger)', fontSize: 11.5, marginBottom: 10, fontFamily: 'var(--font-mono)' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn ghost" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
            <button type="submit" className="btn primary" style={{ flex: 2 }} disabled={busy}>
              <Icon name={busy ? 'radio' : 'play'} size={13} />
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </div>
          <div style={{ marginTop: 14, padding: '10px 12px', background: 'var(--bg-2)', borderRadius: 'var(--r-md)', fontSize: 10.5, color: 'var(--text-2)', lineHeight: 1.7 }}>
            Keycloak · realm <code style={{ color: 'var(--accent)' }}>volcanoweb</code><br />
            Server: <code style={{ color: 'var(--text-1)', fontSize: 9.5 }}>api.bloonetws.siradel.com</code>
          </div>
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--text-2)' }}>No account yet?</span>
            <button type="button" className="btn ghost sm" onClick={() => setShowBuy(true)}>
              <Icon name="bolt" size={12} color="var(--accent)" /> Buy tokens
            </button>
          </div>
        </form>
      </div>
      {showBuy && <BuyTokensModal onClose={() => setShowBuy(false)} />}
    </div>
  );
}

Object.assign(window, {
  EntityTable, ParametersPanel, LogConsole, Legend, MapToolbar,
  LayerTree, LoginModal, BuyTokensModal, ResultsPanel, COLS,
});
