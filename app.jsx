/* RF Link Planner — main app: state, simulation orchestration, two layouts. */
const { useState, useEffect, useRef, useCallback } = React;
const uid = () => crypto.randomUUID();
const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : NaN; };

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#34d6c4",
  "linkWeight": 2,
  "linkGlow": true,
  "showLabels": true,
  "density": "regular"
}/*EDITMODE-END*/;

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [layout, setLayout] = useState('cockpit');
  const [basemap, setBasemap] = useState('plan');
  const [mode, setMode] = useState('pan');
  const [tx, setTx] = useState([]);
  const [rx, setRx] = useState([]);
  const [params, setParams] = useState({ frequency: 900, model: '', antenna: '', txPower: 43, threshold: -90, coverageRadius: 5000, colorMin: -120, colorMax: -60 });
  const [models, setModels] = useState([]);
  const [antennas, setAntennas] = useState([]);
  const [discovering, setDiscovering] = useState(false);
  const [logs, setLogs] = useState([]);
  const [links, setLinks] = useState([]);
  const [simulating, setSimulating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [coverageTif, setCoverageTif]   = useState(null);   // rendered raster
  const [coverageBuf, setCoverageBuf]   = useState(null);   // raw ArrayBuffer for download
  const [coverageRunning, setCoverageRunning] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [tab, setTab] = useState('tx'); // 'tx' | 'rx' | 'results'
  const [showLogin, setShowLogin]           = useState(false);
  const [showBuy,   setShowBuy]             = useState(false);
  const [coverageVisible, setCoverageVisible] = useState(true);
  const [authStatus, setAuthStatus] = useState('disconnected'); // disconnected | connecting | connected | error
  const logRef = useRef(null);
  const mapApiRef = useRef(null);

  const log = useCallback((msg, level = 'info') => {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
    setLogs((l) => [...l.slice(-300), { ts, msg, level }]);
  }, []);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logs]);

  // ---- apply tweaks
  useEffect(() => {
    const r = document.documentElement;
    r.style.setProperty('--accent', t.accent);
    r.style.setProperty('--accent-dim', t.accent + '24');
    r.style.setProperty('--accent-glow', t.accent + '66');
  }, [t.accent]);
  useEffect(() => {
    const c = document.body.classList;
    c.toggle('hide-labels', !t.showLabels);
    c.toggle('density-compact', t.density === 'compact');
    c.toggle('density-comfy', t.density === 'comfy');
  }, [t.showLabels, t.density]);

  // ---- Auth / connect
  const doConnect = useCallback(async (username, password, token) => {
    setAuthStatus('connecting');
    try {
      if (token) {
        log('Setting bearer token…');
        RFApi.setToken(token);
      } else {
        log(`Authenticating as ${username}…`);
        await RFApi.login(username, password);
      }
      RFApi.config.useMock = false;
      log(`Token set · syncing catalogs…`, 'ok');
      setAuthStatus('connected');
      setShowLogin(false);
      doDiscover();
      return true;
    } catch (e) {
      log('Authentication failed: ' + e.message, 'err');
      setAuthStatus('error');
      return false;
    }
  }, [log]);

  // ---- API discovery
  const doDiscover = useCallback(async () => {
    setDiscovering(true);
    log(`Connecting to ${RFApi.config.useMock ? 'mock' : RFApi.config.serverUrl} API…`);
    try {
      const [m, a] = await Promise.all([RFApi.discoverModels(), RFApi.discoverAntennas()]);
      setModels(m); setAntennas(a);
      setParams((p) => {
        const modelOk  = m.find((x) => x.id === p.model);
        const antOk    = a.find((x) => x.id === p.antenna);
        return {
          ...p,
          model:   modelOk  ? p.model   : (m[0]?.id ?? ''),
          antenna: antOk    ? p.antenna : (a[0]?.id ?? ''),
        };
      });
      log(`Catalogs ready · ${m.length} propagation models, ${a.length} antennas.`, 'ok');
    } catch (e) { log('Discovery failed: ' + e.message, 'err'); }
    setDiscovering(false);
  }, [log]);
  useEffect(() => { doDiscover(); }, [doDiscover]);

  // ---- cleaned numeric views for map + sim
  const clean = (list) => list
    .map((e) => ({ ...e, lat: num(e.lat), lon: num(e.lon), height: num(e.height) || 0, power: isFinite(num(e.power)) ? num(e.power) : params.txPower, azimuth: num(e.azimuth) || 0, tilt: num(e.tilt) || 0 }))
    .filter((e) => isFinite(e.lat) && isFinite(e.lon));
  const txClean = clean(tx);
  const rxClean = clean(rx);

  // ---- placing / editing
  const addPoint = useCallback((kind, lat, lon) => {
    const e = { id: uid(), lat: +lat.toFixed(5), lon: +lon.toFixed(5), azimuth: 0, tilt: 0 };
    if (kind === 'tx') {
      setTx((t) => { e.name = `TX-${t.length + 1}`; e.height = 30; e.power = params.txPower; log(`Placed ${e.name} @ ${e.lat}, ${e.lon}`, 'tx'); return [...t, e]; });
    } else {
      setRx((r) => { e.name = `RX-${r.length + 1}`; e.height = 2; e.power = ''; log(`Placed ${e.name} @ ${e.lat}, ${e.lon}`, 'info'); return [...r, e]; });
    }
  }, [params.txPower, log]);

  const editor = (setter) => (id, field, val) => setter((list) => list.map((e) => e.id === id ? { ...e, [field]: val } : e));
  const editTx = editor(setTx), editRx = editor(setRx);
  const delTx = (id) => setTx((l) => l.filter((e) => e.id !== id));
  const delRx = (id) => setRx((l) => l.filter((e) => e.id !== id));
  const moveMarker = (id, lat, lon) => {
    const f = (l) => l.map((e) => e.id === id ? { ...e, lat: +lat.toFixed(5), lon: +lon.toFixed(5) } : e);
    setTx(f); setRx(f);
  };

  const fitAll = useCallback(() => {
    const pts = [...txClean, ...rxClean].map((e) => [e.lat, e.lon]);
    if (pts.length && mapApiRef.current) mapApiRef.current.fitBounds(pts, { padding: [80, 80], maxZoom: 13 });
  }, [txClean, rxClean]);

  const bulkAdd = (kind, entities) => {
    const setter = kind === 'tx' ? setTx : setRx;
    setter((list) => {
      const mapped = entities.map((o, i) => ({
        id: uid(), name: o.name || `${kind === 'tx' ? 'TX' : 'RX'}-${list.length + i + 1}`,
        lat: o.lat, lon: o.lon, height: o.height ?? (kind === 'tx' ? 30 : 2),
        power: o.power ?? (kind === 'tx' ? params.txPower : ''), azimuth: o.azimuth ?? 0, tilt: o.tilt ?? 0,
      }));
      return [...list, ...mapped];
    });
    log(`Imported ${entities.length} ${kind === 'tx' ? 'transmitters' : 'receivers'} from clipboard.`, 'ok');
    setTimeout(fitAll, 120);
  };

  const clearAll = () => { setTx([]); setRx([]); setLinks([]); setCoverageTif(null); setCoverageBuf(null); log('Cleared all transmitters, receivers and links.', 'warn'); };

  // ---- coverage simulation
  const runCoverage = async () => {
    if (coverageRunning) return;
    if (!txClean.length) { log('Need at least one transmitter for coverage.', 'warn'); return; }
    if (!RFApi.config.useMock && !isUUID(params.model)) { log('Please sync catalogs first (live API).', 'warn'); return; }
    setCoverageRunning(true); setCoverageTif(null); setCoverageBuf(null); setProgress(0);
    log(`Coverage simulation · ${txClean.length} TX · radius ${params.coverageRadius ?? 5000} m · res 50 m`, 'ok');
    try {
      const res = await RFApi.simulateCoverage(
        { transmitters: txClean, frequency: params.frequency, model: params.model, antenna: params.antenna, computationRadiusM: params.coverageRadius ?? 5000 },
        (i, t) => setProgress((i / t) * 100)
      );
      setCoverageBuf(res.buffer || null);
      setCoverageTif(res);
      if (res.buffer) {
        log('Coverage done — GeoTIFF ready.', 'ok');
      } else if (res.points) {
        log(`Coverage done — ${res.points.length} grid points. Raw sample: ` + JSON.stringify(res.points.slice(0,2)), 'ok');
      } else {
        log('Coverage done — raw: ' + JSON.stringify(res).slice(0,200), 'warn');
      }
    } catch (e) { log('Coverage error: ' + e.message, 'err'); }
    setCoverageRunning(false); setProgress(0);
  };

  const downloadCoverage = () => {
    if (!coverageBuf) return;
    const blob = new Blob([coverageBuf], { type: 'image/tiff' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: 'coverage.tif' });
    a.click(); URL.revokeObjectURL(url);
  };

  function isUUID(v) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v); }

  // ---- simulation
  const runSim = async () => {
    if (simulating) return;
    if (!txClean.length || !rxClean.length) { log('Need at least one transmitter and one receiver to simulate.', 'warn'); return; }
    const total = txClean.length * rxClean.length;
    const mdl = (models.find((m) => m.id === params.model) || {}).name || params.model;
    const ant = (antennas.find((a) => a.id === params.antenna) || {}).name || params.antenna;
    setSimulating(true); setLinks([]); setProgress(0);
    log(`Simulation started · ${txClean.length} TX × ${rxClean.length} RX → ${total} point-to-point links.`, 'ok');
    log(`f = ${params.frequency} MHz · model = ${mdl} · antenna = ${ant}`);
    try {
      const res = await RFApi.simulate(
        { transmitters: txClean, receivers: rxClean, frequency: params.frequency, model: params.model, antenna: params.antenna },
        (i, t) => setProgress((i / t) * 100)
      );
      setLinks(res.links || []);
      log(`Simulation ${res.simulationUuid || '(mock)'} complete.`, 'ok');
      if (res.links?.length) {
        const txName = Object.fromEntries(txClean.map((t) => [t.id, t.name]));
        const rxName = Object.fromEntries(rxClean.map((r) => [r.id, r.name]));
        const sorted = [...res.links].sort((a, b) => b.receivedPower - a.receivedPower);
        sorted.slice(0, 30).forEach((lk) => log(`${txName[lk.txId]} → ${rxName[lk.rxId]}   ${lk.receivedPower} dBm   ${lk.distanceKm.toFixed(2)} km   ${qualityLabel(lk.receivedPower)}`, 'tx'));
        const ps = res.links.map((l) => l.receivedPower);
        const mean = (ps.reduce((a, b) => a + b, 0) / ps.length).toFixed(1);
        log(`mean ${mean} dBm · best ${Math.max(...ps).toFixed(1)} · worst ${Math.min(...ps).toFixed(1)} dBm.`, 'ok');
      } else if (res.simulationUuid) {
        log('No links parsed — raw: ' + (JSON.stringify(res.rawResults) || '{}').slice(0, 300), 'warn');
      }
    } catch (e) { log('Simulation error: ' + e.message, 'err'); }
    setSimulating(false); setProgress(0);
  };

  // ----------------------------- render pieces -----------------------------
  const apiLive = authStatus === 'connected';
  const empty = tx.length + rx.length === 0;

  const paramsPanel = <ParametersPanel p={params} setP={setParams} models={models} antennas={antennas} discovering={discovering} onDiscover={doDiscover} />;

  const tablesPanel = (
    <div className="panel" style={{ height: '100%' }}>
      <div className="panel-head">
        <div className="tabs">
          <button className={tab === 'tx'      ? 'active' : ''} onClick={() => setTab('tx')}>
            <Icon name="tx" size={13} color="var(--tx)" /> TX <span className="count">{tx.length}</span>
          </button>
          <button className={tab === 'rx'      ? 'active' : ''} onClick={() => setTab('rx')}>
            <Icon name="rx" size={13} color="var(--rx)" /> RX <span className="count">{rx.length}</span>
          </button>
          <button className={tab === 'results' ? 'active' : ''} onClick={() => setTab('results')}>
            <Icon name="bolt" size={13} color="var(--accent)" /> Results <span className="count">{links.length}</span>
          </button>
        </div>
        <div className="sp"></div>
        {tab !== 'results' && (
          <button className="btn ghost sm" onClick={() => (tab === 'tx' ? setTx([]) : setRx([]))}><Icon name="clear" size={13} /></button>
        )}
      </div>
      <div className="panel-body" style={{ padding: 0, display: 'flex', flexDirection: 'column' }}>
        {tab === 'tx' && <EntityTable kind="tx" rows={tx} onEdit={editTx} onDelete={delTx} onBulkAdd={(e) => bulkAdd('tx', e)} selectedId={selectedId} onSelect={setSelectedId} />}
        {tab === 'rx' && <EntityTable kind="rx" rows={rx} onEdit={editRx} onDelete={delRx} onBulkAdd={(e) => bulkAdd('rx', e)} selectedId={selectedId} onSelect={setSelectedId} />}
        {tab === 'results' && <ResultsPanel links={links} transmitters={txClean} receivers={rxClean} threshold={params.threshold} />}
      </div>
    </div>
  );

  const logPanel = (
    <div className="panel" style={{ height: '100%' }}>
      <div className="panel-head">
        <Icon name="terminal" size={14} color="var(--accent)" />
        <span className="title">Console</span>
        <div className="sp"></div>
        {links.length > 0 && <span className="count">{links.length} links</span>}
        <button className="btn ghost sm" onClick={() => setLogs([])}>Clear</button>
      </div>
      <LogConsole logs={logs} bodyRef={logRef} />
    </div>
  );

  const mapBlock = (
    <div className="map-region">
      {simulating && <div className="progress"><span style={{ width: progress + '%' }}></span></div>}
      <MapView transmitters={txClean} receivers={rxClean} links={links} basemap={basemap} mode={mode}
        onAddPoint={addPoint} onMoveMarker={moveMarker} onSelect={setSelectedId} selectedId={selectedId}
        onDelete={(id) => { delTx(id); delRx(id); }}
        mapApiRef={mapApiRef}
        linkWeight={t.linkWeight} linkGlow={t.linkGlow} coverageTif={coverageTif}
        coverageVisible={coverageVisible}
        colorMin={params.colorMin} colorMax={params.colorMax} />
      <MapToolbar mode={mode} setMode={setMode} basemap={basemap} setBasemap={setBasemap} />
      {coverageTif && (
        <LayerTree
          coverageVisible={coverageVisible} onToggleCoverage={setCoverageVisible}
          links={links}
        />
      )}
      <Legend colorMin={params.colorMin} colorMax={params.colorMax} />
      {empty && (
        <div className="map-hint">
          <div className="big">No stations placed yet</div>
          <div>Pick <b style={{ color: 'var(--tx)' }}>Add Transmitter</b> or <b style={{ color: 'var(--rx)' }}>Add Receiver</b> and click the map — or paste a list from Excel into the tables.</div>
        </div>
      )}
    </div>
  );

  const topbar = (
    <div className="topbar">
      <div className="brand">
        <div className="mark"><Icon name="radio" size={16} color="var(--accent)" /></div>
        <div>
          <div className="name">Siradel Web Services</div>
          <div className="sub">RF Link Planner</div>
        </div>
      </div>
      <div className="topbar-spacer"></div>
      <button className="btn ghost" onClick={() => setShowLogin(true)} title="API connection">
        <span className={`dot ${apiLive ? 'live' : authStatus === 'connecting' ? 'mock' : 'off'}`}></span>
        {authStatus === 'connecting' ? 'Connecting…' : authStatus === 'error' ? 'Auth error' : apiLive ? 'API' : 'Sign in'}
      </button>
      <button className="btn ghost" onClick={() => setShowBuy(true)} title="Buy simulation tokens">
        <Icon name="bolt" size={14} color="var(--accent)" /> Tokens
      </button>
      {coverageBuf && (
        <button className="btn ghost" onClick={downloadCoverage} title="Download GeoTIFF">
          <Icon name="download" size={14} /> GeoTIFF
        </button>
      )}
      <button className="btn ghost" onClick={clearAll}><Icon name="clear" size={14} /> Clear all</button>
      <button className="btn primary" style={{ background: 'linear-gradient(180deg,#4caf50,#388e3c)', boxShadow: '0 4px 18px -4px rgba(76,175,80,0.5)' }}
        onClick={runCoverage} disabled={coverageRunning}>
        <Icon name="layers" size={14} /> {coverageRunning ? `${Math.round(progress)}%` : 'Coverage'}
      </button>
      <button className="btn primary" onClick={runSim} disabled={simulating}>
        <Icon name={simulating ? 'radio' : 'play'} size={14} /> {simulating ? `${Math.round(progress)}%` : 'P2P Sim'}
      </button>
    </div>
  );

  // ----------------------------- layout (cockpit only) -----------------------------
  return (
    <div className="app-shell">
      {topbar}
      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }}>
        {mapBlock}
        <div style={{ position: 'absolute', top: 14, left: 14, width: 290, zIndex: 520 }}>
          <div className="panel">
            <div className="panel-head"><Icon name="sliders" size={14} color="var(--accent)" /><span className="title">Parameters</span></div>
            <div className="panel-body" style={{ maxHeight: '52vh' }}>{paramsPanel}</div>
          </div>
        </div>
        <div style={{ position: 'absolute', top: 14, right: 14, bottom: 226, width: 420, zIndex: 520 }}>{tablesPanel}</div>
        <div style={{ position: 'absolute', bottom: 14, left: 14, right: 420, height: 198, zIndex: 520 }}>{logPanel}</div>
      </div>
      {showLogin && <LoginModal onConnect={doConnect} onClose={() => setShowLogin(false)} authStatus={authStatus} />}
      {showBuy   && <BuyTokensModal onClose={() => setShowBuy(false)} />}}
      <TweaksPanel>
        <TweakSection label="Links" />
        <TweakSlider label="Line weight" value={t.linkWeight} min={1} max={6} step={1} unit="px" onChange={(v) => setTweak('linkWeight', v)} />
        <TweakToggle label="Glow halo" value={t.linkGlow} onChange={(v) => setTweak('linkGlow', v)} />
        <TweakSection label="Map" />
        <TweakToggle label="Station labels" value={t.showLabels} onChange={(v) => setTweak('showLabels', v)} />
        <TweakColor label="Accent" value={t.accent} options={['#34d6c4', '#5b9dff', '#ffb454', '#b78bff', '#3ad17a']} onChange={(v) => setTweak('accent', v)} />
        <TweakSection label="Interface" />
        <TweakRadio label="Density" value={t.density} options={['compact', 'regular', 'comfy']} onChange={(v) => setTweak('density', v)} />
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
