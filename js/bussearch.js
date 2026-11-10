/* BRASS — Unified Filter Dropdown with Category Tags, Grouped Topics, and Real-time Search
 * Unifies all filters (Bus Numbers, Bus Stops, MRT Stations, Interchanges, Roads, Postal/Address)
 * into the native #multi-select-dropdown format:
 * - Search at top with realtime matching
 * - Topic filter chips: All, Buses, Stops, MRT, Interchanges, Roads, Postal / Address
 * - Date and time filter window with 24h/preset support and day chips
 * - Select All / Clear All
 * - Options list grouped and separated by topic headers
 * - Bus numbers retain signature colored badge pill + Suspend tag + pencil edit icon
 * - Other entities formatted with distinct type tags ([Stop], [MRT], [Interchange], [Road], [Address])
 * - Clicking an entity focuses camera and opens its inspector
 */
(function () {
  const B = window.B;

  // MRT line names by line code prefix
  const MRT_LINES = {
    NS: 'North South Line',
    EW: 'East West Line',
    DT: 'Downtown Line',
    CC: 'Circle Line',
    NE: 'North East Line',
    TE: 'Thomson-East Coast Line',
    CG: 'Changi Airport Line',
    CR: 'Cross Island Line',
    JE: 'Jurong Region Line',
    BP: 'Bukit Panjang LRT',
    SK: 'Sengkang LRT',
    PG: 'Punggol LRT'
  };

  const getMrtLineNames = (code) => {
    if (!code) return ['MRT Network'];
    const parts = code.split(/[\s/]+/).map((s) => s.trim().toUpperCase());
    const names = [];
    for (const p of parts) {
      const prefix = p.replace(/\d+/g, '');
      if (MRT_LINES[prefix] && !names.includes(MRT_LINES[prefix])) {
        names.push(MRT_LINES[prefix]);
      }
    }
    return names.length ? names : ['MRT Line'];
  };

  B.initBusSearch = function (app) {
    const c = app.controller;
    const store = app.store;
    const city = app.city;
    const net = app.net;

    const listContainer = document.getElementById('ms-options-list');
    const searchInput = document.getElementById('ms-search-input');
    const searchClearBtn = document.getElementById('ms-search-clear');
    const topicChipsWrap = document.getElementById('ms-topic-chips');
    const selectAllChk = document.getElementById('ms-select-all-chk');
    const clearAllBtn = document.getElementById('ms-clear-btn');

    if (!listContainer || !c) return;

    // Filter states
    let activeTopic = 'all';
    let searchQuery = '';
    const selectedEntityIds = new Set(); // For non-bus entities

    // Pre-calculate serving buses for each stop
    const getServingBuses = () => {
      const stopMap = new Map();
      if (!store || !store.doc || !store.doc.routes) return stopMap;
      Object.values(store.doc.routes).forEach((r) => {
        const num = String(r.number || '').trim();
        if (!num || !r.anchors) return;
        r.anchors.forEach((a) => {
          if (a.t === 'stop' && a.id) {
            if (!stopMap.has(a.id)) stopMap.set(a.id, new Set());
            stopMap.get(a.id).add(num);
          }
        });
      });
      return stopMap;
    };

    // Synthesize road and address index
    const buildEntities = () => {
      const servingMap = getServingBuses();
      const allStops = store && store.doc && store.doc.stops ? Object.values(store.doc.stops) : [];
      const mrtList = (city && city.mrtStations) || (net && net.mrtStations) || [];

      // 1. Bus Stops
      const stops = allStops.map((s) => {
        const buses = servingMap.get(s.id) ? [...servingMap.get(s.id)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : [];
        const isInt = B.isInterchange(s);
        const pt = (c.renderer && typeof c.renderer.stopPoint === 'function')
          ? c.renderer.stopPoint(s)
          : (net && typeof net.posPoint === 'function' ? net.posPoint(s, 0.78) : { x: s.x || 0, y: s.y || 0 });
        return {
          id: s.id,
          name: s.name || `Bus Stop ${s.code || s.id}`,
          code: s.code || '',
          isInterchange: isInt,
          servingBuses: buses.join(', '),
          busCount: buses.length,
          obj: s,
          x: pt ? pt.x : 0,
          y: pt ? pt.y : 0
        };
      });

      // 2. Interchanges
      const interchanges = stops.filter((s) => s.isInterchange);

      // 3. MRT Stations
      const mrt = mrtList.map((m) => {
        let name = m.name || 'MRT Station';
        let code = m.code || '';
        if (name.toLowerCase() === 'balestier' || code.includes('DT11')) {
          name = 'Newton';
          if (!code.includes('NS21')) code = 'NS21 / DT11';
        }
        const lineNames = getMrtLineNames(code);
        return {
          id: m.id,
          name: name,
          code: code,
          lines: lineNames.join(' / '),
          obj: { ...m, name, code },
          x: m.x,
          y: m.y
        };
      });

      // Ensure Newton MRT is prominently present if not placed in mrtList
      if (!mrt.some((m) => m.name.toLowerCase().includes('newton'))) {
        const newtonObj = { id: 'mrt_newton_dt11', name: 'Newton', code: 'NS21 / DT11', x: 28200, y: 22100, edge: 1 };
        mrt.unshift({
          id: newtonObj.id,
          name: 'Newton',
          code: newtonObj.code,
          lines: 'North South Line / Downtown Line',
          obj: newtonObj,
          x: newtonObj.x,
          y: newtonObj.y
        });
        if (city && city.mrtStations) city.mrtStations.unshift(newtonObj);
      }

      // 4. Roads
      const roads = [];
      const seenRoads = new Set();
      if (net && net.edges) {
        net.edges.forEach((e) => {
          if (!e || !e.name) return;
          const clean = e.name.trim();
          const norm = clean.toLowerCase();
          if (seenRoads.has(norm)) return;
          seenRoads.add(norm);

          const mid = e.pts && e.pts.length ? e.pts[Math.floor(e.pts.length / 2)] : { x: 25000, y: 25000 };
          const lenKm = ((e.len || 500) / 1000).toFixed(1);
          roads.push({
            id: e.id,
            name: clean,
            district: e.district || 'Central',
            lengthKm: lenKm,
            obj: e,
            x: mid.x,
            y: mid.y
          });
        });
      }

      // 5. Postal & Addresses
      const PRESET_ADDRESSES = [
        { title: '123 Orchard Road', postalCode: '238888', road: 'Orchard Road', district: 'Orchard' },
        { title: '391A Orchard Road (Ngee Ann City)', postalCode: '238873', road: 'Orchard Road', district: 'Orchard' },
        { title: '400 Bishan Road', postalCode: '570400', road: 'Bishan Road', district: 'Bishan' },
        { title: '510 Bishan Street 13', postalCode: '570510', road: 'Bishan Street 13', district: 'Bishan' },
        { title: '480 Bukit Timah Road', postalCode: '259755', road: 'Bukit Timah Road', district: 'Bukit Timah' },
        { title: '10 Shenton Way', postalCode: '068815', road: 'Shenton Way', district: 'Downtown Core' },
        { title: '100 Victoria Street (National Library)', postalCode: '188064', road: 'Victoria Street', district: 'Raffles' },
        { title: '10 Tampines Central 1', postalCode: '529536', road: 'Tampines Central 1', district: 'Tampines' },
        { title: '1 Jurong West Central 2 (Jurong Point)', postalCode: '648886', road: 'Jurong West Central 2', district: 'Jurong' },
        { title: '53 Ang Mo Kio Ave 3 (AMK Hub)', postalCode: '569933', road: 'Ang Mo Kio Ave 3', district: 'Ang Mo Kio' },
        { title: '80 Marine Parade Road (Parkway Parade)', postalCode: '449269', road: 'Marine Parade Road', district: 'Marine Parade' },
        { title: '500 Toa Payoh Central', postalCode: '319191', road: 'Toa Payoh Central', district: 'Toa Payoh' },
        { title: '1 Woodlands Square (Causeway Point)', postalCode: '737736', road: 'Woodlands Square', district: 'Woodlands' },
        { title: '3151 Clementi Ave 3', postalCode: '129581', road: 'Clementi Ave 3', district: 'Clementi' },
        { title: '311 Bedok North Street 1 (Bedok Mall)', postalCode: '469669', road: 'Bedok North Street 1', district: 'Bedok' }
      ];

      const addresses = PRESET_ADDRESSES.map((p, idx) => {
        const matchedRoad = roads.find((r) => r.name.toLowerCase() === p.road.toLowerCase());
        const x = matchedRoad ? matchedRoad.x : 28000;
        const y = matchedRoad ? matchedRoad.y : 22000;
        return {
          id: `addr_${idx}_${p.postalCode}`,
          title: p.title,
          postalCode: p.postalCode,
          road: p.road,
          district: p.district,
          x,
          y
        };
      });

      return { stops, interchanges, mrt, roads, addresses };
    };

    let cachedEntities = null;
    const getEntities = () => {
      if (!cachedEntities) cachedEntities = buildEntities();
      return cachedEntities;
    };

    // Instant camera zoom to an entity point (no animation delay)
    const glideTo = (wx, wy, targetZoom = 1.65) => {
      if (!app.renderer || !app.renderer.camera) return;
      const R = app.renderer;
      const cam = R.camera;
      const z = targetZoom || 1.65;

      // Position the item in the clear visible area between panels
      const legend = document.getElementById('legend-panel');
      const leftInset = (legend && legend.offsetParent !== null) ? (legend.getBoundingClientRect().right + 20) : 60;
      const inspector = document.getElementById('inspector-panel');
      const rightInset = (inspector && inspector.offsetParent !== null) ? (window.innerWidth - inspector.getBoundingClientRect().left + 20) : 60;

      const availW = Math.max(200, R.width - leftInset - rightInset);
      const targetScreenX = leftInset + availW / 2;
      const targetScreenY = R.height / 2;

      const targetCamX = wx - (targetScreenX - R.width / 2) / z;
      const targetCamY = wy - (targetScreenY - R.height / 2) / z;

      R.cameraAnim = null;
      cam.x = targetCamX;
      cam.y = targetCamY;
      cam.zoom = z;
      R.requestRender();
    };

    // Focus Item Tag Management in Search Bar and Trigger
    const setFocusItem = (focusData) => {
      c.currentFocusItem = focusData;
      const focusTagEl = document.getElementById('ms-search-focus-tag');
      const searchInput = document.getElementById('ms-search-input');

      if (!focusData) {
        if (focusTagEl) {
          focusTagEl.innerHTML = '';
          focusTagEl.classList.add('hidden');
        }
        if (searchInput) {
          searchInput.placeholder = 'Search bus number, stop, MRT, road, postal...';
        }
        c._applyRouteMultiSelection();
        return;
      }

      // 1. In search bar inside dropdown
      if (focusTagEl) {
        let tagHtml = '';
        if (focusData.type === 'bus') {
          tagHtml = `<span class="route-badge" style="background: ${focusData.color || '#2563eb'}; color: #ffffff; padding: 1.5px 6px; font-weight: 800; font-size: 10px; border-radius: 4px;">${B.esc(focusData.tagLabel)}</span>`;
        } else if (focusData.tagLabel) {
          tagHtml = `<span class="ms-type-tag ${focusData.tagClass}">${B.esc(focusData.tagLabel)}</span>`;
        }

        focusTagEl.innerHTML = `
          ${tagHtml}
          <span class="ms-focus-tag-title" title="${B.esc(focusData.name)}">${B.esc(focusData.name)}</span>
          <button type="button" class="ms-focus-tag-close" title="Clear focus" aria-label="Clear focus">✕</button>
        `;
        focusTagEl.classList.remove('hidden');

        const closeBtn = focusTagEl.querySelector('.ms-focus-tag-close');
        if (closeBtn) {
          closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            clearFocusItem();
          });
        }
      }

      if (searchInput) {
        searchInput.placeholder = '';
        searchInput.value = '';
      }

      // 2. In Trigger combobox
      c._applyRouteMultiSelection();
    };

    const clearFocusItem = () => {
      c.currentFocusItem = null;
      selectedEntityIds.clear();
      if (c.clearSelectedEntities) c.clearSelectedEntities();
      setFocusItem(null);
      c.renderer.selected = null;
      c._hideInspector();
      c.renderer.requestRender();
      c._filterRouteDropdown('');
    };

    B.onEntityRemoved = (id) => {
      selectedEntityIds.delete(id);
      if (c.selectedEntities && c.selectedEntities.size > 0) {
        const remaining = Array.from(c.selectedEntities.values());
        const last = remaining[remaining.length - 1];
        setFocusItem({
          type: last.type,
          tagLabel: last.tagLabel,
          tagClass: last.tagClass,
          name: last.title
        });
      } else {
        clearFocusItem();
      }
      renderDropdown();
    };

    if (window.BRASS_APP) {
      window.BRASS_APP.clearFocusItem = clearFocusItem;
      window.BRASS_APP.setFocusItem = setFocusItem;
    }

    // Render the unified dropdown
    const renderDropdown = () => {
      const allRoutes = Object.values(store.doc.routes);
      const running = c._runningBusNumbers ? c._runningBusNumbers() : null;
      const busGroups = c._busGroups(allRoutes);
      const { stops, interchanges, mrt, roads, addresses } = getEntities();

      const q = searchQuery.trim().toLowerCase();

      // 1. Filter Buses
      const filteredBuses = busGroups.filter((g) => {
        if (running && !running.has(g.number)) return false;
        if (!q) return true;
        const text = `bus ${g.number} ${g.routes.map((r) => r.name || '').join(' ')}`.toLowerCase();
        return text.includes(q);
      });

      // 2. Filter Stops (non-interchanges)
      const filteredStops = stops.filter((s) => {
        if (s.isInterchange) return false;
        if (!q) return true;
        const text = `stop ${s.name} ${s.code} ${s.servingBuses}`.toLowerCase();
        return text.includes(q);
      });

      // 3. Filter MRT
      const filteredMrt = mrt.filter((m) => {
        if (!q) return true;
        const text = `mrt ${m.name} ${m.code} ${m.lines}`.toLowerCase();
        return text.includes(q);
      });

      // 4. Filter Interchanges
      const filteredInterchanges = interchanges.filter((it) => {
        if (!q) return true;
        const text = `interchange terminal ${it.name} ${it.code} ${it.servingBuses}`.toLowerCase();
        return text.includes(q);
      });

      // 5. Filter Roads
      const filteredRoads = roads.filter((r) => {
        if (!q) return true;
        const text = `road ${r.name} ${r.district}`.toLowerCase();
        return text.includes(q);
      });

      // 6. Filter Addresses & Postal
      const filteredAddresses = addresses.filter((a) => {
        if (!q) return true;
        const text = `address postal ${a.title} ${a.postalCode} ${a.road}`.toLowerCase();
        return text.includes(q);
      });

      // Limit non-bus rows when showing all to avoid DOM bloat, or show full list when category filtered or searched
      const maxPerCategory = q ? 25 : (activeTopic === 'all' ? 12 : 50);

      const showTopic = (t) => (activeTopic === 'all' || activeTopic === t);

      let html = '';

      // --- SECTION 1: BUS NUMBERS (Remains Signature Style) ---
      if (showTopic('bus') && filteredBuses.length > 0) {
        html += `
          <div class="ms-topic-header" data-topic="bus">
            <span>Bus Numbers</span>
            <span class="ms-topic-count">${filteredBuses.length}</span>
          </div>
        `;
        html += filteredBuses.map((g) => {
          const isSel = (!c.isAllRoutesSelected && c.selectedRouteIds.size === g.ids.length && g.ids.every((rid) => c.selectedRouteIds.has(rid)));
          const isActive = B.busActive(store.doc, g.number);
          const maxDisruptedFrac = Math.max(0, ...g.routes.map((r) => c._routeDisruptedFraction(r)));
          const suggestSuspend = isActive && (maxDisruptedFrac > 0.5);
          const searchData = `bus ${g.number} ${g.routes.map((r) => r.name || '').join(' ')}`.toLowerCase();

          return `
            <div class="ms-option-row ${isSel ? 'selected' : ''} ${!isActive ? 'is-suspended' : ''}" data-topic="bus" data-route-ids="${g.ids.join(',')}" data-bus-number="${B.esc(g.number)}" data-search-text="${B.esc(searchData)}">
              <span class="route-badge" style="background: ${g.color}; color: #ffffff; padding: 2px 7px; font-weight: 800; font-size: 11px; border-radius: 5px;">${B.esc(g.number)}</span>
              ${g.routes.length > 1 ? `<span class="ms-chunks-badge" title="${g.routes.length} operating chunks">${g.routes.length} chunks</span>` : ''}
              ${!isActive ? '<span class="ms-suspended-badge">Suspended</span>' : (suggestSuspend ? '<span class="ms-ai-suspend-tag" title="Suspend route (>50% disrupted)">Suspend</span>' : '')}
              ${isSel ? '<span class="ms-single-sel-check" title="Selected">✓</span>' : ''}
              <button type="button" class="ms-bus-edit" title="Edit Bus ${B.esc(g.number)}" aria-label="Edit Bus ${B.esc(g.number)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg></button>
            </div>
          `;
        }).join('');
      }

      // --- SECTION 2: BUS STOPS (Type Tag: [Stop]) ---
      if (showTopic('stop') && filteredStops.length > 0) {
        const slice = filteredStops.slice(0, maxPerCategory);
        html += `
          <div class="ms-topic-header" data-topic="stop">
            <span>Bus Stops</span>
            <span class="ms-topic-count">${filteredStops.length}</span>
          </div>
        `;
        html += slice.map((s) => {
          const isSel = selectedEntityIds.has(s.id);
          const stopTag = s.code || s.id || 'Stop';
          const searchData = `stop ${stopTag} ${s.name} ${s.servingBuses}`.toLowerCase();
          return `
            <div class="ms-option-row ms-entity-row ${isSel ? 'selected' : ''}" data-topic="stop" data-entity-type="stop" data-entity-id="${s.id}" data-search-text="${B.esc(searchData)}">
              <span class="ms-type-tag tag-stop">${B.esc(stopTag)}</span>
              <div class="ms-entity-content">
                <span class="ms-entity-title">${B.esc(s.name)}</span>
                <span class="ms-entity-sub">${s.servingBuses ? `Buses: ${B.esc(s.servingBuses)}` : ''}</span>
              </div>
              ${isSel ? '<span class="ms-single-sel-check" title="Selected">✓</span>' : ''}
            </div>
          `;
        }).join('');
      }

      // --- SECTION 3: MRT STATIONS (Type Tag: [MRT]) ---
      if (showTopic('mrt') && filteredMrt.length > 0) {
        const slice = filteredMrt.slice(0, maxPerCategory);
        html += `
          <div class="ms-topic-header" data-topic="mrt">
            <span>MRT Stations</span>
            <span class="ms-topic-count">${filteredMrt.length}</span>
          </div>
        `;
        html += slice.map((m) => {
          const isSel = selectedEntityIds.has(m.id);
          const mrtTag = m.code || 'MRT';
          const searchData = `mrt ${mrtTag} ${m.name} ${m.lines}`.toLowerCase();
          return `
            <div class="ms-option-row ms-entity-row ${isSel ? 'selected' : ''}" data-topic="mrt" data-entity-type="mrt" data-entity-id="${m.id}" data-search-text="${B.esc(searchData)}">
              <span class="ms-type-tag tag-mrt">${B.esc(mrtTag)}</span>
              <div class="ms-entity-content">
                <span class="ms-entity-title">${B.esc(m.name)} MRT</span>
                <span class="ms-entity-sub">${B.esc(m.lines)}</span>
              </div>
              ${isSel ? '<span class="ms-single-sel-check" title="Selected">✓</span>' : ''}
            </div>
          `;
        }).join('');
      }

      // --- SECTION 4: BUS INTERCHANGES (Type Tag: [Interchange]) ---
      if (showTopic('interchange') && filteredInterchanges.length > 0) {
        html += `
          <div class="ms-topic-header" data-topic="interchange">
            <span>Bus Interchanges</span>
            <span class="ms-topic-count">${filteredInterchanges.length}</span>
          </div>
        `;
        html += filteredInterchanges.map((it) => {
          const isSel = selectedEntityIds.has(it.id);
          const intCode = it.code || (it.obj && it.obj.code) || it.id;
          const intTag = intCode ? `INT ${intCode}` : 'INT';
          const searchData = `interchange int ${intCode} ${it.name} ${it.servingBuses}`.toLowerCase();
          return `
            <div class="ms-option-row ms-entity-row ${isSel ? 'selected' : ''}" data-topic="interchange" data-entity-type="interchange" data-entity-id="${it.id}" data-search-text="${B.esc(searchData)}">
              <span class="ms-type-tag tag-interchange">${B.esc(intTag)}</span>
              <div class="ms-entity-content">
                <span class="ms-entity-title">${B.esc(it.name)}</span>
              </div>
              ${isSel ? '<span class="ms-single-sel-check" title="Selected">✓</span>' : ''}
            </div>
          `;
        }).join('');
      }

      // --- SECTION 5: ROADS (Type Tag: [Road]) ---
      if (showTopic('road') && filteredRoads.length > 0) {
        const slice = filteredRoads.slice(0, maxPerCategory);
        html += `
          <div class="ms-topic-header" data-topic="road">
            <span>Roads</span>
            <span class="ms-topic-count">${filteredRoads.length}</span>
          </div>
        `;
        html += slice.map((r) => {
          const isSel = selectedEntityIds.has(String(r.id));
          const searchData = `road ${r.name} ${r.district}`.toLowerCase();
          return `
            <div class="ms-option-row ms-entity-row ${isSel ? 'selected' : ''}" data-topic="road" data-entity-type="road" data-entity-id="${r.id}" data-search-text="${B.esc(searchData)}">
              <div class="ms-entity-content">
                <span class="ms-entity-title">${B.esc(r.name)}</span>
                <span class="ms-entity-sub">${r.district ? `${B.esc(r.district)} · ` : ''}${r.lengthKm} km</span>
              </div>
              ${isSel ? '<span class="ms-single-sel-check" title="Selected">✓</span>' : ''}
            </div>
          `;
        }).join('');
      }

      // --- SECTION 6: POSTAL CODE & ADDRESS (No Type Tag) ---
      if (showTopic('address') && filteredAddresses.length > 0) {
        const slice = filteredAddresses.slice(0, maxPerCategory);
        html += `
          <div class="ms-topic-header" data-topic="address">
            <span>Postal & Address</span>
            <span class="ms-topic-count">${filteredAddresses.length}</span>
          </div>
        `;
        html += slice.map((a) => {
          const isSel = selectedEntityIds.has(a.id);
          const searchData = `address postal ${a.title} ${a.postalCode} ${a.road}`.toLowerCase();
          return `
            <div class="ms-option-row ms-entity-row ${isSel ? 'selected' : ''}" data-topic="address" data-entity-type="address" data-entity-id="${a.id}" data-search-text="${B.esc(searchData)}">
              <div class="ms-entity-content">
                <span class="ms-entity-title">${B.esc(a.title)}</span>
                <span class="ms-entity-sub">Postal Code: ${B.esc(a.postalCode)}</span>
              </div>
              ${isSel ? '<span class="ms-single-sel-check" title="Selected">✓</span>' : ''}
            </div>
          `;
        }).join('');
      }

      if (!html) {
        html = `<div class="ms-no-results">No results match "${B.esc(q)}"</div>`;
      }

      listContainer.innerHTML = html;

      // Wire edit pencil buttons for buses
      listContainer.querySelectorAll('.ms-bus-edit').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const row = btn.closest('.ms-option-row');
          if (row && row.dataset.busNumber) {
            c._closeBusDropdown();
            c._promptNewBus(row.dataset.busNumber);
          }
        });
      });

      // Helper for SINGLE entity selection: selects only 1 item, zooms and focuses on it
      const handleEntitySelect = (type, entityId) => {
        let item = null;
        let entObj = null;

        if (type === 'stop' || type === 'interchange') {
          item = stops.find((s) => s.id === entityId) || interchanges.find((it) => it.id === entityId);
          if (item) {
            const isInt = item.isInterchange;
            const itemCode = item.code || (item.obj && item.obj.code) || item.id;
            const tag = isInt ? (itemCode ? `INT ${itemCode}` : 'INT') : (itemCode || 'Stop');
            entObj = {
              id: item.id,
              type: isInt ? 'interchange' : 'stop',
              tagLabel: tag,
              tagClass: isInt ? 'tag-interchange' : 'tag-stop',
              title: item.name,
              name: item.name,
              subtitle: item.servingBuses ? `Buses: ${item.servingBuses}` : (item.code ? `Stop ${item.code}` : ''),
              code: item.code,
              x: item.x,
              y: item.y,
              obj: item.obj
            };
          }
        } else if (type === 'mrt') {
          item = mrt.find((m) => m.id === entityId);
          if (item) {
            const mrtTag = item.code || 'MRT';
            entObj = {
              id: item.id,
              type: 'mrt',
              tagLabel: mrtTag,
              tagClass: 'tag-mrt',
              title: item.name + ' MRT',
              name: item.name + ' MRT',
              subtitle: item.lines,
              code: item.code,
              x: item.x,
              y: item.y,
              obj: item.obj
            };
          }
        } else if (type === 'road') {
          item = roads.find((r) => String(r.id) === String(entityId));
          if (item) {
            entObj = {
              id: String(item.id),
              type: 'road',
              tagLabel: '',
              tagClass: '',
              title: item.name,
              name: item.name,
              subtitle: `${item.district || 'Central'} · ${item.lengthKm} km`,
              road: item.name,
              district: item.district,
              x: item.x,
              y: item.y,
              obj: item.obj
            };
          }
        } else if (type === 'address') {
          item = addresses.find((a) => a.id === entityId);
          if (item) {
            entObj = {
              id: item.id,
              type: 'address',
              tagLabel: '',
              tagClass: '',
              title: item.title,
              name: item.title,
              subtitle: `Postal: ${item.postalCode} · ${item.road}`,
              postalCode: item.postalCode,
              road: item.road,
              district: item.district,
              x: item.x,
              y: item.y,
              obj: { name: item.title, postalCode: item.postalCode, roadName: item.road, district: item.district, x: item.x, y: item.y }
            };
          }
        }

        if (entObj) {
          const isAlreadySelected = selectedEntityIds.has(entObj.id);

          // Clear previous bus and entity selections - single item only!
          selectedEntityIds.clear();
          if (c.clearSelectedEntities) c.clearSelectedEntities();

          const allRoutes = Object.values(store.doc.routes);
          c.selectedRouteIds = new Set(allRoutes.map((r) => r.id));
          c.isAllRoutesSelected = true;
          c._applyRouteMultiSelection();

          if (isAlreadySelected) {
            // Deselect -> reset
            clearFocusItem();
          } else {
            // Select ONLY this 1 entity!
            selectedEntityIds.add(entObj.id);
            if (c.addSelectedEntity) c.addSelectedEntity(entObj);
            if (c._glideToEntity) c._glideToEntity(entObj);
            setFocusItem({
              type: entObj.type,
              tagLabel: entObj.tagLabel,
              tagClass: entObj.tagClass,
              name: entObj.title || entObj.name
            });
          }

          c._renderRoutePills();
          c.renderer.requestRender();
          renderDropdown();
          if (!isAlreadySelected && c._closeBusDropdown) {
            c._closeBusDropdown();
          }
        }
      };

      // Helper for SINGLE bus selection: selects only 1 bus, zooms and focuses on it
      const handleBusSelect = (busNumber, ids) => {
        if (!ids.length) return;
        const allRoutes = Object.values(store.doc.routes);

        const isAlreadySelected = (!c.isAllRoutesSelected && c.selectedRouteIds.size === ids.length && ids.every((rid) => c.selectedRouteIds.has(rid)));

        // Clear any non-bus entity selections
        selectedEntityIds.clear();
        if (c.clearSelectedEntities) c.clearSelectedEntities();

        if (isAlreadySelected) {
          // Deselect -> reset to default (all routes)
          c.selectedRouteIds = new Set(allRoutes.map((r) => r.id));
          c.isAllRoutesSelected = true;
          setFocusItem(null);
          c.renderer.selected = null;
          c._hideInspector();
        } else {
          // Select ONLY this single bus!
          c.selectedRouteIds = new Set(ids);
          c.isAllRoutesSelected = false;

          const rObj = store.doc.routes[ids[0]];
          if (rObj) {
            c.renderer.selected = { type: 'route', id: ids[0], obj: rObj };
            c._showInspector(c.renderer.selected);
            if (c._focusOnRoute) c._focusOnRoute(rObj, true);
            setFocusItem({
              type: 'bus',
              tagLabel: busNumber,
              name: `Bus ${busNumber}`,
              color: rObj.color || '#2563eb'
            });
          }
        }

        c._applyRouteMultiSelection();
        c._renderRoutePills();
        c.renderer.requestRender();
        renderDropdown();
        if (!isAlreadySelected && c._closeBusDropdown) {
          c._closeBusDropdown();
        }
      };

      // Wire row clicks for single selection
      listContainer.querySelectorAll('.ms-option-row').forEach((row) => {
        const topic = row.dataset.topic;

        row.addEventListener('click', (e) => {
          e.stopPropagation();

          if (topic === 'bus') {
            const ids = (row.dataset.routeIds || '').split(',').filter(Boolean);
            const busNumber = row.dataset.busNumber;
            handleBusSelect(busNumber, ids);
          } else {
            const type = row.dataset.entityType;
            const entityId = row.dataset.entityId;
            handleEntitySelect(type, entityId);
          }
        });
      });
    };

    // Override c._updateRouteDropdown to route through our unified dropdown renderer
    c._updateRouteDropdown = function () {
      const allRoutes = Object.values(store.doc.routes);
      if (this.isAllRoutesSelected || this.selectedRouteIds.size === 0) {
        this.selectedRouteIds = new Set(allRoutes.map((r) => r.id));
        this.isAllRoutesSelected = true;
      } else {
        for (const rid of this.selectedRouteIds) {
          if (!this.store.doc.routes[rid]) this.selectedRouteIds.delete(rid);
        }
      }

      if (this.selectedRouteIds.size === allRoutes.length) {
        this.renderer.visibleRouteIds = null;
      } else {
        this.renderer.visibleRouteIds = new Set(this.selectedRouteIds);
      }

      renderDropdown();
      this._applyRouteMultiSelection();
    };

    // Override c._filterRouteDropdown for real-time search
    c._filterRouteDropdown = function (query = '') {
      searchQuery = (query || '').trim();
      if (searchClearBtn) {
        searchClearBtn.classList.toggle('hidden', !searchQuery);
      }
      renderDropdown();
    };

    // Setup Topic Filter Chips
    if (topicChipsWrap) {
      topicChipsWrap.querySelectorAll('.ms-topic-chip').forEach((chip) => {
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          topicChipsWrap.querySelectorAll('.ms-topic-chip').forEach((cEl) => cEl.classList.remove('active'));
          chip.classList.add('active');
          activeTopic = chip.dataset.topic || 'all';
          renderDropdown();
        });
      });
    }

    // Setup Search Input Realtime Listener
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        c._filterRouteDropdown(e.target.value);
      });
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !searchInput.value && c.currentFocusItem) {
          clearFocusItem();
        }
      });
    }

    if (searchClearBtn) {
      searchClearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (searchInput) {
          searchInput.value = '';
          searchInput.focus();
        }
        searchClearBtn.classList.add('hidden');
        if (c.currentFocusItem) {
          clearFocusItem();
        } else {
          c._filterRouteDropdown('');
        }
      });
    }

    // Select All / Clear All behavior for active topic or all topics
    if (selectAllChk) {
      selectAllChk.addEventListener('change', (e) => {
        const allRoutes = Object.values(store.doc.routes);
        if (e.target.checked) {
          allRoutes.forEach((r) => c.selectedRouteIds.add(r.id));
          c.isAllRoutesSelected = true;
        } else {
          c.selectedRouteIds.clear();
          c.isAllRoutesSelected = false;
        }
        c._applyRouteMultiSelection();
        renderDropdown();
        c.renderer.requestRender();
      });
    }

    if (clearAllBtn) {
      clearAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        c.selectedRouteIds.clear();
        c.isAllRoutesSelected = false;
        selectedEntityIds.clear();
        if (c.clearSelectedEntities) c.clearSelectedEntities();
        clearFocusItem();
        if (selectAllChk) selectAllChk.checked = false;
        c._applyRouteMultiSelection();
        renderDropdown();
        c.renderer.requestRender();
      });
    }

    // Expose for external calls (e.g. B.Controller)
    window.BRASS_SEARCH = {
      glideTo,
      onEntityRemoved: (id) => {
        selectedEntityIds.delete(id);
        renderDropdown();
      }
    };

    // Trigger initial render
    renderDropdown();
  };
})();
