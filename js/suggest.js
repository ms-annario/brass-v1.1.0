/* BRASS — AI map suggestions. Opening a project's map with attached documents offers to read them; the
 * changes found are drawn on the map as highlights, and a dialog asks whether to apply them all.
 * Reading is done by Claude through /api/analyze (server.py); the matching to real roads and stops is local.
 */
(function () {
  const B = window.B;

  // The AI mark: two sparkles, a big blue one and a small purple one; round joins soften the tips.
  // Set when this file loads, so the Projects page (set up before the map) can use it too
  B.AI_ICON = '<svg class="ai-chip-icon" viewBox="0 0 24 24" aria-hidden="true" stroke-linejoin="round" stroke-width="1.5">'
    + '<path d="M10 1.5Q13 7 18.5 10Q13 13 10 18.5Q7 13 1.5 10Q7 7 10 1.5Z" fill="#2196f3" stroke="#2196f3"/>'
    + '<path d="M18.5 14.5Q19.9 17.1 22.5 18.5Q19.9 19.9 18.5 22.5Q17.1 19.9 14.5 18.5Q17.1 17.1 18.5 14.5Z" fill="#7e57c2" stroke="#7e57c2"/>'
    + '</svg>';

  B.initSuggest = function (app) {
    const { store, renderer, net, city, controller: c } = app;
    const banner = document.getElementById('sg-banner');
    if (!banner) return;

    let pillCtx = null;      // the buses of the current focus; the ones not selected stay in the chip row, greyed out
    let items = [];          // resolved suggestions: { id, type, title, detail, source, status, geo, apply }
    const dismissed = new Set(); // projects whose banner was waved away this visit
    const toast = (m, k) => c._showToast && c._showToast(m, k || 'info');
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

    // ---------------------------------------------------------------- Matching the document to the map
    const stopByCode = (code) => Object.values(store.doc.stops).find((s) => String(s.code) === String(code).trim());
    const stopXY = (st) => net.posPoint({ edge: st.edge, s: st.s, dir: st.dir || 1 }, 0);
    const edgeMid = (e) => e.pts[Math.floor(e.pts.length / 2)];
    const edgesNamed = (road) => net.edges.filter((e) => e && norm(e.name) === norm(road));
    const bbox = (pts) => pts.reduce((b, p) => ({ x0: Math.min(b.x0, p.x), y0: Math.min(b.y0, p.y), x1: Math.max(b.x1, p.x), y1: Math.max(b.y1, p.y) }),
      { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });

    const resolve = (ch, i) => {
      const base = { id: 'sg' + i, ch, type: ch.type, title: ch.title || ch.type, source: ch.source || '', status: 'pending' };
      if (ch.type === 'closure') {
        let edges = ch._edgeIds ? ch._edgeIds.map((id) => net.edge(id)).filter(Boolean) : edgesNamed(ch.road);
        const stops = ch._edgeIds ? [] : (ch.between_stops || []).map(stopByCode).filter(Boolean);
        if (edges.length && stops.length) {
          const pts = stops.map(stopXY);
          const mid = { x: pts.reduce((t, p) => t + p.x, 0) / pts.length, y: pts.reduce((t, p) => t + p.y, 0) / pts.length };
          const span = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) / 2 : 0;
          edges = edges.filter((e) => Math.hypot(edgeMid(e).x - mid.x, edgeMid(e).y - mid.y) <= span + 120);
        } else if (edges.length > 8) edges = edges.slice(0, 8);
        if (!edges.length && ch._edgeIds) return { ...base, failed: 'No roads left in this closure' };
        if (!edges.length) return { ...base, failed: `Road "${ch.road}" is not on this map` };
        const ids = edges.map((e) => e.id);
        return { ...base, detail: `${ch.road}: ${ids.length} road segment${ids.length === 1 ? '' : 's'}${ch.reason ? ' · ' + ch.reason : ''}`,
          geo: { kind: 'edges', ids, bb: bbox(edges.flatMap((e) => e.pts)) },
          apply: (doc) => B.ops.setClosed(doc, ids, true, { reason: ch.reason || ch.title || 'Road closure' }) };
      }
      if (ch.type === 'area' && Array.isArray(ch.polygon) && ch.polygon.length >= 3) {
        const poly = ch._poly || ch.polygon.map((p) => ({ x: Number(p.x), y: Number(p.y) }));
        if (poly.some((p) => !isFinite(p.x) || !isFinite(p.y))) return { ...base, failed: 'The drawn area is not readable' };
        const cb = city.bounds, pb = bbox(poly);
        if (pb.x1 < cb.x0 || pb.x0 > cb.x1 || pb.y1 < cb.y0 || pb.y0 > cb.y1) return { ...base, failed: 'The drawn area is outside this map' };
        return { ...base, detail: `${ch.name || 'Drawn area'} · drawn on the map`,
          geo: { kind: 'polygon', pts: poly, bb: bbox(poly) },
          apply: (doc, id) => { doc.areas[id] = { id, name: ch.name || 'Drawn area', shape: 'polygon', pts: poly.map((p) => ({ x: p.x, y: p.y })), fromDocument: true }; } };
      }
      if (ch.type === 'area') {
        let at = ch._at || null;
        if (!at && ch.near_stop && stopByCode(ch.near_stop)) at = stopXY(stopByCode(ch.near_stop));
        else if (!at && ch.road && edgesNamed(ch.road).length) { const es = edgesNamed(ch.road); at = edgeMid(es[Math.floor(es.length / 2)]); }
        if (!at) return { ...base, failed: 'Could not place this area on the map' };
        const r = Math.max(30, Math.min(2000, Number(ch.radius_m) || 300));
        return { ...base, detail: `${ch.name || 'Affected area'} · ${Math.round(r)} m radius`,
          geo: { kind: 'circle', cx: at.x, cy: at.y, r, bb: { x0: at.x - r, y0: at.y - r, x1: at.x + r, y1: at.y + r } },
          apply: (doc, id) => { doc.areas[id] = { id, name: ch.name || 'Affected area', shape: 'circle', cx: at.x, cy: at.y, r, fromDocument: true }; } };
      }
      if (ch.type === 'stop_closed') {
        const st = stopByCode(ch.stop);
        if (!st) return { ...base, failed: `Stop ${ch.stop} is not on this map` };
        const xy = stopXY(st);
        return { ...base, detail: `${st.name} (${st.code}) not served`,
          geo: { kind: 'point', x: xy.x, y: xy.y, bb: { x0: xy.x - 150, y0: xy.y - 150, x1: xy.x + 150, y1: xy.y + 150 } },
          apply: (doc) => { if (doc.stops[st.id]) doc.stops[st.id].active = false; } };
      }
      if (ch.type === 'new_bus') {
        const num = String(ch.bus || '').trim().toUpperCase();
        if (!num) return { ...base, failed: 'No bus number for the new service' };
        const stops = (ch.stops || []).map(stopByCode).filter(Boolean);
        const pts = stops.map(stopXY);
        const geo = pts.length > 1 ? { kind: 'route', pts, bb: bbox(pts) }
          : pts.length ? { kind: 'point', x: pts[0].x, y: pts[0].y, bb: { x0: pts[0].x - 150, y0: pts[0].y - 150, x1: pts[0].x + 150, y1: pts[0].y + 150 } } : null;
        const note = stops.length > 1 ? `New service: ${stops[0].name} ➔ ${stops[stops.length - 1].name}` : 'New service: draw its route';
        // read again on a later visit: it's on the map already
        if (Object.values(store.doc.routes).some((r) => String(r.number).trim().toUpperCase() === num)) return { ...base, newBus: num, geo, note, status: 'accepted', detail: `Bus ${num} is on the map` };
        const made = {};
        return { ...base, newBus: num, geo, made, note, detail: stops.length > 1 ? `New bus ${num}: ${stops[0].name} ➔ ${stops[stops.length - 1].name}` : `New bus ${num}: draw its route`,
          // with its stops it gets its route; without, it waits to be drawn, like a bus from New Bus Number
          apply: (doc) => {
            const id = 'R' + doc.seq++;
            made.id = id;
            doc.routes[id] = {
              id, number: num, kind: 'proposed', baseId: null, override: false, fromDocument: true,
              name: stops.length > 1 ? `Bus ${num} (${stops[0].name} ➔ ${stops[stops.length - 1].name})` : `Bus ${num}`,
              color: B.pickRouteColor(Object.values(doc.routes).map((r) => r.color)),
              hours: { start: '06:00', end: '23:00' }, days: B.ALL_DAYS.slice(),
              anchors: stops.length > 1 ? stops.map((st) => ({ t: 'stop', id: st.id })) : [],
              ...(stops.length > 1 ? {} : { planned: true }),
            };
          } };
      }
      if (ch.type === 'detour') {
        const route = Object.values(store.doc.routes).find((r) => String(r.number).trim() === String(ch.bus).trim());
        if (!route) return { ...base, failed: `Bus ${ch.bus} is not on this map` };
        const pts = (route.anchors || []).filter((a) => a.t === 'stop' && store.doc.stops[a.id]).map((a) => stopXY(store.doc.stops[a.id]));
        return { ...base, detail: `Bus ${route.number}: re-route around the closure`,
          geo: { kind: 'route', pts, bb: bbox(pts) }, needsClosure: true,
          routeId: route.id, optIdx: 0, applyDetour: (idx) => c.applySuggestDetour(route.id, idx) };
      }
      return { ...base, failed: 'Unknown change' };
    };

    // Pending changes aren't drawn on the map: the banner asks about them, and AI focus shows the buses

    // The buses a change touches (checking both current route geometry and pre-detour originalAnchors)
    const stopOf = (it) => (stopByCode(it.ch.stop) || {}).id;
    const routesTouchingEdges = (edgeIds) => {
      const edgeSet = new Set(edgeIds);
      const out = [];
      for (const r of Object.values(store.doc.routes)) {
        const g = store.geom[r.id];
        if (g && g.legs && g.legs.some((l) => l.ok && (l.segs || []).some((sg) => edgeSet.has(sg.edge)))) {
          out.push(r);
          continue;
        }
        if (r.originalAnchors) {
          const og = store.computeRoute({ anchors: r.originalAnchors, kind: 'existing' });
          if (og && og.legs && og.legs.some((l) => l.ok && (l.segs || []).some((sg) => edgeSet.has(sg.edge)))) {
            out.push(r);
          }
        }
      }
      return out;
    };
    const affectedRouteIds = (it) => {
      const routes = Object.values(store.doc.routes);
      const num = (r) => String(r.number).trim();
      let hit = [];
      if (it.type === 'closure') hit = routesTouchingEdges(it.geo.ids);
      else if (it.type === 'area') hit = routesTouchingEdges(net.edgesInPolygon(it.geo.kind === 'polygon' ? it.geo.pts : B.circlePoly(it.geo.cx, it.geo.cy, it.geo.r, 32)));
      else if (it.type === 'stop_closed') { const sid = stopOf(it); hit = routes.filter((r) => (r.originalAnchors || r.anchors || []).some((a) => a.t === 'stop' && a.id === sid)); }
      else if (it.type === 'detour') { const n = String(it.ch.bus).trim(); hit = routes.filter((r) => num(r) === n); }
      else if (it.type === 'new_bus') hit = routes.filter((r) => num(r).toUpperCase() === it.newBus);
      // every piece of a bus number is one line
      const nums = new Set(hit.map(num));
      return routes.filter((r) => nums.has(num(r))).map((r) => r.id);
    };
    // Clicking a bus chip in the Filters section shows that bus's whole line; click it again to come back
    let busFocus = null;
    const lineBounds = (ids) => {
      const pts = [];
      ids.forEach((id) => {
        const g = store.geom[id];
        if (g && g.legs) g.legs.forEach((l) => (l.segs || []).forEach((sg) => { const e = net.edge(sg.edge); if (e) pts.push(edgeMid(e), e.pts[0], e.pts[e.pts.length - 1]); }));
      });
      return pts.length ? bbox(pts) : null;
    };
    document.addEventListener('click', (e) => {
      const chip = e.target.closest && e.target.closest('#route-pills-row .route-chip-btn');
      if (!chip || !pillCtx) return;
      e.stopImmediatePropagation(); e.preventDefault();
      const ids = (chip.dataset.routeIds || '').split(',').filter((id) => store.doc.routes[id]);
      if (!ids.length) return;
      const num = String(store.doc.routes[ids[0]].number).trim();
      const numOf = (r) => String(r.number).trim();
      if (busFocus === num) {
        // the focused chip again: back to every bus of the focus
        busFocus = null;
        c.selectedRouteIds = new Set(pillCtx.ids); c.isAllRoutesSelected = false;
        // a quick filter lights up again, and the map goes back to where it was before the bus
        if (pillCtx.qf) c.quickFilter = { keys: new Set(pillCtx.qf), ids: new Set(pillCtx.ids) };
        c._applyRouteMultiSelection(); c._updateRouteDropdown();
        if (pillCtx.box) renderer.fitToBounds(pillCtx.box, { left: 340, right: 350, top: 90, bottom: 90 }, { maxZoom: 1.2, minSize: 900 });
        else if (pillCtx.cam) { renderer.cameraAnim = null; Object.assign(renderer.camera, pillCtx.cam); renderer.requestRender(); }
        renderer.selected = null; c._hideInspector();
        draw(); return;
      }
      if (!busFocus && !pillCtx.box) pillCtx.cam = { x: renderer.camera.x, y: renderer.camera.y, zoom: renderer.camera.zoom };
      busFocus = num;
      c.selectedRouteIds = new Set(Object.values(store.doc.routes).filter((r) => numOf(r) === num).map((r) => r.id));
      c.isAllRoutesSelected = false;
      c._applyRouteMultiSelection(); c._updateRouteDropdown();
      // its card on the right, with what the documents suggest for it
      renderer.selected = { type: 'route', id: ids[0] };
      c._showInspector(renderer.selected);
      const bb = lineBounds(ids);
      if (bb) renderer.fitToBounds(bb, { left: 340, right: 350, top: 90, bottom: 90 }, { maxZoom: 1.2, minSize: 800 });
      draw();
    }, true);

    // The quick filters (Affected area, Fragmented routes, In view) focus their buses the same way as AI focus
    // Off, the focus it replaced (AI focus, say) comes back with the selection
    let pillBefore;
    B.setPillFocus = (ids, qf, box = null) => {
      busFocus = null;
      if (ids) {
        if (pillBefore === undefined) pillBefore = pillCtx;
        pillCtx = { ids: new Set(ids), box, qf };
      } else {
        pillCtx = pillBefore || null;
        pillBefore = undefined;
      }
    };

    // The other buses of the focus stay in the chip row, greyed out; clicking one focuses it
    const pillRow = document.getElementById('route-pills-row');
    const addDimChips = () => {
      if (!pillRow || !pillCtx) return;
      const sel = c.selectedRouteIds;
      const inFocus = sel.size && [...sel].every((id) => pillCtx.ids.has(id)); // otherwise some other filter is in charge
      const numOf = (id) => String(store.doc.routes[id].number).trim();
      const shown = new Set([...pillRow.querySelectorAll('.route-chip-btn:not(.is-dim)')].map((b) => numOf((b.dataset.routeIds || '').split(',')[0])));
      const byNum = new Map();
      if (inFocus) [...pillCtx.ids].filter((id) => store.doc.routes[id]).forEach((id) => { const n = numOf(id); if (!byNum.has(n)) byNum.set(n, []); byNum.get(n).push(id); });
      const want = [...byNum.entries()].filter(([n]) => !shown.has(n)).sort((x, y) => x[0].localeCompare(y[0], undefined, { numeric: true }));
      // the same warning as a selected chip, for a bus a closure or area still affects
      const warn = (ids) => ids.some((id) => c.isRouteAffected(id));
      const key = (ids) => `${ids.join(',')}${warn(ids) ? '!' : ''}`;
      const have = [...pillRow.querySelectorAll('.route-chip-btn.is-dim')].map((b) => `${b.dataset.routeIds}${b.dataset.warn ? '!' : ''}`);
      if (JSON.stringify(have) === JSON.stringify(want.map(([, ids]) => key(ids)))) return; // already right: change nothing, so the observer settles
      pillRow.querySelectorAll('.route-chip-btn.is-dim').forEach((b) => b.remove());
      want.forEach(([n, ids]) => {
        const b = document.createElement('button');
        const w = warn(ids);
        b.type = 'button'; b.className = 'route-chip-btn is-dim'; b.dataset.routeIds = ids.join(',');
        if (w) b.dataset.warn = '1';
        b.title = `Show Bus ${n}`;
        b.innerHTML = `<span>${n}</span>`;
        pillRow.appendChild(b);
      });
    };
    if (pillRow) new MutationObserver(() => addDimChips()).observe(pillRow, { childList: true });

    // "AI focus" chip in the quick filters, labelled Affected area (with the AI mark): only the buses the
    // documents' changes touch, zoomed to where they are
    let drawnAreas = [];
    let lastAi = null; // what the last analysis touched, kept after the suggestions card is closed
    let docAreaNames = []; // the areas the documents drew (by name), for Restore
    const aiByProject = new Map(); // the same per project, so reopening its map brings its AI focus back
    const aiRouteIds = (onlyDrawn) => {
      if (!items.length && !drawnAreas.length) return lastAi ? lastAi.ids.filter((id) => store.doc.routes[id]) : [];
      const set = new Set();
      if (!onlyDrawn) items.forEach((it) => { if (it.geo && it.status !== 'rejected') affectedRouteIds(it).forEach((id) => set.add(id)); });
      drawnAreas.forEach((g) => routesTouchingEdges(net.edgesInPolygon(g.pts)).forEach((r) => set.add(r.id)));
      Object.values(store.doc.routes).forEach((r) => { if (r.fromAiSuggest) set.add(r.id); });
      const nums = new Set([...set].filter((id) => store.doc.routes[id]).map((id) => String(store.doc.routes[id].number).trim()));
      return Object.values(store.doc.routes).filter((r) => nums.has(String(r.number).trim())).map((r) => r.id);
    };
    const aiBox = (onlyDrawn) => {
      if (!items.length && !drawnAreas.length) return lastAi ? lastAi.box : null;
      const bbs = [...(onlyDrawn ? [] : items.filter((x) => x.geo && x.status !== 'rejected').map((x) => x.geo.bb)), ...drawnAreas.map((g) => g.bb)];
      return bbs.length ? bbs.reduce((b, x) => ({ x0: Math.min(b.x0, x.x0), y0: Math.min(b.y0, x.y0), x1: Math.max(b.x1, x.x1), y1: Math.max(b.y1, x.y1) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }) : null;
    };
    const aiTip = 'Show only the buses the documents\' changes affect, zoomed to where they are';
    const AI_ICON = B.AI_ICON;
    // The chip is drawn by the controller with the other quick filters (so it can be on with them); this keeps
    // what it lists up to date, per project
    // What the documents' changes did to one bus, as short lines: added as a new service, a road closed or a
    // stop no longer served on its route (as it was before any detour), and the reroute still to do
    // Whether a document's change is on the map now (so Undo, a reload or Not now never leave the card out of step)
    const onMapNow = (it) => {
      if (it.failed) return false;
      const d = store.doc;
      if (it.type === 'closure') return !!it.geo && it.geo.ids.some((id) => d.closures[id]);
      if (it.type === 'stop_closed') { const st = stopByCode(it.ch.stop); return !!st && !!d.stops[st.id] && d.stops[st.id].active === false; }
      if (it.type === 'new_bus') return Object.values(d.routes).some((r) => r.fromDocument && String(r.number).trim().toUpperCase() === it.newBus);
      if (it.type === 'detour') {
        const r = d.routes[it.routeId] || Object.values(d.routes).find((x) => String(x.number).trim() === String(it.ch.bus).trim());
        return !!r && !!r.detourApplied;
      }
      return false;
    };
    const busChanges = (num, list) => {
      num = String(num).trim().toUpperCase();
      const routes = Object.values(store.doc.routes).filter((r) => String(r.number).trim().toUpperCase() === num);
      if (!routes.length) return [];
      const live = list.filter((it) => (it.type === 'detour' ? !it.failed && it.status !== 'rejected' : onMapNow(it)));
      let edges = null;
      const stops = new Set();
      const onRoute = () => {
        if (edges) return edges;
        edges = new Set();
        routes.forEach((r) => {
          const anchors = r.originalAnchors || r.anchors || [];
          anchors.forEach((a) => { if (a.t === 'stop') stops.add(a.id); });
          // a detoured bus: its route before the detour; any other: the route it runs now
          const g = r.originalAnchors ? store.computeRoute({ anchors, kind: 'existing' }) : store.geom[r.id];
          ((g && g.legs) || []).forEach((l) => { if (l.ok && l.segs) l.segs.forEach((sg) => edges.add(sg.edge)); });
        });
        return edges;
      };
      const added = [], roads = [], closedStops = [], todo = [];
      const detouredRoute = routes.find((r) => r.detourApplied);
      live.forEach((it) => {
        if (it.type === 'new_bus' && it.newBus === num) {
          const st = (it.ch.stops || []).map(stopByCode).filter(Boolean);
          added.push('Added as a new service', st.length > 1 ? `${st.length} stops: ${st[0].name} ➔ ${st[st.length - 1].name}` : 'Route still to draw');
        } else if (it.type === 'closure' && it.geo && it.geo.ids.some((e) => onRoute().has(e))) {
          roads.push(`${it.ch.road} closed on its route`);
        } else if (it.type === 'stop_closed') {
          onRoute();
          const st = stopByCode(it.ch.stop);
          if (st && stops.has(st.id)) closedStops.push(`${st.name} (${st.code}) no longer served`);
        } else if (it.type === 'detour' && String(it.ch.bus).trim().toUpperCase() === num) {
          todo.push(detouredRoute
            ? `AI detour applied: ${detouredRoute.viaName || 'Best option'} (Best option)`
            : 'To do: reroute around the closure');
        }
      });
      if (!todo.length && detouredRoute) {
        todo.push(`AI detour applied: ${detouredRoute.viaName || 'Best option'} (Best option)`);
      }
      return [...added, ...roads, ...closedStops, ...todo];
    };
    // Restore: undo every change the documents made in this project, as one step (Undo brings it all back).
    // Buses detoured around them go back to their own routes once nothing blocks them. The requirement's
    // buses stay in the AI chip, as after Not now
    const docItems = () => (items.length ? items : (lastAi && lastAi.items) || []);
    const restorable = () => docItems().some(onMapNow)
      || Object.values(store.doc.areas || {}).some((a) => docAreaNames.includes(a.name))
      || Object.values(store.doc.routes || {}).some((r) => r.fromAiSuggest && r.originalAnchors);
    const restoreAll = () => {
      const list = docItems().filter(onMapNow);
      const areaNames = new Set(docAreaNames);
      docItems().forEach((it) => { if (it.type === 'area' && !it.failed && it.ch.name) areaNames.add(it.ch.name); });
      store.commit('Restore the changes made by AI', (doc) => {
        list.forEach((it) => {
          if (it.type === 'closure' && it.geo) B.ops.setClosed(doc, it.geo.ids, false);
          else if (it.type === 'stop_closed') { const st = stopByCode(it.ch.stop); if (st && doc.stops[st.id]) delete doc.stops[st.id].active; }
          else if (it.type === 'new_bus') Object.values(doc.routes).filter((r) => r.fromDocument && String(r.number).trim().toUpperCase() === it.newBus).forEach((r) => { delete doc.routes[r.id]; });
        });
        for (const r of Object.values(doc.routes || {})) {
          if (r.originalAnchors && (r.fromAiSuggest || list.some((it) => it.type === 'detour' && String(it.ch.bus).trim() === String(r.number).trim()))) {
            r.anchors = JSON.parse(JSON.stringify(r.originalAnchors));
            delete r.originalAnchors;
            delete r.detourApplied;
            delete r.viaName;
            delete r.detourTitle;
            delete r.activeOptionIdx;
            delete r.fromAiSuggest;
            delete r.constraintBypassOnly;
            const firstStop = doc.stops[r.anchors[0]?.id];
            const lastStop = doc.stops[r.anchors[r.anchors.length - 1]?.id];
            if (firstStop && lastStop) r.name = `Bus ${r.number} (${firstStop.name} ➔ ${lastStop.name})`;
          }
        }
        for (const [id, a] of Object.entries(doc.areas || {})) if (areaNames.has(a.name)) delete doc.areas[id];
      });
      docItems().forEach((it) => { it.status = 'rejected'; });
      drawnAreas = [];
      c._updateUIState();
      const sel = renderer.selected;
      if (sel && sel.type === 'route' && store.doc.routes[sel.id]) c._showInspector(sel); else { renderer.selected = null; c._hideInspector(); }
      draw();
      toast('Changes made by AI restored', 'info');
    };

    // Restore a single route only (leaves road closures, affected areas, and other bus detours intact)
    const restorableRoute = (numOrId) => {
      if (!numOrId) return false;
      const routes = Object.values(store.doc.routes);
      const target = routes.find((r) => r.id === numOrId || String(r.number).trim().toUpperCase() === String(numOrId).trim().toUpperCase());
      if (!target) return false;
      const num = String(target.number).trim().toUpperCase();
      const matching = routes.filter((r) => String(r.number).trim().toUpperCase() === num);
      if (matching.some((r) => r.originalAnchors || r.detourApplied || r.fromDocument || r.fromAiSuggest)) return true;
      const dItems = docItems();
      return dItems.some((it) => !it.failed && it.status !== 'rejected' && (
        (it.type === 'detour' && String(it.ch.bus).trim().toUpperCase() === num) ||
        (it.type === 'new_bus' && String(it.newBus).trim().toUpperCase() === num)
      ));
    };

    const restoreRoute = (numOrId) => {
      if (!numOrId) return;
      const routes = Object.values(store.doc.routes);
      const target = routes.find((r) => r.id === numOrId || String(r.number).trim().toUpperCase() === String(numOrId).trim().toUpperCase());
      if (!target) return;
      const num = String(target.number).trim().toUpperCase();
      const matching = routes.filter((r) => String(r.number).trim().toUpperCase() === num);

      store.commit(`Restore changes for Bus ${target.number}`, (doc) => {
        if (target.fromDocument) {
          matching.forEach((r) => { delete doc.routes[r.id]; });
        } else {
          for (const r of matching) {
            const docR = doc.routes[r.id];
            if (docR && docR.originalAnchors) {
              docR.anchors = JSON.parse(JSON.stringify(docR.originalAnchors));
              delete docR.originalAnchors;
              delete docR.detourApplied;
              delete docR.viaName;
              delete docR.detourTitle;
              delete docR.activeOptionIdx;
              delete docR.fromAiSuggest;
              delete docR.constraintBypassOnly;
              const firstStop = doc.stops[docR.anchors[0]?.id];
              const lastStop = doc.stops[docR.anchors[docR.anchors.length - 1]?.id];
              if (firstStop && lastStop) {
                docR.name = `Bus ${docR.number} (${firstStop.name} ➔ ${lastStop.name})`;
              }
            }
          }
        }
      });

      docItems().forEach((it) => {
        if (!it.failed && (
          (it.type === 'detour' && String(it.ch.bus).trim().toUpperCase() === num) ||
          (it.type === 'new_bus' && String(it.newBus).trim().toUpperCase() === num)
        )) {
          it.status = 'rejected';
        }
      });

      c._updateUIState();
      const sel = renderer.selected;
      if (sel && sel.type === 'route' && store.doc.routes[sel.id]) {
        c._showInspector(sel);
      } else {
        renderer.selected = null;
        c._hideInspector();
      }
      draw();
      toast(`Changes for Bus ${target.number} restored`, 'info');
    };

    B.aiFocus = {
      ids: () => aiRouteIds(), box: () => aiBox(), tip: aiTip,
      notes: (num) => busChanges(num, docItems()),
      restorable, restore: restoreAll,
      restorableRoute, restoreRoute,
    };
    const syncChip = () => {
      if (items.length || drawnAreas.length) { lastAi = { ids: aiRouteIds(), box: aiBox(), items: items.slice(), areaNames: docAreaNames.slice() }; aiByProject.set(c.activeProjectId, lastAi); }
      if (c._renderQuickFilters) c._renderQuickFilters();
    };
    setTimeout(syncChip, 0);

    // After applying: the AI chip on, zoomed to everything that changes
    const focusAi = () => {
      const box = aiBox();
      busFocus = null;
      if (aiRouteIds().length) c._applyQuickFilters(new Set(['aifocus']));
      if (box) renderer.fitToBounds(box, { left: 340, right: 350, top: 90, bottom: 90 }, { maxZoom: 1.2, minSize: 900 });
      draw();
    };

    // One line in the banner: make the changes the documents ask for, or not
    const btns = banner.querySelector('.sg-btns');
    const askBanner = (msg, yes, bullets = []) => new Promise((res) => {
      say(AI_ICON + esc(msg));
      btns.querySelector('[data-act=yes]').textContent = yes;
      btns.hidden = false;
      const card = banner.querySelector('#sg-note-card');
      const list = banner.querySelector('#sg-notes-list');
      if (card && list && bullets && bullets.length) {
        banner.classList.add('has-notes');
        card.hidden = false;
        list.innerHTML = bullets.map((b) => `<li>${esc(b)}</li>`).join('');
      } else if (card) {
        banner.classList.remove('has-notes');
        card.hidden = true;
      }
      const done = (r) => {
        let finalNotes = [];
        if (list && r) {
          finalNotes = Array.from(list.querySelectorAll('li'))
            .map((li) => li.textContent.trim())
            .filter(Boolean);
          if (!finalNotes.length && list.textContent.trim()) {
            finalNotes = list.textContent.split('\n').map((s) => s.trim()).filter(Boolean);
          }
        }
        banner.hidden = true;
        banner.classList.remove('has-notes');
        btns.hidden = true;
        if (card) card.hidden = true;
        btns.onclick = null;
        document.removeEventListener('keydown', onKey, true);
        res(r ? { ok: true, notes: finalNotes } : false);
      };
      const onKey = (e) => {
        if (e.target && e.target.closest && e.target.closest('#sg-notes-list')) {
          if (e.key === 'Escape') e.target.blur();
          return;
        }
        if (e.key === 'Escape') { e.stopPropagation(); done(false); }
      };
      btns.onclick = (e) => { const b = e.target.closest('[data-act]'); if (b) done(b.dataset.act === 'yes'); };
      document.addEventListener('keydown', onKey, true);
      btns.querySelector('[data-act=yes]').focus({ preventScroll: true });
    });
    const onMap = (g) => Object.values(store.doc.areas || {}).some((a) => a.shape === 'polygon' && a.name === g.name &&
      a.pts.length === g.pts.length && a.pts.every((p, k) => p.x === g.pts[k].x && p.y === g.pts[k].y));

    // Apply the AI detour "Best option" (index 0) to every affected/disrupted bus route
    const applyAllBestDetours = (detourItems) => {
      const targetIds = new Set();
      (detourItems || []).forEach((it) => {
        if (it.routeId && store.doc.routes[it.routeId]) targetIds.add(it.routeId);
        const n = String(it.ch && it.ch.bus || '').trim();
        if (n) Object.values(store.doc.routes).filter((r) => String(r.number).trim() === n).forEach((r) => targetIds.add(r.id));
      });
      aiRouteIds().forEach((id) => {
        const r = store.doc.routes[id];
        if (r && !r.fromDocument && c.isRouteAffected(id)) targetIds.add(id);
      });
      Object.values(store.doc.routes).forEach((r) => {
        if (!r.fromDocument && c.isRouteAffected(r.id)) targetIds.add(r.id);
      });

      const appliedRouteIds = [];
      const seenBase = new Set();
      for (const rid of targetIds) {
        const r = store.doc.routes[rid];
        if (!r) continue;
        const baseId = (r.kind === 'proposed' && r.baseId) ? r.baseId : r.id;
        if (seenBase.has(baseId)) continue;
        seenBase.add(baseId);
        const chosen = c.applySuggestDetour(baseId, 0, { silentToast: true, skipCenter: true, fromAiSuggest: true });
        if (chosen) appliedRouteIds.push(baseId);
      }
      (detourItems || []).forEach((it) => { it.status = 'accepted'; });
      return appliedRouteIds;
    };

    const runFlow = async (drawn, summary = '') => {
      // a change the map already has (from an earlier read) counts as done, so only new ones are asked about
      items.forEach((it) => { if (it.status === 'pending' && onMapNow(it)) it.status = 'accepted'; });
      const pend = items.filter((it) => it.status === 'pending' && !it.failed);
      const roadStops = pend.filter((it) => it.type !== 'detour');
      const detours = pend.filter((it) => it.type === 'detour');
      drawnAreas = drawn.map((d) => d.geo);
      // An area drawn in an attached file (a polygon) goes on the map straight away, without asking;
      // fromDocument is what lets the file's tag in Projects read "Applied"
      drawn.forEach((d) => {
        store.commit('Draw area: ' + d.name, (doc) => { doc.areas[store.newId('A')] = { id: '', name: d.name, shape: 'polygon', pts: d.pts.map((p) => ({ x: p.x, y: p.y })), fromDocument: true }; });
      });
      // the ids inside need to match their keys
      if (drawn.length) { store.commit('Tidy areas', (doc) => { for (const [k, a] of Object.entries(doc.areas)) a.id = k; }); c._updateUIState(); c._markChangesNew(); }
      const needsPrompt = roadStops.length > 0 || detours.length > 0 || (drawn.length > 0 && aiRouteIds().some((id) => c.isRouteAffected(id)));
      if (needsPrompt) {
        const bbs = drawn.length ? drawn.map((d) => d.geo.bb) : [...roadStops, ...detours].filter((it) => it.geo).map((it) => it.geo.bb);
        if (bbs.length) {
          const box = bbs.reduce((b, x) => ({ x0: Math.min(b.x0, x.x0), y0: Math.min(b.y0, x.y0), x1: Math.max(b.x1, x.x1), y1: Math.max(b.y1, x.y1) }));
          renderer.fitToBounds(box, { left: 340, right: 350, top: 140, bottom: 90 }, { maxZoom: 1.2, minSize: 900 });
        }
      }

      // Build short summary bullet points of changes from documents
      const bullets = [];
      roadStops.filter((it) => it.type === 'closure').forEach((it) => {
        let text = it.title || `Close ${it.ch.road || 'road'}`;
        if (it.ch && it.ch.reason) text += ` (${it.ch.reason})`;
        bullets.push(text);
      });
      roadStops.filter((it) => it.type === 'stop_closed').forEach((it) => {
        bullets.push(it.title || 'Stop closed');
      });
      detours.forEach((it) => {
        const busNum = (it.ch && it.ch.bus) ? `Bus ${it.ch.bus}` : 'Bus';
        bullets.push(`Re-route ${busNum} around closure`);
      });
      roadStops.filter((it) => it.type === 'new_bus').forEach((it) => {
        let text = it.title || `New bus ${it.newBus || ''}`;
        if (it.ch && it.ch.stops && it.ch.stops.length > 1) {
          text += ` (${it.ch.stops.length} stops)`;
        }
        bullets.push(text);
      });
      roadStops.filter((it) => it.type === 'area').forEach((it) => {
        bullets.push(it.title || it.detail || 'Works zone');
      });
      (drawn || []).forEach((d) => {
        bullets.push(`Drawn area: ${d.name || 'Custom area'}`);
      });
      if (!bullets.length && summary) {
        summary.split(/[;\n]/).map((s) => s.trim()).filter(Boolean).forEach((s) => bullets.push(s));
      }
      if (!bullets.length) {
        bullets.push('Apply requested document changes to map');
      }

      let confirmedNotes = bullets;
      if (needsPrompt) {
        const ans = await askBanner('Would you like to apply the changes requested in the documents?', 'Make changes', bullets);
        if (!ans) {
          roadStops.forEach((it) => { it.status = 'rejected'; });
          detours.forEach((it) => { it.status = 'focus'; });
          draw();
          return;
        }
        if (ans.notes && ans.notes.length) confirmedNotes = ans.notes;
      }

      roadStops.forEach(accept);
      const detouredIds = applyAllBestDetours(detours);
      c._updateUIState();

      // Persist the note to project and doc
      if (c.activeProjectId) {
        const proj = (c.projects || []).find((p) => p.id === c.activeProjectId);
        if (proj) {
          proj.summaryNotes = confirmedNotes;
          if (c._saveProjects) c._saveProjects();
        }
        try {
          localStorage.setItem('brass_proj_summary_' + c.activeProjectId, JSON.stringify(confirmedNotes));
        } catch (e) {}
      }
      store.commit('Apply document changes', (doc) => {
        doc.summaryNotes = confirmedNotes;
      });

      // View Changes gets a red dot until it's opened
      if (roadStops.length || detouredIds.length) c._markChangesNew();
      if (!drawn.length && !roadStops.length && !detours.length && !detouredIds.length) { toast('No map changes found', 'info'); return; }
      focusAi();
      openFirstBus(detouredIds);
      if (detouredIds.length) {
        toast(`Applied changes · ${detouredIds.length} bus route${detouredIds.length === 1 ? '' : 's'} using AI Best option`, 'success');
      }
    };

    // Keep all affected bus routes selected on the map while opening the first detoured route in the sidebar
    const openFirstBus = (detouredIds = []) => {
      const firstId = detouredIds.find((id) => store.doc.routes[id]) || aiRouteIds().find((id) => store.doc.routes[id]);
      if (!firstId) return;
      renderer.selected = { type: 'route', id: firstId, obj: store.doc.routes[firstId] };
      c._showInspector(renderer.selected);
      renderer.requestRender();
    };

    // ---------------------------------------------------------------- Pending changes
    const pending = () => items.filter((it) => it.status === 'pending' && !it.failed);
    const syncBlocked = () => {
      const set = new Set();
      items.forEach((it) => {
        if (it.status === 'rejected' || it.failed || !it.geo) return;
        if (it.geo.kind === 'polygon') net.edgesInPolygon(it.geo.pts).forEach((id) => set.add(id));
        else if (it.geo.kind === 'edges') it.geo.ids.forEach((id) => set.add(id));
        else if (it.geo.kind === 'circle') net.edgesInPolygon(B.circlePoly(it.geo.cx, it.geo.cy, it.geo.r, 32)).forEach((id) => set.add(id));
      });
      store.suggestBlocked = set.size ? set : null;
    };
    const draw = () => {
      syncBlocked();
      setTimeout(syncChip, 0);
      renderer.requestRender();
    };

    const accept = (it) => {
      if (it.status !== 'pending') return;
      if (it.applyDetour) {
        const rid = it.routeId, snap = JSON.stringify(store.doc.routes[rid]);
        it.revert = () => store.commit('Undo AI suggestion: ' + it.title, (doc) => { doc.routes[rid] = JSON.parse(snap); });
        const rt = store.doc.routes[rid], bs = (rt && rt.kind === 'proposed' && rt.baseId) ? rt.baseId : rid;
        if (!(c._rankedDetourOptions(bs) || []).length) return toast('No detour needed or possible', 'warn');
        it.applyDetour(it.optIdx || 0);
      } else {
        const aid = store.newId('A');
        const prev = it.type === 'stop_closed' ? (store.doc.stops[stopOf(it)] || {}).active : undefined;
        store.commit('AI suggestion: ' + it.title, (doc) => it.apply(doc, aid));
        it.revert = () => store.commit('Undo AI suggestion: ' + it.title, (doc) => {
          if (it.type === 'closure') B.ops.setClosed(doc, it.geo.ids, false);
          else if (it.type === 'area') delete doc.areas[aid];
          else if (it.type === 'new_bus') delete doc.routes[it.made.id];
          else if (doc.stops[stopOf(it)]) { if (prev === undefined) delete doc.stops[stopOf(it)].active; else doc.stops[stopOf(it)].active = prev; }
        });
      }
      it.status = 'accepted';
      c._updateUIState();
      draw();
    };
    // ---------------------------------------------------------------- Reading the documents
    // A polygon file made elsewhere (GeoJSON, longitude/latitude) becomes the same kind of drawing the sketch tool saves
    const geoPolygons = (g, out = []) => {
      if (!g) return out;
      if (g.type === 'FeatureCollection') (g.features || []).forEach((f) => geoPolygons(f, out));
      else if (g.type === 'Feature') geoPolygons(Object.assign({}, g.geometry, { _name: g.properties && (g.properties.name || g.properties.Name) }), out);
      else if (g.type === 'GeometryCollection') (g.geometries || []).forEach((x) => geoPolygons(x, out));
      else if (g.type === 'Polygon' && g.coordinates && g.coordinates[0]) out.push({ ring: g.coordinates[0], name: g._name });
      else if (g.type === 'MultiPolygon') (g.coordinates || []).forEach((c0) => c0[0] && out.push({ ring: c0[0], name: g._name }));
      return out;
    };
    const asDrawings = (name, text) => {
      let j;
      try { j = JSON.parse(text); } catch (e) { return null; }
      const polys = geoPolygons(j).slice(0, 10);
      if (!polys.length) return null;
      const base = name.replace(/\.[^.]+$/, '');
      return polys.map((p, i) => {
        let ring = p.ring.map(([lon, lat]) => B.lonLatToMap(lon, lat));
        if (ring.length > 3 && ring[0].x === ring[ring.length - 1].x && ring[0].y === ring[ring.length - 1].y) ring = ring.slice(0, -1);
        const info = B.describeArea(ring);
        const nm = p.name || (polys.length > 1 ? `${base} ${i + 1}` : base);
        return { name: `${nm}.json`, text: JSON.stringify({ kind: 'brass-area-drawing', name: nm, polygon: ring.map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) })), roads: info.roads, stops: info.stops }) };
      });
    };

    const readDoc = (d) => new Promise((res) => {
      const isPdf = d.type === 'application/pdf' || /\.pdf$/i.test(d.name);
      const fr = new FileReader();
      fr.onerror = () => res(null);
      if (isPdf) { fr.onload = () => res({ name: d.name, pdf: String(fr.result).split(',')[1] }); fr.readAsDataURL(d.blob); }
      else if (/^text\/|json|markdown/.test(d.type) || /\.(md|txt|csv|json|geojson)$/i.test(d.name)) { fr.onload = () => res(asDrawings(d.name, String(fr.result)) || { name: d.name, text: String(fr.result) }); fr.readAsText(d.blob); }
      else res(null);
    });

    // Stand-in for the AI while it isn't connected: reads the same kind of notice with plain rules
    // (road names found on the map, "| Stop | 12345 | Closed |" rows, "| 886 | Divert ..." rows, "300 m" zones)
    const roadNames = (() => { const m = new Map(); net.edges.forEach((e) => { if (e && e.name && !m.has(norm(e.name))) m.set(norm(e.name), e.name); }); return m; })();
    const demoAnalyze = (text) => {
      let drawing = null;
      try { const j = JSON.parse(text); if (j && j.kind === 'brass-area-drawing') drawing = j; } catch (e) { /* not a drawing */ }
      if (drawing) {
        return { summary: `${drawing.name || 'Area drawing'}: ${drawing.roads.length} roads, ${drawing.stops.length} stops inside`,
          changes: [{ type: 'area', title: drawing.name || 'Drawn area', name: drawing.name || 'Drawn area', polygon: drawing.polygon,
            source: `Drawn area: ${drawing.roads.slice(0, 3).join(', ')}${drawing.roads.length > 3 ? '…' : ''}` }] };
      }
      const lines = text.split('\n'), changes = [], norml = (l) => norm(l);
      const rows = lines.filter((l) => /^\|/.test(l)).map((l) => l.split('|').map((x) => x.trim()).filter(Boolean));
      const stopRows = rows.filter((r) => /^\d{4,6}$/.test(r[1] || '')).map((r) => ({ name: r[0], code: r[1], status: r.slice(2).join(' ') }));
      let road = null, roadLine = '';
      for (const l of lines) {
        if (!/clos/i.test(l)) continue;
        const nl = norml(l);
        for (const [k, name] of roadNames) if (nl.includes(k) && (!road || name.length > road.length)) { road = name; roadLine = l; }
        if (road) break;
      }
      const betweenLine = road ? (lines.find((l) => /between/i.test(l) && norml(l).includes(norm(road))) || roadLine) : '';
      const between = road ? stopRows.filter((r) => norml(betweenLine).includes(norm(r.name))).map((r) => r.code).slice(0, 2) : [];
      const reason = (text.match(/Reason:\*{0,2}\s*([^\n]+)/i) || [])[1];
      if (road) changes.push({ type: 'closure', title: `Close ${road}`, road, between_stops: between, reason: reason && reason.slice(0, 60), source: roadLine.replace(/[*#-]/g, '').trim().slice(0, 120) });
      const zone = lines.find((l) => /(zone|area)/i.test(l) && /(\d+)\s*m\b/.test(l) && !/^\|/.test(l));
      const closedStops = stopRows.filter((r) => /closed|not served/i.test(r.status));
      if (zone) {
        const radius = Number((zone.match(/(\d+)\s*m\b/) || [])[1]) || 300;
        const at = (closedStops[0] || stopRows.find((r) => between.includes(r.code)) || {}).code;
        changes.push({ type: 'area', title: 'Works zone', name: road ? `${road} works zone` : 'Works zone', near_stop: at, road: at ? undefined : road, radius_m: radius, source: zone.replace(/[*#-]/g, '').trim().slice(0, 120) });
      }
      closedStops.forEach((r) => changes.push({ type: 'stop_closed', title: `${r.name} not served`, stop: r.code, source: `${r.name} (${r.code}): ${r.status}`.slice(0, 120) }));
      rows.filter((r) => /^\d{1,3}[A-Za-z]?$/.test(r[0] || '') && /divert|re-?route/i.test(r[1] || '')).forEach((r) =>
        changes.push({ type: 'detour', title: `Re-route bus ${r[0]}`, bus: r[0], source: `Bus ${r[0]}: ${r[1]}`.slice(0, 120) }));
      // A service named in several places (summary, its own section) keeps the mention that lists the most stops
      lines.forEach((l, i) => {
        const m = l.match(/new\s+(?:bus\s+)?service\s+(?:number\s+)?([0-9]{1,3}[A-Za-z]?)\b/i);
        if (!m) return;
        const bus = m[1].toUpperCase();
        const end = lines.findIndex((x, k) => k > i && /^#{1,6}\s/.test(x));
        const stops = [...new Set(lines.slice(i, end < 0 ? undefined : end).join('\n').match(/\b\d{5}\b/g) || [])];
        const source = l.replace(/[*#|-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
        const had = changes.find((ch) => ch.type === 'new_bus' && ch.bus === bus);
        if (!had) changes.push({ type: 'new_bus', title: `New bus ${bus}`, bus, stops, source });
        else if (stops.length > had.stops.length) Object.assign(had, { stops, source });
      });
      return { summary: (text.match(/^#\s*(.+)$/m) || [])[1] || 'Changes found in the document', changes };
    };

    // An area drawn on the map is the exact one: it replaces a round zone the notice only describes in words
    const merge = (changes) => {
      const drawn = changes.some((ch) => ch.type === 'area' && Array.isArray(ch.polygon));
      return drawn ? changes.filter((ch) => ch.type !== 'area' || Array.isArray(ch.polygon)) : changes;
    };

    const say = (html, busy) => {
      banner.hidden = false;
      banner.classList.remove('has-notes');
      btns.hidden = true;
      const card = banner.querySelector('#sg-note-card');
      if (card) card.hidden = true;
      banner.querySelector('.sg-msg').innerHTML = html;
      banner.classList.toggle('busy', !!busy);
    };

    const analyze = async (docs, projectId) => {
      say('Reading the documents…', true);
      const sent = (await Promise.all(docs.map(readDoc))).flat().filter(Boolean);
      if (!sent.length) { return say('These files can\'t be read. Use text, Markdown or PDF.'); }
      try {
        const res = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documents: sent }) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'failed');
        B.suggest.load(merge(data.changes || []), data.summary);
        dismissed.add(projectId);
      } catch (e) {
        // No AI connected: use the stand-in reader on the text documents
        const texts = sent.filter((d) => d.text);
        if (!texts.length) { return say('PDFs need the AI. Use a text or Markdown file.'); }
        const found = texts.map((d) => demoAnalyze(d.text));
        B.suggest.load(merge(found.flatMap((f) => f.changes)), found.map((f) => f.summary).join('; '));
        dismissed.add(projectId);
      }
    };

    // Called with changes in the shape the server returns
    B.suggest = {
      load(changes, summary) {
        banner.hidden = true;
        const isDrawn = (ch) => ch.type === 'area' && Array.isArray(ch.polygon);
        docAreaNames = changes.filter(isDrawn).map((ch) => ch.name || 'Drawn area');
        drawnAreas = [];
        const drawn = [];
        changes.filter(isDrawn).forEach((ch, i) => {
          const it = resolve(ch, 100 + i);
          if (it.failed) return toast(it.failed, 'warn');
          const g = { name: ch.name || 'Drawn area', pts: it.geo.pts };
          if (onMap(g)) { drawnAreas.push(it.geo); return; } // already on the map
          drawn.push({ ...g, geo: it.geo, label: `${g.name} · ${it.source ? it.source.replace(/^Drawn area:\s*/, '') : 'drawn on the map'}` });
        });
        items = changes.filter((ch) => !isDrawn(ch)).map(resolve);
        draw();
        return runFlow(drawn, summary);
      },
    };

    // Documents uploaded in BRASS AI, read the same way as a project's
    B.readDocuments = async (files) => (await Promise.all(files.map((f) => readDoc({ name: f.name, type: f.type, blob: f })))).flat().filter(Boolean);

    // No AI connected: the stand-in reader finds the changes in text documents; on a project's map they're offered for review
    B.findDocumentChanges = (sent) => {
      const texts = sent.filter((d) => d.text);
      if (!texts.length) return null;
      const found = texts.map((d) => demoAnalyze(d.text));
      const changes = merge(found.flatMap((f) => f.changes));
      const summary = found.map((f) => f.summary).join('; ');
      const reviewing = changes.length > 0 && document.documentElement.classList.contains('in-map') && !!c.activeProjectId && c.activeProjectId !== 'main' && !c._isReadOnlyView();
      if (reviewing) B.suggest.load(changes, summary);
      return { summary, changes, reviewing };
    };

    // A file attached to a project: its documents are read again the next time its map opens
    B.docsChanged = (projectId) => { dismissed.delete(projectId); };

    // On opening a project's map: if it has documents, read them and ask what to apply
    B.offerSuggestions = async (projectId, again) => {
      if (again) dismissed.delete(projectId);
      busFocus = null; pillCtx = null; items = []; drawnAreas = []; lastAi = aiByProject.get(projectId) || null; docAreaNames = lastAi && lastAi.areaNames ? lastAi.areaNames.slice() : []; draw();
      banner.hidden = true; btns.hidden = true;
      // documents already read this visit: the requirement's buses stay in AI focus without asking again
      if (dismissed.has(projectId) || !B.docs) return;
      let docs = [];
      try { docs = (await B.docs.all()).filter((d) => d.projectId === projectId); } catch (e) { /* none */ }
      if (!docs.length) return;
      analyze(docs, projectId);
    };
  };
})();
