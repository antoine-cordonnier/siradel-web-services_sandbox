/* =============================================================================
 *  RF Link Planner — API layer  (Bloonet WS / Siradel)
 * ========================================================================== */
(function () {
  'use strict';

  /* ─── config ─────────────────────────────────────────────────────────── */
  var config = {
    useMock:     true,
    apiBase:     window.BLOONET_API_BASE || 'https://api.bloonetws.siradel.com',
    dlBase:      window.BLOONET_DL_BASE  || 'https://dl.bloonetws.siradel.com',
    authUrl:     window.BLOONET_AUTH_URL || 'https://keycloak.bloonetws.siradel.com/realms/volcanoweb/protocol/openid-connect/token',
    clientId:    'volcano-web-cli',
    tokenExpiry: 0,
    accessToken: '',
  };

  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function isUUID(v) { return UUID_RE.test(String(v || '')); }

  /* ─── auth ────────────────────────────────────────────────────────────── */
  async function fetchToken(username, password) {
    var body = new URLSearchParams({
      grant_type: 'password',
      client_id:  config.clientId,
      username:   username,
      password:   password,
    });
    var res = await fetch(config.authUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body,
    });
    if (!res.ok) {
      var err = await res.json().catch(function () { return {}; });
      throw new Error(err.error_description || err.error || 'Authentication failed (' + res.status + ')');
    }
    var data = await res.json();
    config.accessToken = data.access_token;
    config.tokenExpiry = Date.now() + (data.expires_in - 30) * 1000;
    return config.accessToken;
  }

  function getToken() {
    if (!config.accessToken) return Promise.reject(new Error('Not authenticated. Please sign in.'));
    // Auto-refresh if expired and credentials are stored
    if (config.tokenExpiry && Date.now() > config.tokenExpiry && config._username && config._password) {
      return fetchToken(config._username, config._password);
    }
    return Promise.resolve(config.accessToken);
  }

  function authHeaders() {
    return getToken().then(function (tok) {
      return { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', Accept: 'application/json' };
    });
  }

  /* ─── geo helpers ─────────────────────────────────────────────────────── */
  function haversineKm(a, b) {
    var R = 6371;
    function rad(d) { return d * Math.PI / 180; }
    var dLat = rad(b.lat - a.lat);
    var dLon = rad(b.lon - a.lon);
    var h = Math.sin(dLat/2)*Math.sin(dLat/2) +
            Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLon/2)*Math.sin(dLon/2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function bearingDeg(a, b) {
    function rad(d) { return d * Math.PI / 180; }
    var y = Math.sin(rad(b.lon-a.lon)) * Math.cos(rad(b.lat));
    var x = Math.cos(rad(a.lat))*Math.sin(rad(b.lat)) -
            Math.sin(rad(a.lat))*Math.cos(rad(b.lat))*Math.cos(rad(b.lon-a.lon));
    return Math.atan2(y, x) * 180 / Math.PI;
  }

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ─── mock catalogs ───────────────────────────────────────────────────── */
  var MOCK_MODELS = [
    { id: 'fs',      name: 'Free Space',                  excess: 0  },
    { id: 'hata-u',  name: 'Okumura-Hata Urban',          excess: 28 },
    { id: 'hata-s',  name: 'Okumura-Hata Suburban',       excess: 18 },
    { id: 'cost231', name: 'COST 231 Walfisch-Ikegami',   excess: 22 },
    { id: 'itu526',  name: 'ITU-R P.526 Diffraction',     excess: 14 },
    { id: 'longley', name: 'Longley-Rice Irregular',       excess: 11 },
  ];

  var MOCK_ANTENNAS = [
    { id: 'iso',      name: 'Isotropic',          gain: 0,    beamwidth: 360 },
    { id: 'dipole',   name: 'Half-wave Dipole',   gain: 2.15, beamwidth: 360 },
    { id: 'yagi7',    name: 'Yagi 7 element',     gain: 12,   beamwidth: 50  },
    { id: 'sector65', name: 'Sector Panel 65deg', gain: 16,   beamwidth: 65  },
    { id: 'dish12',   name: 'Parabolic 1.2m',     gain: 28,   beamwidth: 8   },
  ];

  function shadowing(seed) {
    var s = Math.sin(seed * 12.9898) * 43758.5453;
    return (s - Math.floor(s) - 0.5) * 14;
  }

  function patternLoss(beamwidth, offsetDeg) {
    if (beamwidth >= 360) return 0;
    var off = Math.abs(((offsetDeg + 180) % 360) - 180);
    var half = beamwidth / 2;
    if (off <= half) return (off / half) * 3;
    return 3 + Math.min(1, (off - half) / (180 - half)) * 19;
  }

  function mockSimulate(payload) {
    var transmitters = payload.transmitters, receivers = payload.receivers,
        frequency = payload.frequency, model = payload.model, antenna = payload.antenna;
    var mdl = MOCK_MODELS.find(function (m) { return m.id === model; }) || MOCK_MODELS[0];
    var ant = MOCK_ANTENNAS.find(function (a) { return a.id === antenna; }) || MOCK_ANTENNAS[0];
    var links = [];
    transmitters.forEach(function (tx) {
      receivers.forEach(function (rx) {
        var dKm = Math.max(0.02, haversineKm(tx, rx));
        var fspl = 32.44 + 20*Math.log10(dKm) + 20*Math.log10(frequency);
        var off = bearingDeg(tx, rx) - (tx.azimuth || 0);
        var pathLoss = fspl + mdl.excess + patternLoss(ant.beamwidth, off) +
                       Math.abs(tx.tilt || 0)*0.4 -
                       shadowing(tx.lat*7.3 + tx.lon*3.1 + rx.lat*5.7 + rx.lon*1.9);
        links.push({
          txId: tx.id, rxId: rx.id,
          distanceKm:    Math.round(dKm * 100) / 100,
          pathLoss:      Math.round(pathLoss * 10) / 10,
          receivedPower: Math.round(((tx.power || 43) + ant.gain*2 - pathLoss) * 10) / 10,
        });
      });
    });
    return { links: links };
  }

  /* ─── session helper ──────────────────────────────────────────────────── */
  async function createSession(name) {
    var hdrs = await authHeaders();
    var uuid = crypto.randomUUID();
    var res  = await fetch(config.apiBase + '/sessions', {
      method: 'POST', headers: hdrs,
      body: JSON.stringify({ uuid: uuid, name: name || 'rf-link-planner', description: '' }),
    });
    if (!res.ok) throw new Error('Session creation failed (' + res.status + '): ' + await res.text());
    var data = await res.json();
    return data.uuid || uuid;
  }

  /* ─── POST simulation helper ──────────────────────────────────────────── */
  async function postSimulation(simJson) {
    var hdrs = await authHeaders();
    delete hdrs['Content-Type'];   // let browser set multipart boundary
    var form = new FormData();
    form.append('json', new Blob([JSON.stringify(simJson)], { type: 'application/json' }), 'simulation.json');
    var res = await fetch(config.apiBase + '/simulations', { method: 'POST', headers: hdrs, body: form });
    if (!res.ok) throw new Error('Simulation POST failed (' + res.status + '): ' + await res.text());
    var created = await res.json();
    return created.uuid || simJson.uuid;
  }

  /* ─── poll status helper ──────────────────────────────────────────────── */
  async function pollStatus(simId, onProgress) {
    var DONE = ['DONE', 'DONE_WITH_ERROR'];
    var ERR  = ['ERROR', 'CANCELED'];
    var hdrs = await authHeaders();
    for (var i = 0; i < 150; i++) {
      await delay(2000);
      var res = await fetch(config.apiBase + '/simulations/' + simId + '/status', { headers: hdrs });
      if (!res.ok) throw new Error('Status poll failed (' + res.status + ')');
      var st = await res.json();
      if (onProgress) onProgress(st.progress != null ? st.progress : Math.min(i * 5, 90), 100);
      if (ERR.includes(st.state))  throw new Error('Simulation ' + st.state + ': ' + (st.error || ''));
      if (DONE.includes(st.state)) return st;
    }
    throw new Error('Simulation timed out after 5 min.');
  }

  /* ─── live P2P simulation ─────────────────────────────────────────────── */
  async function liveSimulate(payload, onProgress) {
    var transmitters = payload.transmitters, receivers = payload.receivers,
        frequency = payload.frequency, model = payload.model, antenna = payload.antenna;

    if (!isUUID(model)) throw new Error('Invalid model "' + model + '". Please sync catalogs (live API).');

    var sessId = await createSession('rf-link-planner');
    var rxH = receivers.length ? (receivers[0].height || 1.5) : 1.5;

    var scenarios = transmitters.map(function (tx, idx) {
      return {
        baseStation: {
          name: tx.name, sessionUuid: sessId,
          x: tx.lon, y: tx.lat, z: tx.height || 30,
          epsgCode: 4326, zmeaning: 'ZMEANING_GROUND',
          azimuth: tx.azimuth || 0, downtilt: tx.tilt || 0,
          carrierFrequency: frequency, networkId: idx + 1,
          transmitPower: tx.power || 43,
          antennaUuid: isUUID(antenna) ? antenna : undefined,
        },
        userEquipments: receivers.map(function (rx) {
          return {
            name: rx.name, sessionUuid: sessId,
            type: 'POINT', heights: [rx.height || 1.5],
            coordinates: { x: rx.lon, y: rx.lat, epsgCode: 4326 },
          };
        }),
        propagationModelUuid: model,
      };
    });

    var simUuid = crypto.randomUUID();
    var simJson = {
      uuid: simUuid, name: 'rf-link-planner', calculationSessionUuid: sessId,
      propagationRequest: {
        propagationScenarios: scenarios,
        resultTypes: ['RECEIVED_POWER'],
        zmeaning: 'ZMEANING_GROUND',
      },
    };

    var createdId = await postSimulation(simJson);
    await pollStatus(createdId, onProgress);

    // Fetch per-point JSON results
    var hdrs = await authHeaders();
    var resListR = await fetch(config.apiBase + '/simulations/' + createdId + '/results', { headers: hdrs });
    var resList  = await resListR.json();

    var links = [];
    var txById = {}, rxById = {};
    transmitters.forEach(function (t) { txById[t.name] = t; });
    receivers.forEach(function   (r) { rxById[r.name] = r; });

    var dlHdrs = { Authorization: hdrs.Authorization, Accept: '*/*' };
    for (var ri = 0; ri < resList.length; ri++) {
      var dlR = await fetch(config.dlBase + '/results/' + resList[ri].uuid + '/download', { headers: dlHdrs });
      if (!dlR.ok) { console.warn('[P2P] result download failed', dlR.status); continue; }
      var data = await dlR.json();
      (data.transmitters || []).forEach(function (txRes) {
        var tx = txById[txRes.name];
        if (!tx) return;
        (txRes.receivers || []).forEach(function (rxRes) {
          var baseName = rxRes.name.replace(/_[\d.]+$/, '');
          var rx = rxById[baseName];
          if (!rx) return;
          var q = (rxRes.qualifications || []).find(function (q) { return q.name === 'received_power'; });
          if (!q) return;
          links.push({
            txId: tx.id, rxId: rx.id,
            distanceKm:    Math.round(haversineKm(tx, rx) * 100) / 100,
            pathLoss:      0,
            receivedPower: q.value,
          });
        });
      });
    }
    return { links: links, simulationUuid: createdId };
  }

  /* ─── mock coverage raster ────────────────────────────────────────────── */
  async function mockCoverage(payload, onProgress) {
    var transmitters = payload.transmitters;
    var frequency    = payload.frequency || 900;
    var radiusM      = payload.computationRadiusM || 5000;
    var W = 120, H = 120;

    var xmin =  Infinity, ymin =  Infinity;
    var xmax = -Infinity, ymax = -Infinity;
    transmitters.forEach(function (tx) {
      var dLat = radiusM / 111000;
      var dLon = radiusM / (111000 * Math.cos(tx.lat * Math.PI / 180));
      xmin = Math.min(xmin, tx.lon - dLon); xmax = Math.max(xmax, tx.lon + dLon);
      ymin = Math.min(ymin, tx.lat - dLat); ymax = Math.max(ymax, tx.lat + dLat);
    });

    await delay(300);
    if (onProgress) onProgress(30, 100);
    await delay(200);

    var band = new Float32Array(W * H);
    for (var j = 0; j < H; j++) {
      for (var i = 0; i < W; i++) {
        var lon = xmin + (i / W) * (xmax - xmin);
        var lat = ymax - (j / H) * (ymax - ymin);
        var best = -Infinity;
        transmitters.forEach(function (tx) {
          var d    = Math.max(0.05, haversineKm({ lat: lat, lon: lon }, tx));
          var fspl = 32.44 + 20*Math.log10(d) + 20*Math.log10(frequency);
          var v    = (tx.power || 43) - fspl;
          if (v > best) best = v;
        });
        band[j * W + i] = best;
      }
    }

    if (onProgress) onProgress(100, 100);
    return { band: band, width: W, height: H, bbox: [xmin, ymin, xmax, ymax], isMock: true };
  }

  /* ─── live coverage simulation ────────────────────────────────────────── */
  async function liveCoverage(payload, onProgress) {
    var transmitters  = payload.transmitters;
    var frequency     = payload.frequency || 900;
    var model         = payload.model;
    var antenna       = payload.antenna;
    var radiusM       = payload.computationRadiusM || 5000;

    if (!isUUID(model)) throw new Error('Invalid model "' + model + '". Please sync catalogs (live API).');

    var sessId = await createSession('rf-coverage');

    // One scenario per TX with AREA UE
    var scenarios = transmitters.map(function (tx, idx) {
      var dLat = radiusM / 111000;
      var dLon = radiusM / (111000 * Math.cos(tx.lat * Math.PI / 180));
      return {
        baseStation: {
          name: tx.name, sessionUuid: sessId,
          x: tx.lon, y: tx.lat, z: tx.height || 30,
          epsgCode: 4326, zmeaning: 'ZMEANING_GROUND',
          azimuth: tx.azimuth || 0, downtilt: tx.tilt || 0,
          carrierFrequency: frequency, networkId: idx + 1,
          transmitPower: tx.power || 43,
          antennaUuid: isUUID(antenna) ? antenna : undefined,
        },
        userEquipments: [{
          name: tx.name, sessionUuid: sessId,
          zmeaning: 'ZMEANING_GROUND', type: 'AREA',
          heights: [1.5],
          coordinates: {
            xmin: tx.lon - dLon, xmax: tx.lon + dLon,
            ymin: tx.lat - dLat, ymax: tx.lat + dLat,
            resolution: 50, epsgCode: 4326,
          },
        }],
        propagationModelUuid: model,
      };
    });

    var simUuid = crypto.randomUUID();
    var simJson = {
      uuid: simUuid, name: 'rf-coverage', calculationSessionUuid: sessId,
      propagationRequest: {
        propagationScenarios: scenarios,
        // RECEIVED_POWER drives propagation; DL_BEST_SIGNAL drives postprocessing raster
        resultTypes: ['RECEIVED_POWER', 'OPTICAL_VISIBILITY'],
        zmeaning: 'ZMEANING_GROUND',
      },
      postprocessingRequest: {
        resolution: 50,
        computationType: 'Custom',
        // DL_BEST_SIGNAL → result type 'received_power' → GeoTIFF raster
        resultTypes: ['DL_BEST_SIGNAL', 'BEST_SERVER', 'OPTICAL_VISIBILITY'],
        computationZone: { epsgCode: 4326 },
      },
    };

    var createdId = await postSimulation(simJson);
    await pollStatus(createdId, onProgress);

    // Get results list — pick the one with type 'received_power' (= DL_BEST_SIGNAL raster)
    var hdrs     = await authHeaders();
    var resListR = await fetch(config.apiBase + '/simulations/' + createdId + '/results', { headers: hdrs });
    if (!resListR.ok) throw new Error('Results fetch failed (' + resListR.status + ')');
    var resList = await resListR.json();
    if (!resList.length) throw new Error('No results returned for coverage simulation.');

    // Find received_power result; fall back to first result
    var target = resList.find(function (r) { return r.type === 'received_power'; }) || resList[0];

    // TIF is binary — override Accept to signal we accept any content type
    var tifHdrs = { Authorization: hdrs.Authorization, Accept: '*/*' };
    var dlR = await fetch(config.dlBase + '/results/' + target.uuid + '/download', { headers: tifHdrs });
    if (!dlR.ok) {
      var errText = await dlR.text().catch(function () { return ''; });
      throw new Error('TIF download failed (' + dlR.status + '): ' + errText);
    }

    var buffer = await dlR.arrayBuffer();
    return { buffer: buffer, simulationUuid: createdId, resultUuid: target.uuid };
  }

  /* ─── public API ──────────────────────────────────────────────────────── */
  var RFApi = {
    config: config,

    login: async function (username, password) {
      config._username = username;
      config._password = password;
      config.accessToken = '';
      await fetchToken(username, password);
      return true;
    },

    setToken: function (token) {
      config.accessToken = (token || '').trim();
    },

    connect: async function () {
      var hdrs = await authHeaders();
      var res  = await fetch(config.apiBase + '/antennas', { headers: hdrs });
      if (!res.ok) throw new Error('Token rejected (' + res.status + ')');
      return true;
    },

    discoverModels: async function () {
      if (config.useMock) { await delay(420); return MOCK_MODELS; }
      var hdrs = await authHeaders();
      var res  = await fetch(config.apiBase + '/propagationmodels', { headers: hdrs });
      if (!res.ok) throw new Error('propagationmodels ' + res.status);
      var data = await res.json();
      return (Array.isArray(data) ? data : data.items || [])
        .map(function (m) { return { id: m.uuid || m.id, name: m.name }; });
    },

    discoverAntennas: async function () {
      if (config.useMock) { await delay(520); return MOCK_ANTENNAS; }
      var hdrs = await authHeaders();
      var res  = await fetch(config.apiBase + '/antennas', { headers: hdrs });
      if (!res.ok) throw new Error('antennas ' + res.status);
      var data = await res.json();
      return (Array.isArray(data) ? data : data.items || [])
        .map(function (a) { return { id: a.uuid || a.id, name: a.name, gain: a.gain != null ? a.gain : null }; });
    },

    simulate: async function (payload, onProgress) {
      if (config.useMock) {
        var total = payload.transmitters.length * payload.receivers.length;
        for (var i = 1; i <= total; i++) {
          await delay(Math.max(8, 140 - total * 2));
          if (onProgress) onProgress(i, total);
        }
        return mockSimulate(payload);
      }
      return liveSimulate(payload, onProgress);
    },

    simulateCoverage: async function (payload, onProgress) {
      if (config.useMock) {
        return mockCoverage(payload, onProgress);
      }
      return liveCoverage(payload, onProgress);
    },

    haversineKm:  haversineKm,
    bearingDeg:   bearingDeg,
  };

  window.RFApi = RFApi;
})();
