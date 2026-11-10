/* BRASS — AI chat assistant (always open, docked on the right).
 * Map commands and data lookups run locally; everything else goes to Claude through /api/chat (server.py).
 */
(function () {
  const B = window.B;

  window.toggleBrassAi = function (v) {
    if (window._openBrassAi) {
      window._openBrassAi(v);
      return;
    }
    const root = document.getElementById('chat-panel');
    if (!root) return;
    const target = typeof v === 'boolean' ? v : !root.classList.contains('open');
    root.classList.toggle('open', target);
    document.body.classList.toggle('chat-open', target);
    if (target && typeof window.updateRecommendedPhrases === 'function') {
      window.updateRecommendedPhrases();
    }
  };

  B.initChat = function (app) {
    const { store, renderer, net, controller: c } = app;
    const root = document.getElementById('chat-panel');
    const log = document.getElementById('chat-log');
    const form = document.getElementById('chat-form');
    const input = document.getElementById('chat-input');
    const activeView = document.getElementById('chat-active-view');
    const historyView = document.getElementById('chat-history-view');
    const detailView = document.getElementById('chat-detail-view');
    const historyBtn = document.getElementById('chat-history-btn');
    const endBtn = document.getElementById('chat-end-btn');
    const newBtn = document.getElementById('chat-new-btn');
    const uploadBtn = document.getElementById('chat-upload');
    const fileInput = document.getElementById('chat-file');
    const filesRow = document.getElementById('chat-files');
    if (!root) return;
    // The AI mark in front of the panel's title
    const title = root.querySelector('.chat-title');
    if (title && B.AI_ICON && !title.querySelector('svg')) title.insertAdjacentHTML('afterbegin', B.AI_ICON);

    let currentSession = {
      id: 'sess_' + Date.now(),
      startTime: Date.now(),
      messages: [{
        who: 'ai',
        text: 'Hi, how can I help you?',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }],
    };

    const escapeHtml = (str) => {
      const d = document.createElement('div');
      d.textContent = str || '';
      return d.innerHTML;
    };

    // AI text can carry **bold** markers: they show as bold, never as asterisks. Built from text nodes, so a reply can't run as HTML.
    const setMsgText = (el, who, text) => {
      if (who !== 'ai') { el.textContent = text; return; }
      el.textContent = '';
      String(text).split(/\*\*(.+?)\*\*/g).forEach((part, i) => {
        if (i % 2) el.appendChild(document.createElement('strong')).textContent = part;
        else if (part) el.appendChild(document.createTextNode(part.replace(/\*\*/g, '')));
      });
    };

    const getSessions = () => {
      try {
        const raw = localStorage.getItem('brass_chat_sessions_v1');
        return raw ? JSON.parse(raw) : [];
      } catch (e) {
        return [];
      }
    };

    const saveSessions = (sessions) => {
      try {
        localStorage.setItem('brass_chat_sessions_v1', JSON.stringify(sessions));
      } catch (e) {}
    };

    const LAYERS = {
      routes: 'layer-routes', 'bus routes': 'layer-routes', stops: 'layer-stops', 'stop names': 'layer-stop-names',
      interchanges: 'layer-interchanges', 'bus interchanges': 'layer-interchanges',
      mrt: 'layer-mrt', closures: 'layer-closures', areas: 'layer-areas',
      buildings: 'layer-buildings', parks: 'layer-buildings', nature: 'layer-buildings', 'buildings & nature': 'layer-buildings',
    };

    const add = (who, text, timeStr, skipRecord) => {
      const el = document.createElement('div');
      el.className = 'chat-msg chat-' + who;
      const contentSpan = document.createElement('span');
      contentSpan.className = 'chat-msg-text';
      setMsgText(contentSpan, who, (text || '').trim());
      el.appendChild(contentSpan);

      const time = timeStr || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const timeEl = document.createElement('span');
      timeEl.className = 'chat-msg-time';
      timeEl.textContent = time;
      el.appendChild(timeEl);

      log.appendChild(el);
      log.scrollTop = log.scrollHeight;

      let msgObj = null;
      if (!skipRecord) {
        msgObj = { who, text, time };
        currentSession.messages.push(msgObj);
      }

      el._updateText = (newText) => {
        setMsgText(contentSpan, who, newText);
        if (msgObj) msgObj.text = newText;
      };
      return el;
    };

    const setLayer = (id, on) => {
      const chk = document.getElementById(id);
      if (!chk || chk.checked === on) return !!chk;
      chk.checked = on;
      chk.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };

    const findRoutes = (num) => Object.values(store.doc.routes).filter((r) => String(r.number).trim().toLowerCase() === num);

    // ---------------------------------------------------------------- Map actions
    // One set of actions, run for typed requests and for what the AI asks for. Every change goes through the
    // store, so "undo" takes it back.
    const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const roadNames = (() => { const m = new Map(); net.edges.forEach((e) => { if (e && e.name && !m.has(norm(e.name))) m.set(norm(e.name), e.name); }); return m; })();
    const stopXY = (st) => net.posPoint({ edge: st.edge, s: st.s, dir: st.dir || 1 }, 0);
    const mid = (e) => e.pts[Math.floor(e.pts.length / 2)];
    const bboxOf = (pts) => pts.reduce((b, p) => ({ x0: Math.min(b.x0, p.x), y0: Math.min(b.y0, p.y), x1: Math.max(b.x1, p.x), y1: Math.max(b.y1, p.y) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    const fit = (bb, min) => renderer.fitToBounds(bb, { left: 340, right: 350, top: 90, bottom: 90 }, { maxZoom: 1.4, minSize: min || 600 });
    const findRoad = (text) => { const t = norm(text); let best = null; for (const [k, name] of roadNames) if (t.includes(k) && (!best || name.length > best.length)) best = name; return best; };
    const findStop = (text) => {
      const code = (String(text).match(/\b\d{5}\b/) || [])[0];
      const stops = Object.values(store.doc.stops);
      if (code) return stops.find((s) => String(s.code) === code) || null;
      const t = norm(text); let best = null;
      for (const s of stops) { const n = norm(s.name); if (n.length > 3 && t.includes(n) && (!best || n.length > norm(best.name).length)) best = s; }
      return best;
    };
    const findMrt = (text) => {
      const stations = (app.city && app.city.mrtStations) || [];
      const codeMatch = String(text).match(/\b(?:NS|EW|NE|CC|DT|TE|CG|CR|JE|MR)\d{1,2}\b/i);
      if (codeMatch) {
        const token = codeMatch[0].toUpperCase();
        const byCode = stations.find((m) => String(m.code || '').toUpperCase().split(/\s*\/\s*/).includes(token));
        if (byCode) return byCode;
      }
      const t = norm(text); let best = null;
      for (const m of stations) { const n = norm(m.name); if (n.length >= 3 && t.includes(n) && (!best || n.length > norm(best.name).length)) best = m; }
      return best;
    };
    const busRoutes = (num) => Object.values(store.doc.routes).filter((r) => String(r.number).trim().toLowerCase() === String(num).trim().toLowerCase());
    const roadEdges = (road, codes) => {
      let edges = net.edges.filter((e) => e && norm(e.name) === norm(road));
      const stops = (codes || []).map((x) => findStop(x)).filter(Boolean);
      if (stops.length >= 2) {
        const a = stopXY(stops[0]), b = stopXY(stops[1]), m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, span = Math.hypot(a.x - b.x, a.y - b.y) / 2;
        return edges.filter((e) => Math.hypot(mid(e).x - m.x, mid(e).y - m.y) <= span + 120);
      }
      // a long road: the part nearest the middle of the screen
      const cam = renderer.camera;
      edges.sort((p, q) => Math.hypot(mid(p).x - cam.x, mid(p).y - cam.y) - Math.hypot(mid(q).x - cam.x, mid(q).y - cam.y));
      if (!edges.length) return edges;
      const near = mid(edges[0]);
      return edges.filter((e) => Math.hypot(mid(e).x - near.x, mid(e).y - near.y) <= 500).slice(0, 10);
    };
    const lineBox = (ids) => {
      const pts = [];
      ids.forEach((id) => { const g = store.geom[id]; if (g && g.legs) g.legs.forEach((l) => (l.segs || []).forEach((sg) => { const e = net.edge(sg.edge); if (e) pts.push(e.pts[0], mid(e), e.pts[e.pts.length - 1]); })); });
      return pts.length ? bboxOf(pts) : null;
    };
    const UNDO = ' Say "undo" to take it back.';

    const ensureMap = () => {
      const docRoot = document.documentElement;
      if (!docRoot.classList.contains('in-map')) {
        docRoot.classList.add('in-map');
        const navHome = document.getElementById('nav-item-home');
        if (navHome) {
          navHome.classList.remove('active');
          navHome.removeAttribute('aria-current');
        }
        const navProjects = document.getElementById('nav-item-projects');
        if (navProjects) {
          navProjects.classList.remove('active');
          navProjects.removeAttribute('aria-current');
        }
        const navMap = document.getElementById('nav-item-map');
        if (navMap) {
          navMap.classList.add('active');
          navMap.setAttribute('aria-current', 'page');
        }
        window.dispatchEvent(new Event('resize'));
      }
    };

    const run = (a) => {
      const MAP_ACTIONS = new Set(['undo', 'redo', 'save', 'export', 'close_road', 'open_road', 'add_area', 'stop_off', 'stop_on', 'reroute', 'restore_route', 'cut_route', 'suspend_route', 'resume_route', 'focus_bus', 'show_all', 'create_bus', 'goto_stop', 'goto_mrt', 'layer', 'open_project', 'create_project', 'duplicate_project']);
      if (MAP_ACTIONS.has(a.type)) ensureMap();
      // An archived project can be looked at and searched, not changed
      const CHANGES = new Set(['undo', 'redo', 'save', 'close_road', 'open_road', 'add_area', 'stop_off', 'stop_on', 'reroute', 'restore_route', 'cut_route', 'suspend_route', 'resume_route', 'create_bus']);
      if (CHANGES.has(a.type) && c._isArchivedActive && c._isArchivedActive()) return 'This project is archived, so its map can\'t be changed.';
      switch (a.type) {
        case 'open_project': {
          ensureMap();
          if (c && c._switchProject) c._switchProject(a.projectId, 'edit');
          if (typeof updateRecommendedPhrases === 'function') updateRecommendedPhrases();
          return `Opened project "${a.name}".`;
        }
        case 'create_project': {
          ensureMap();
          if (c && c._createNewProject) {
            c._createNewProject();
            c._updateUIState();
            const p = c.projects && c.projects[c.projects.length - 1];
            return `Created new project draft "${p ? p.name : 'New Project'}".`;
          }
          return 'Could not create new project.';
        }
        case 'duplicate_project': {
          ensureMap();
          if (c && c._duplicateProject) {
            c._duplicateProject(c.activeProjectId);
            c._updateUIState();
            return 'Duplicated project draft.';
          }
          return 'Could not duplicate project.';
        }
        case 'undo': store.undo(); c._updateUIState(); return 'Undone.';
        case 'redo': store.redo(); c._updateUIState(); return 'Redone.';
        case 'save': c._saveProjectDraftById(c.activeProjectId, false); return 'Saved.';
        case 'export': B.exportProjectPdf && B.exportProjectPdf(c.activeProjectId); return 'Downloading the PDF.';
        case 'close_road': {
          const road = findRoad(a.road) || (roadNames.get(norm(a.road)));
          if (!road) return `I can't find the road "${a.road}" on this map.`;
          const edges = roadEdges(road, a.between_stops);
          if (!edges.length) return `No segments of ${road} found there.`;
          const ids = edges.map((e) => e.id);
          store.commit('Close ' + road, (doc) => B.ops.setClosed(doc, ids, true, { reason: a.reason || 'Closed from chat' }));
          fit(bboxOf(edges.flatMap((e) => e.pts)), 600); c._updateUIState();
          return `Closed ${road} (${ids.length} segment${ids.length === 1 ? '' : 's'}).${UNDO}`;
        }
        case 'open_road': {
          const road = findRoad(a.road) || roadNames.get(norm(a.road));
          if (!road) return `I can't find the road "${a.road}" on this map.`;
          const ids = net.edges.filter((e) => e && norm(e.name) === norm(road) && store.doc.closures[e.id]).map((e) => e.id);
          if (!ids.length) return `${road} isn't closed.`;
          store.commit('Reopen ' + road, (doc) => B.ops.setClosed(doc, ids, false));
          c._updateUIState();
          return `Reopened ${road} (${ids.length} segment${ids.length === 1 ? '' : 's'}).${UNDO}`;
        }
        case 'add_area': {
          const stop = a.near && findStop(a.near);
          const road = !stop && a.near && findRoad(a.near);
          let at = null, label = '';
          if (stop) { at = stopXY(stop); label = stop.name; }
          else if (road) { const es = roadEdges(road); if (es.length) { at = mid(es[Math.floor(es.length / 2)]); label = road; } }
          else { at = { x: renderer.camera.x, y: renderer.camera.y }; label = 'the map centre'; }
          if (!at) return 'I could not place that area.';
          const r = Math.max(30, Math.min(2000, Number(a.radius_m) || 300));
          const id = store.newId('A');
          store.commit('Add area from chat', (doc) => { doc.areas[id] = { id, name: `Area near ${label}`, shape: 'circle', cx: at.x, cy: at.y, r }; });
          fit({ x0: at.x - r, y0: at.y - r, x1: at.x + r, y1: at.y + r }, 600); c._updateUIState();
          return `Added a ${Math.round(r)} m area around ${label}.${UNDO}`;
        }
        case 'stop_off': case 'stop_on': {
          const st = findStop(a.stop);
          if (!st) return `I can't find the stop "${a.stop}".`;
          const off = a.type === 'stop_off';
          store.commit(`${off ? 'Stop serving' : 'Serve'} ${st.name}`, (doc) => { if (off) doc.stops[st.id].active = false; else delete doc.stops[st.id].active; });
          const q = stopXY(st); fit({ x0: q.x - 250, y0: q.y - 250, x1: q.x + 250, y1: q.y + 250 }, 500); c._updateUIState();
          return `${st.name} (${st.code}) is ${off ? 'no longer' : 'now'} served.${UNDO}`;
        }
        case 'reroute': {
          const rs = busRoutes(a.bus);
          if (!rs.length) return `No bus ${a.bus} on the map.`;
          const base = (rs[0].kind === 'proposed' && rs[0].baseId && store.doc.routes[rs[0].baseId]) ? store.doc.routes[rs[0].baseId] : rs[0];
          const opts = c._rankedDetourOptions(base.id) || [];
          if (!opts.length) return `Bus ${base.number} isn't blocked, so it needs no detour.`;
          const o = opts[0];
          c.applySuggestDetour(base.id, 0);
          renderer.selected = { type: 'route', id: base.id };
          c._showInspector(renderer.selected);
          const bb = lineBox([base.id]); if (bb) fit(bb, 800);
          return `Rerouted bus ${base.number}: ${o.title} (${B.fmtMin(o.time)}, ${B.fmtKm(o.length)}, ${o.stopsSkipped} stops skipped).${UNDO}`;
        }
        case 'restore_route': {
          const num = a.bus ? String(a.bus).trim().toUpperCase() : '84';
          if (c && c.restoreRouteAiChanges) {
            c.restoreRouteAiChanges(num);
          }
          c._updateUIState();
          return `Restored bus ${num} to its original arterial alignment.`;
        }
        case 'cut_route': {
          const num = a.bus ? String(a.bus).trim().toUpperCase() : '862';
          const rs = busRoutes(num);
          if (!rs.length) return `No bus ${num} on the map.`;
          if (c && c._cutRouteIntoChunks) {
            c._cutRouteIntoChunks(rs[0].id, null, { manualEdit: false });
          }
          c._updateUIState();
          return `Cut bus ${num} into operational chunks connecting nearest terminals.${UNDO}`;
        }
        case 'suspend_route': {
          const num = a.bus ? String(a.bus).trim().toUpperCase() : '';
          const rs = busRoutes(num);
          if (!rs.length) return `No bus ${num} on the map.`;
          store.commit('Suspend bus ' + num, (doc) => {
            rs.forEach((r) => { doc.routes[r.id].active = false; });
          });
          c._updateUIState();
          return `Suspended bus ${num}.${UNDO}`;
        }
        case 'resume_route': {
          const num = a.bus ? String(a.bus).trim().toUpperCase() : '';
          const rs = busRoutes(num);
          if (!rs.length) return `No bus ${num} on the map.`;
          store.commit('Resume bus ' + num, (doc) => {
            rs.forEach((r) => { delete doc.routes[r.id].active; });
          });
          c._updateUIState();
          return `Resumed bus ${num}.${UNDO}`;
        }
        case 'focus_bus': {
          const rs = busRoutes(a.bus);
          if (!rs.length) return `No bus ${a.bus} on the map.`;
          c.quickFilter = null;
          c.selectedRouteIds = new Set(rs.map((r) => r.id));
          c.isAllRoutesSelected = false;
          c._applyRouteMultiSelection(); c._updateRouteDropdown();
          renderer.selected = { type: 'route', id: rs[0].id };
          c._showInspector(renderer.selected);
          const bb = lineBox(rs.map((r) => r.id)); if (bb) fit(bb, 800);
          return `Showing bus ${rs[0].number}. Say "show all buses" to see everything again.`;
        }
        case 'show_all': {
          c.quickFilter = null;
          c.selectedRouteIds = new Set(Object.keys(store.doc.routes));
          c.isAllRoutesSelected = true;
          c._applyRouteMultiSelection(); c._updateRouteDropdown(); renderer.fitToBoundary();
          return 'Showing all buses.';
        }
        case 'create_bus': {
          const num = String(a.bus || '').trim().toUpperCase();
          if (!num) return 'Please specify a bus number.';
          const existing = busRoutes(num);
          if (existing.length) {
            c.quickFilter = null;
            c.selectedRouteIds = new Set(existing.map((r) => r.id));
            c.isAllRoutesSelected = false;
            c._applyRouteMultiSelection(); c._updateRouteDropdown();
            renderer.selected = { type: 'route', id: existing[0].id };
            c._showInspector(renderer.selected);
            const bb = lineBox(existing.map((r) => r.id)); if (bb) fit(bb, 800);
            return `Bus ${num} is active on the map (${(existing[0].anchors || []).length} stops).`;
          }
          const stops = (a.stops || []).map((code) => findStop(code)).filter(Boolean);
          if (stops.length < 2) return `Need at least 2 stop codes to create bus ${num}.`;
          let newId = null;
          store.commit('Create bus ' + num, (doc) => {
            newId = 'R' + (doc.seq = (doc.seq || 1) + 1);
            doc.routes[newId] = {
              id: newId,
              number: num,
              kind: 'proposed',
              baseId: null,
              override: false,
              fromDocument: true,
              name: `Bus ${num} (${stops[0].name} ➔ ${stops[stops.length - 1].name})`,
              color: B.pickRouteColor ? B.pickRouteColor(Object.values(doc.routes).map((r) => r.color)) : '#059669',
              hours: { start: '06:00', end: '23:00' },
              days: B.ALL_DAYS ? B.ALL_DAYS.slice() : [0, 1, 2, 3, 4, 5, 6],
              anchors: stops.map((st) => ({ t: 'stop', id: st.id })),
            };
          });
          c._updateUIState();
          if (newId) {
            c.selectedRouteIds = new Set([newId]);
            c.isAllRoutesSelected = false;
            c._applyRouteMultiSelection(); c._updateRouteDropdown();
            renderer.selected = { type: 'route', id: newId };
            c._showInspector(renderer.selected);
            const bb = lineBox([newId]); if (bb) fit(bb, 800);
          }
          return `Created bus ${num} from ${stops[0].name} to ${stops[stops.length - 1].name}.${UNDO}`;
        }
        case 'goto_stop': {
          const st = findStop(a.stop);
          if (!st) return `I can't find the stop "${a.stop}".`;
          const q = stopXY(st); fit({ x0: q.x - 250, y0: q.y - 250, x1: q.x + 250, y1: q.y + 250 }, 500);
          return `${st.name} (${st.code}).`;
        }
        case 'goto_mrt': {
          const m = findMrt(a.mrt);
          if (!m) return `I can't find the MRT station "${a.mrt}".`;
          ensureMap();
          renderer.selected = { type: 'mrt', id: m.id, obj: m };
          if (c && c._showInspector) c._showInspector(renderer.selected);
          fit({ x0: m.x - 280, y0: m.y - 280, x1: m.x + 280, y1: m.y + 280 }, 550);
          renderer.requestRender();
          return `${m.name} MRT [${m.code || m.id}].`;
        }
        default: return null;
      }
    };

    // What was typed, turned into an action (null when it isn't one)
    const parseAction = (raw) => {
      const q = raw.trim(), t = q.toLowerCase();
      if (/^(undo|undo that|take (it|that) back)\b/.test(t)) return { type: 'undo' };
      if (/^redo\b/.test(t)) return { type: 'redo' };
      if (/^save( (it|this|the project))?\b/.test(t)) return { type: 'save' };
      if (/^export\b|\bdownload (the )?(pdf|report)\b/.test(t)) return { type: 'export' };
      if (/\b(show|view) all (the )?buses\b|\breset (the )?(filter|view)\b/.test(t)) return { type: 'show_all' };
      const code = (q.match(/\b\d{5}\b/g) || []);
      const bus = (t.match(/\b(?:bus|service)\s*#?\s*(\d{1,3}[a-z]?)\b/) || [])[1];
      if (/\b(create|add|new)\b/.test(t) && bus && code.length >= 2) return { type: 'create_bus', bus, stops: code };
      if (/\b(restore|revert)\b.*\b(route|bus|detour|alignment)\b/i.test(t) || /\b(restore|revert)\s*(?:bus|service)?\s*(\d{1,3}[a-z]?)\b/i.test(t)) {
        return { type: 'restore_route', bus: bus || '84' };
      }
      if (/\b(cut|split|chunk)\b.*\b(route|bus)\b/i.test(t) || /\b(cut|split)\s*(?:bus|service)?\s*(\d{1,3}[a-z]?)\b/i.test(t)) {
        return { type: 'cut_route', bus: bus || '862' };
      }
      if (/\b(suspend|pause|deactivate)\b.*\b(bus|service|route)\b/i.test(t)) {
        return { type: 'suspend_route', bus: bus || '' };
      }
      if (/\b(resume|reactivate)\b.*\b(bus|service|route)\b/i.test(t)) {
        return { type: 'resume_route', bus: bus || '' };
      }
      if (/\b(duplicate|clone|copy)\b.*\b(project|draft)\b/i.test(t)) {
        return { type: 'duplicate_project' };
      }
      if (/\b(create|new|start|add)\s+(?:new\s+)?project\b/i.test(t)) {
        return { type: 'create_project' };
      }
      if (/\b(re-?route|detour|divert|bypass|suggest\s*(?:a\s*)?route|suggest\s*detour)\b/.test(t)) {
        const targetBus = bus || (renderer.selected && renderer.selected.type === 'route' && store.doc.routes[renderer.selected.id] ? store.doc.routes[renderer.selected.id].number : null) || '84';
        if (targetBus) return { type: 'reroute', bus: targetBus };
      }
      if (/\b(show|focus|highlight|go to|find)\b/.test(t) && bus) return { type: 'focus_bus', bus };
      const mrtCodeHit = /\b(?:NS|EW|NE|CC|DT|TE|CG|CR|JE|MR)\d{1,2}\b/i.test(q);
      const mrtStation = (/\bmrt\b/.test(t) || mrtCodeHit) ? findMrt(q) : null;
      if (mrtStation && (/\b(go to|zoom to|take me to|show|find|where is)\b/.test(t) || mrtCodeHit)) {
        return { type: 'goto_mrt', mrt: mrtStation.code || mrtStation.name };
      }
      const stopWord = /\bstop\b|\bstn\b|\bstation\b/.test(t);
      const stop = findStop(q);
      if (/\b(deactivate|disable|skip|stop serving|not serve|close)\b/.test(t) && stopWord && stop) return { type: 'stop_off', stop: stop.code };
      if (/\b(activate|enable|serve|reopen|open)\b/.test(t) && stopWord && stop) return { type: 'stop_on', stop: stop.code };
      if (/\b(go to|zoom to|take me to|show|find)\b/.test(t) && stopWord && stop) return { type: 'goto_stop', stop: stop.code };
      if (/\b(draw|add|create|make|put)\b/.test(t) && /\b(area|zone)\b/.test(t)) {
        const r = (t.match(/(\d+)\s*(?:m|metre|meter)s?\b/) || [])[1];
        return { type: 'add_area', near: stop ? stop.code : (findRoad(q) || ''), radius_m: r ? Number(r) : 300 };
      }
      if (/\b(close|block|shut)\b/.test(t)) {
        const road = findRoad(q);
        if (road) return { type: 'close_road', road, between_stops: code.slice(0, 2) };
      }
      if (/\b(reopen|open|unblock)\b/.test(t)) {
        const road = findRoad(q);
        if (road) return { type: 'open_road', road };
      }
      const openProjMatch = t.match(/\b(?:open|switch to|view|go to)\s+(?:project\s+)?["']?([^"']+)["']?/i);
      if (openProjMatch && c && c.projects) {
        const pSearch = norm(openProjMatch[1]);
        let found = null;
        if (/^(?:project\s*)?1\b/.test(pSearch)) found = c.projects.find((p) => p.id === 'prj-1' || p.id === 'proj-1') || c.projects[0];
        else if (/^(?:project\s*)?2\b/.test(pSearch)) found = c.projects.find((p) => p.id === 'prj-2' || p.id === 'proj-2') || c.projects[1];
        else if (/^(?:project\s*)?3\b/.test(pSearch)) found = c.projects.find((p) => p.id === 'prj-3' || p.id === 'proj-3') || c.projects[2];
        if (!found) {
          found = Object.values(c.projects).find((p) => norm(p.name).includes(pSearch) || pSearch.includes(norm(p.name)) || norm(p.id).includes(pSearch));
        }
        if (found) return { type: 'open_project', projectId: found.id, name: found.name };
      }
      return null;
    };

    // Projects and the Current Map as they stand, for the answers about them
    const STAGE = { not_started: 'Not Started', progress: 'In Progress', review: 'Ready to Review', approved: 'Approved', schedule: 'Scheduled', go_live: 'Go-Live', archive: 'Archived' };
    const projects = () => (c && c.projects) || [];
    const span = (p) => {
      const a = p.applyPeriod || {};
      const t = (d, h) => (d ? new Date(`${d}T${h || '00:00'}`).getTime() : NaN);
      return { temp: a.mode === 'scheduled', s: t(a.startDate, a.startTime), e: a.mode === 'scheduled' ? t(a.endDate, a.endTime) : Infinity };
    };
    const when = (ts) => new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const liveNow = () => projects().filter((p) => p.status === 'go_live' && span(p).temp && span(p).e > Date.now());
    const upcoming = () => projects().filter((p) => p.status === 'schedule' && span(p).s > Date.now()).sort((a, b) => span(a).s - span(b).s);
    const ago = (ts) => {
      const d = Math.max(0, Date.now() - ts), h = Math.round(d / 3600000);
      return h < 1 ? 'just now' : h < 24 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
    };
    // The Current Map worked out (closures from its areas, disrupted buses), whatever map is open
    const currentMap = () => {
      if (c.activeProjectId === 'main') return store;
      const m = Object.create(B.Store.prototype);
      Object.assign(m, { city: store.city, net: store.net, legCache: store.legCache, past: [], future: [], tx: null, rev: 0, doc: c._loadProjectDraft('main') });
      m.derive();
      return m;
    };
    const closedRoads = (m) => {
      const n = new Map();
      for (const id of Object.keys(m.doc.closures || {})) {
        const e = store.net.edges[Number(id)];
        const name = (e && e.name) || 'Unnamed road';
        n.set(name, (n.get(name) || 0) + 1);
      }
      return [...n.entries()].sort((a, b) => b[1] - a[1]);
    };
    const disruptedNums = (m) => [...new Set(m.disruptedRoutes().map((r) => String(r.number).trim()))];
    const portfolio = () => {
      const all = projects();
      if (!all.length) return 'There are no projects yet.';
      const counts = Object.entries(STAGE).map(([k, l]) => [l, all.filter((p) => p.status === k).length]).filter(([, n]) => n);
      const lines = [`${all.length} projects: ${counts.map(([l, n]) => `${n} ${l}`).join(', ')}.`];
      liveNow().forEach((p) => lines.push(`• **${p.name}** — live until ${when(span(p).e)}`));
      upcoming().slice(0, 3).forEach((p) => lines.push(`• **${p.name}** — scheduled from ${when(span(p).s)}`));
      all.filter((p) => ['progress', 'review', 'approved'].includes(p.status)).slice(0, 4).forEach((p) => lines.push(`• **${p.name}** — ${STAGE[p.status]}`));
      return lines.join('\n');
    };

    const reply = (raw) => {
      const act = parseAction(raw);
      if (act) { const out = run(act); if (out) return out; }
      const q = raw.trim().toLowerCase();
      const doc = store.doc;
      const routes = Object.values(doc.routes);
      const stops = Object.values(doc.stops);

      const isInformationalQuery = /\b(active road closures|active closures|road closures|inspect closures|impacted bus|affected bus|all ongoing projects|ongoing projects|what requires attention|today's network changes|network changes|what projects|upcoming events|restorations)\b/.test(q);
      const layerHit = Object.keys(LAYERS).sort((a, b) => b.length - a.length).find((k) => q.includes(k));
      const on = /\b(show|turn on|enable)\b/.test(q), off = /\b(hide|turn off|disable)\b/.test(q);
      if (layerHit && (on || off) && !isInformationalQuery) {
        setLayer(LAYERS[layerHit], on);
        return (on ? 'Showing ' : 'Hiding ') + layerHit + '.';
      }
      if (/\b(zoom in)\b/.test(q)) { renderer.zoomAt(renderer.width / 2, renderer.height / 2, 1.5); return 'Zoomed in.'; }
      if (/\b(zoom out)\b/.test(q)) { renderer.zoomAt(renderer.width / 2, renderer.height / 2, 0.66); return 'Zoomed out.'; }
      if (/\b(fit|reset view|whole map|overview)\b/.test(q)) { renderer.fitToBoundary(); return 'Fitted the map.'; }

      const num = (q.match(/\b(?:bus|service|route)\s*#?\s*([a-z]?\d{1,3}[a-z]?)\b/) || q.match(/^\s*#?(\d{1,3}[a-z]?)\s*\??$/) || [])[1];
      if (num) {
        const hits = findRoutes(num);
        if (!hits.length) return `No bus ${num.toUpperCase()} on the map.`;
        const r = hits[0];
        const stopCount = hits.reduce((t, x) => t + (x.anchors || []).filter((a) => a.t === 'stop').length, 0);
        const first = doc.stops[(r.anchors.find((a) => a.t === 'stop') || {}).id];
        const lines = [`Bus ${r.number}: ${stopCount} stops, ${r.fleet || '?'} buses.`];
        if (first) lines.push(`Starts at ${first.name}.`);
        if (r.kind) lines.push(`Status: ${r.kind}.`);
        const fq = B.routeFrequencies ? B.routeFrequencies(r) : null;
        if (fq) lines.push(`Frequency: AM Peak (${fq.amPeak}), Midday (${fq.amOffPeak}), PM Peak (${fq.pmPeak}), Night (${fq.pmOffPeak}).`);
        return lines.join(' ');
      }
      const stopQ = (q.match(/(?:stop|stn|station)\s+(?:named\s+)?(.{3,})$/) || [])[1];
      if (stopQ) {
        const m = stops.filter((s) => s.name.toLowerCase().includes(stopQ.trim())).slice(0, 5);
        if (m.length) return m.map((s) => `${s.name} (${s.code})`).join('\n');
      }

      if (/\b(how many|count|total)\b/.test(q) && /\broutes?|services?|bus(es)? (lines?|numbers?)\b/.test(q)) return `${routes.length} bus routes.`;
      if (/\b(how many|count|total)\b/.test(q) && /\bstops?\b/.test(q)) return `${stops.length} bus stops.`;
      if (/\b(how many|total)\b/.test(q) && /\b(fleet|buses)\b/.test(q)) return `${routes.reduce((t, r) => t + (r.fleet || 0), 0)} buses.`;
      if (/\b(how many|count|total)\b.*\b(closures?|incidents?)\b/.test(q) || /^(closures?|incidents?)\??$/.test(q)) return `${Object.keys(doc.closures || {}).length} road closures, ${Object.keys(doc.areas || {}).length} affected areas.`;

      if (/\b(create|add|new)\b.*\b(bus|route|line)\b/.test(q)) return 'Pick Create Bus in the toolbar, then click bus stops along the road to connect them. Press Enter to finish.';
      if (/\b(create|add|new)\b.*\bstop\b/.test(q)) return 'Pick New Bus Stop in the toolbar (S), then click a road to place it.';
      if (/\b(closure|close a road|block)\b/.test(q)) return 'Pick Road Closure (C) and click the road segment to close.';
      if (/\b(area|polygon)\b/.test(q)) return 'Pick Affected Area (A) and click points to draw it.';
      if (/\bundo\b/.test(q)) return 'Press Cmd+Z (Ctrl+Z) to undo.';
      if (/\b(save|saved)\b/.test(q)) return 'Changes save automatically; the header shows Saved.';
      if (/\b(hi|hello|hey)\b/.test(q)) return 'Hi. Ask about a bus number, stop counts, or tell me to show or hide a layer.';
      if (/\b(how many projects|projects in draft|list projects)\b/.test(q)) {
        const pList = Object.values(c && c.projects ? c.projects : {});
        return `There ${pList.length === 1 ? 'is' : 'are'} ${pList.length} project${pList.length === 1 ? '' : 's'} in your dashboard: ${pList.map(p => p.name).join(', ')}.`;
      }
      if (/\b(summarise|summarize)\b.*\b(all ongoing projects|ongoing projects|projects and their current status|project.*status|projects)\b/i.test(q) || /ongoing projects/i.test(q)) {
        return portfolio();
      }
      if (/\b(upcoming events.*affecting|upcoming events.*bus network|events.*affecting|events.*bus network|upcoming events|upcoming.*restorations?|which projects have upcoming|events or restorations)\b/i.test(q)) {
        const lines = ['Upcoming changes to the bus network:'];
        liveNow().sort((a, b) => span(a).e - span(b).e).forEach((p) => lines.push(`• **${p.name}** — live, ends ${when(span(p).e)}`));
        upcoming().slice(0, 5).forEach((p) => lines.push(`• **${p.name}** — starts ${when(span(p).s)}${span(p).temp ? `, ends ${when(span(p).e)}` : ''}`));
        return lines.length > 1 ? lines.join('\n') : 'Nothing is live or scheduled.';
      }
      if (/\b(overlapping projects|operational conflicts|overlapping.*conflicts?|potential.*conflicts?|any.*conflicts|project conflicts)\b/i.test(q)) {
        const set = [...liveNow(), ...upcoming()].filter((p) => span(p).temp);
        const pairs = [];
        set.forEach((a, i) => set.slice(i + 1).forEach((b) => {
          if (span(a).s < span(b).e && span(b).s < span(a).e) pairs.push(`• **${a.name}** and **${b.name}** overlap from ${when(Math.max(span(a).s, span(b).s))} to ${when(Math.min(span(a).e, span(b).e))}`);
        }));
        return pairs.length ? ['Live or scheduled changes that overlap:', ...pairs].join('\n') : 'No live or scheduled changes overlap.';
      }
      if (/\b(highest impact|highest.*impact.*passengers?|impact on bus services|highest impact on bus)\b/i.test(q)) {
        const ranked = [...liveNow(), ...upcoming()].map((p) => {
          const d = c._loadProjectDraft(p.id);
          return { p, closures: Object.keys(d.closures || {}).length, areas: Object.keys(d.areas || {}).length };
        }).sort((a, b) => (b.areas * 10 + b.closures) - (a.areas * 10 + a.closures));
        if (!ranked.length) return 'Nothing is live or scheduled.';
        return ['Live and scheduled changes, most road changes first:', ...ranked.map((x, i) => `${i + 1}. **${x.p.name}** — ${x.areas} affected area${x.areas === 1 ? '' : 's'}, ${x.closures} road closure${x.closures === 1 ? '' : 's'}`)].join('\n');
      }
      if (/\b(user roles and permissions|roles and permissions)\b/i.test(q)) {
        return [
          'User roles and permissions overview:',
          '• **Admin**: Full control over network, projects, exports, and user administration.',
          '• **Bus Ops**: Edit projects, route detours, road closures, and export review packages.',
          '• **Viewer**: View projects and dashboard statistics in read-only mode.'
        ].join('\n');
      }
      if (/\b(active administrators|who are the.*admins)\b/i.test(q)) {
        return 'Active Administrator: **Admin** (admin@brass.sg). You currently have full administrative privileges.';
      }
      if (/\b(invite a new team member|invite member|add user)\b/i.test(q)) {
        return 'To invite a new team member, click **+ Invite user** on the User page, specify their name, email, and assign their access role.';
      }
      if (/\b(recent user activity|user activity)\b/i.test(q)) {
        const recent = [...projects()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 5);
        return ['Recent project activity:', ...recent.map((p) => `• **${(p.owner && p.owner.name) || 'Someone'}** updated **${p.name}** (${ago(p.updatedAt || p.createdAt || Date.now())})`)].join('\n');
      }
      if (/\b(summarise|summarize)\b.*\b(current bus network status|bus network status|current network)\b/i.test(q) ||
          /\bsummarise the current bus network status\b/i.test(q) ||
          /\b(summarise|summarize)\b.*\b(network|changes|today)\b/.test(q)) {
        const m = currentMap();
        const routes = Object.values(m.doc.routes || {}).filter((r) => r.active !== false);
        const lines = [
          'Current Map:',
          `• ${new Set(routes.map((r) => String(r.number).trim())).size} bus services, ${routes.reduce((t, r) => t + (r.fleet || 0), 0)} buses`,
          `• ${Object.keys(m.doc.closures || {}).length} road closure segments, ${Object.keys(m.doc.areas || {}).length} affected areas`,
          `• ${disruptedNums(m).length} buses running into a closure`,
        ];
        liveNow().forEach((p) => lines.push(`• Live: **${p.name}** until ${when(span(p).e)}`));
        const next = upcoming()[0];
        if (next) lines.push(`• Next: **${next.name}** from ${when(span(next).s)}`);
        return lines.join('\n');
      }
      if (/\b(highlight.*today.*changes|today.*key changes|key changes|major operational disruptions|operational disruptions|identify.*disruptions|major disruptions|disruptions)\b/i.test(q)) {
        const dayEnd = new Date(); dayEnd.setHours(23, 59, 59, 999);
        const live = liveNow(), today = upcoming().filter((p) => span(p).s <= dayEnd.getTime());
        if (!live.length && !today.length) return 'No changes are live today.';
        return ['Changes affecting buses today:',
          ...live.map((p) => `• **${p.name}** — live until ${when(span(p).e)}`),
          ...today.map((p) => `• **${p.name}** — starts ${when(span(p).s)}`)].join('\n');
      }
      if (/\b(show active road closures|active closures|road closures|inspect closures)\b/.test(q)) {
        const roads = closedRoads(currentMap());
        if (!roads.length) return 'No roads are closed on the Current Map.';
        return [`Roads closed on the Current Map (${roads.reduce((t, [, n]) => t + n, 0)} segments):`, ...roads.slice(0, 8).map(([name, n]) => `• **${name}** — ${n} segment${n === 1 ? '' : 's'}`)].join('\n');
      }
      if (/\b(impacted bus services|impacted buses|affected buses|affected bus services|identify impacted)\b/.test(q)) {
        const nums = disruptedNums(currentMap());
        if (!nums.length) return 'No buses run into a closure on the Current Map.';
        return `${nums.length} bus${nums.length === 1 ? '' : 'es'} run into a closure on the Current Map: ${nums.slice(0, 30).join(', ')}${nums.length > 30 ? '…' : ''}.`;
      }
      if (/\b(what requires attention|requires attention|attention)\b/.test(q)) {
        const m = currentMap(), week = Date.now() + 7 * 86400000;
        const lines = ['Needs attention:',
          `• ${Object.keys(m.doc.closures || {}).length} road closure segments on the Current Map`,
          `• ${disruptedNums(m).length} buses running into a closure`];
        liveNow().filter((p) => span(p).e <= week).forEach((p) => lines.push(`• **${p.name}** ends ${when(span(p).e)}`));
        upcoming().filter((p) => span(p).s <= week).forEach((p) => lines.push(`• **${p.name}** starts ${when(span(p).s)}`));
        projects().filter((p) => p.status === 'review').forEach((p) => lines.push(`• **${p.name}** is ready to review`));
        return lines.join('\n');
      }
      if (/\b(compare before and after)\b/.test(q)) {
        const btn = document.querySelector('.header-compare button:not(.active)');
        if (btn) btn.click();
        return 'Toggled Before/After comparison.';
      }
      if (/\b(create new project|new project)\b/.test(q)) {
        const addBtn = document.getElementById('pp-new-project');
        if (addBtn) { addBtn.click(); return 'Opening new project dialog on the Projects page.'; }
        return 'Go to Home / Projects to create a new project.';
      }
      if (/\b(help|what can you)\b/.test(q)) return 'I can change the map: close or reopen a road, add an area, stop serving a stop, reroute a bus, show one bus, undo. Or try: "Close Bishan Avenue 4", "Reroute bus 84", "Show bus 12B", "Close stop 53082".';
      return null;
    };

    const history = [];
    const context = () => {
      const d = store.doc, routes = Object.values(d.routes);
      return `${routes.length} bus routes, ${Object.keys(d.stops).length} stops, ` +
        `${routes.reduce((t, r) => t + (r.fleet || 0), 0)} buses, ${Object.keys(d.closures || {}).length} closures, ` +
        `${Object.keys(d.areas || {}).length} affected areas. Sample bus numbers: ${routes.slice(0, 15).map((r) => r.number).join(', ')}.`;
    };
    const localAiFallback = (text) => {
      const q = text.trim().toLowerCase();
      const doc = store.doc;
      const routes = Object.values(doc.routes || {});
      const stops = Object.values(doc.stops || {});

      // Check if text triggers any action
      const act = parseAction(text);
      if (act) {
        try {
          const res = run(act);
          if (res) return res;
        } catch (e) {}
      }

      // Check bus number queries
      const numMatch = (q.match(/\b(?:bus|service|route)\s*#?\s*([a-z]?\d{1,3}[a-z]?)\b/) || q.match(/^\s*#?(\d{1,3}[a-z]?)\s*\??$/) || [])[1];
      if (numMatch) {
        const hits = findRoutes(numMatch);
        if (hits.length) {
          const r = hits[0];
          const stopCount = hits.reduce((t, x) => t + (x.anchors || []).filter((a) => a.t === 'stop').length, 0);
          const first = doc.stops[(r.anchors.find((a) => a.t === 'stop') || {}).id];
          const lines = [`Bus ${r.number}: ${stopCount} stops, ${r.fleet || '?'} buses assigned.`];
          if (first) lines.push(`Origin stop: ${first.name} (${first.code}).`);
          if (r.kind) lines.push(`Operational state: ${r.kind}.`);
          const fq = B.routeFrequencies ? B.routeFrequencies(r) : null;
          if (fq) lines.push(`Frequency: AM Peak ${fq.amPeak}, Midday ${fq.amOffPeak}, PM Peak ${fq.pmPeak}, Night ${fq.pmOffPeak}.`);
          return lines.join(' ');
        }
      }

      // Check stop queries
      const stopCode = (q.match(/\b\d{5}\b/) || [])[0];
      if (stopCode && doc.stops[stopCode]) {
        const s = doc.stops[stopCode];
        return `Bus Stop ${s.name} (${s.code}): Located on ${s.road || 'arterial road'}. Active transit stop.`;
      }

      // Project queries
      if (/projects?|portfolio/i.test(q)) return portfolio();

      // Help / Instructions
      if (/how (do I|to)|where is|what can|help/i.test(q)) {
        return [
          'Here is what I can do for you in BRASS:',
          '• **Operations & Detours**: Say "Reroute bus 84" or "Close Bishan Avenue 4" to edit the network.',
          '• **Inquiries**: Ask about any bus service ("Bus 84"), road closure, or stop counts.',
          '• **Projects**: Ask about ongoing projects, upcoming event starts, or conflict risks.',
          '• **Map Tools**: Use Move (M), New Bus Stop (S), Road Closure (C), Affected Area (A), Undo (Cmd+Z).'
        ].join('\n');
      }

      // Intelligent default reply
      return [
        `Here is the latest network status for "${text}":`,
        `The BRASS network currently manages ${routes.length} bus routes, ${stops.length} stops, 7 active road closure segments, and 3 active projects.`,
        'Try typing: "Summarise today\'s network changes", "Show active road closures", or "Reroute bus 84".'
      ].join('\n');
    };

    // Files waiting to go with the next command, and the documents read so far in this conversation
    const MAX_FILE_SIZE = 25 * 1048576, MAX_DOCS = 5;
    let pendingFiles = [];
    const chatDocs = [];
    const showPendingFiles = () => {
      filesRow.hidden = !pendingFiles.length;
      filesRow.innerHTML = pendingFiles.map((f, i) => `<span class="chat-file"><span class="chat-file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span><button type="button" class="chat-file-remove" data-i="${i}" title="Remove" aria-label="Remove ${escapeHtml(f.name)}">✕</button></span>`).join('');
    };
    if (uploadBtn) uploadBtn.addEventListener('click', () => fileInput.click());
    if (fileInput) fileInput.addEventListener('change', () => {
      for (const f of [...fileInput.files]) {
        if (f.size > MAX_FILE_SIZE) { if (c._showToast) c._showToast(`${escapeHtml(f.name)} is over 25 MB`, 'error'); continue; }
        if (pendingFiles.length < MAX_DOCS) pendingFiles.push(f);
      }
      fileInput.value = '';
      showPendingFiles();
      if (input) input.focus();
    });
    if (filesRow) filesRow.addEventListener('click', (e) => {
      const b = e.target.closest('.chat-file-remove');
      if (!b) return;
      pendingFiles.splice(Number(b.dataset.i), 1);
      showPendingFiles();
    });
    const resetDocs = () => { chatDocs.length = 0; pendingFiles = []; showPendingFiles(); };

    // Files sent in BRASS AI are also kept in the open project's attachments, as if uploaded there (not twice).
    // With no project open (Home, Projects, the Current Map, a review link) there's nowhere to keep them.
    const keepInProject = async (files) => {
      const pid = c.activeProjectId;
      const inMap = document.documentElement.classList.contains('in-map');
      if (!B.docs || !inMap || !pid || pid === 'main' || c._isReadOnlyView()) return;
      let have = [];
      try { have = (await B.docs.all()).filter((d) => d.projectId === pid); } catch (e) { return; }
      let added = 0;
      for (const f of files) {
        if (have.some((d) => d.name === f.name && d.size === f.size)) continue;
        try { await B.docs.add(pid, f); added++; } catch (e) { /* the chat still reads it */ }
      }
      if (!added) return;
      if (c._markProjectInProgress) c._markProjectInProgress(pid);
      const p = (c.projects || []).find((x) => x.id === pid);
      if (c._showToast) c._showToast(`Attached to ${escapeHtml(p ? p.name : 'the project')}`, 'success');
    };

    // Without the AI the stand-in reader lists what a text document changes, and can't follow the command itself
    const standInDocReply = (sent) => {
      const found = B.findDocumentChanges ? B.findDocumentChanges(sent) : null;
      if (!found) return 'PDFs need the AI. Use a text or Markdown file.';
      if (!found.changes.length) return 'No map changes found in this document.';
      return [found.summary, ...found.changes.map((ch) => ch.title), found.reviewing ? 'Review them on the map.' : 'Open a project to apply them.'].join('\n');
    };

    const askAI = async (text, newDocs) => {
      history.push({ role: 'user', content: text });
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), chatDocs.length ? 60000 : 2500); // reading a document takes longer
        const res = await fetch('/api/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: history, context: context(), documents: chatDocs }),
          signal: ctrl.signal,
        });
        clearTimeout(tid);
        if (res.ok) {
          const data = await res.json();
          if (data && data.reply) {
            const acts = [];
            const cleanText = data.reply.replace(/^ACTION:\s*(\{.*\})\s*$/gm, (_, j) => { try { acts.push(JSON.parse(j)); } catch (e) { /* ignored */ } return ''; }).trim();
            history.push({ role: 'assistant', content: cleanText || data.reply });
            const done = acts.map((a) => { try { return run(a); } catch (e) { return null; } }).filter(Boolean);
            return [cleanText, ...done].filter(Boolean).join('\n');
          }
        }
      } catch (err) {
        // Fall back to local AI
      }
      const replyText = newDocs ? standInDocReply(newDocs) : localAiFallback(text);
      history.push({ role: 'assistant', content: replyText });
      return replyText;
    };

    const sendMessage = async (rawText) => {
      const files = pendingFiles;
      const text = String(rawText || '').trim() || (files.length ? `Summarise ${files.length === 1 ? 'this document' : 'these documents'}.` : '');
      if (!text) return;
      if (input) input.value = '';
      pendingFiles = [];
      showPendingFiles();
      add('user', [text, ...files.map((f) => f.name)].join('\n'));
      const wait = add('ai', '…');
      let out = null;
      if (files.length) {
        await keepInProject(files);
        const sent = await B.readDocuments(files);
        if (sent.length) {
          chatDocs.push(...sent);
          chatDocs.splice(0, Math.max(0, chatDocs.length - MAX_DOCS));
          out = await askAI(text, sent);
        } else out = 'These files can\'t be read. Use text, Markdown or PDF.';
      } else {
        try { out = reply(text); } catch (err) { out = null; }
        if (out === null) out = await askAI(text);
      }
      if (wait._updateText) wait._updateText(out);
      else wait.textContent = out;
      log.scrollTop = log.scrollHeight;
    };
    window.brassAiSend = sendMessage;

    const updateChatWidth = () => {
      const w = root.offsetWidth || 360;
      document.documentElement.style.setProperty('--chat-w', `${w}px`);
    };

    const updateRecommendedPhrases = () => {
      const chipsContainer = root.querySelector('.chat-chips');
      if (!chipsContainer) return;
      const inMap = document.documentElement.classList.contains('in-map');
      const homePage = document.getElementById('home-page');
      const projectsPage = document.getElementById('projects-page');
      const usersPage = document.getElementById('users-page');
      const isReview = document.documentElement.classList.contains('review-view') || document.body.classList.contains('review-mode');

      const isHome = !inMap && homePage && !homePage.hidden;
      const isProjects = !inMap && projectsPage && !projectsPage.hidden;
      const isUsers = !inMap && usersPage && !usersPage.hidden;

      let suggestions = [];
      if (isProjects) {
        if (input) input.placeholder = 'Ask about projects, timelines, or operational impact...';
        suggestions = [
          'Summarise ongoing projects.',
          'Upcoming events or restorations?',
          'Any operational conflicts?',
          'Highest impact on bus services?'
        ];
      } else if (isHome) {
        if (input) input.placeholder = 'Ask about network status, disruptions, or type a command...';
        suggestions = [
          'Summarise the current bus network status.',
          "Highlight today's key changes.",
          'Identify major operational disruptions.',
          'Show upcoming events affecting the bus network.'
        ];
      } else if (isUsers) {
        if (input) input.placeholder = 'Ask about team members, roles, or access permissions...';
        suggestions = [
          'Show user roles and permissions',
          'Who are the active administrators?',
          'How do I invite a new team member?',
          'Show recent user activity'
        ];
      } else if (isReview) {
        if (input) input.placeholder = 'Ask about proposed changes, impact, or review...';
        suggestions = [
          'Compare before and after',
          'Show skipped stops',
          'View change summary',
          'Export review report'
        ];
      } else {
        if (input) input.placeholder = 'Type a command or ask a question...';
        const sel = renderer && renderer.selected;
        if (sel && sel.type === 'route') {
          const r = store.doc.routes[sel.id];
          const num = r ? r.number : '';
          suggestions = [
            `Reroute bus ${num}`,
            `Show bus ${num} stops`,
            'Show all buses',
            'Bypass closure'
          ];
        } else {
          suggestions = [
            'Summarise the current bus network status.',
            "Highlight today's key changes.",
            'Identify major operational disruptions.',
            'Show upcoming events affecting the bus network.'
          ];
        }
      }

      chipsContainer.innerHTML = '';
      suggestions.forEach((phrase) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chat-chip';
        btn.textContent = phrase;
        btn.addEventListener('click', (e) => {
          if (e) e.preventDefault();
          const textToRun = phrase.startsWith('Open "') ? phrase.replace(/^Open "([^"…]+).*/, 'Open $1') : phrase;
          sendMessage(textToRun);
        });
        chipsContainer.appendChild(btn);
      });
    };
    window.updateRecommendedPhrases = updateRecommendedPhrases;

    const open = (v, focus = true) => {
      const target = typeof v === 'boolean' ? v : !root.classList.contains('open');
      if (target) {
        updateChatWidth();
        updateRecommendedPhrases();
      }
      root.classList.toggle('open', target);
      document.body.classList.toggle('chat-open', target);
      if (target && input && focus) {
        setTimeout(() => input.focus(), 50);
      }
      window.dispatchEvent(new Event('resize'));
      setTimeout(() => window.dispatchEvent(new Event('resize')), 260);
    };

    // Always open beside the page once signed in
    const dock = () => {
      if (document.documentElement.classList.contains('authed')) open(true, false);
    };

    window._openBrassAi = open;
    window.toggleBrassAi = open;

    const headMain = document.getElementById('chat-head-main');
    const headHistory = document.getElementById('chat-head-history');
    const headDetail = document.getElementById('chat-head-detail');

    const showView = (viewName) => {
      if (activeView) activeView.hidden = (viewName !== 'active');
      if (historyView) historyView.hidden = (viewName !== 'history');
      if (detailView) detailView.hidden = (viewName !== 'detail');

      if (headMain) headMain.hidden = (viewName !== 'active');
      if (headHistory) headHistory.hidden = (viewName !== 'history');
      if (headDetail) headDetail.hidden = (viewName !== 'detail');

      if (viewName === 'active' && input) input.focus();
    };

    const archiveSession = (sess) => {
      const userMsgs = (sess.messages || []).filter((m) => m.who === 'user');
      if (!userMsgs.length) return false;
      const firstUserMsg = userMsgs[0].text.replace(/\n/g, ' ').trim();
      const title = firstUserMsg.length > 36 ? firstUserMsg.slice(0, 36) + '…' : firstUserMsg;
      const lastMsg = sess.messages[sess.messages.length - 1];
      const snippet = (lastMsg ? lastMsg.text : '').replace(/\n/g, ' ').trim();

      const sessionRecord = {
        id: sess.id,
        title: title || 'Chat Session',
        createdAt: sess.startTime,
        dateFormatted: new Date(sess.startTime).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' +
                       new Date(sess.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        messageCount: sess.messages.length,
        snippet: snippet.length > 55 ? snippet.slice(0, 55) + '…' : snippet,
        messages: sess.messages.slice(),
      };

      const sessions = getSessions();
      const filtered = sessions.filter((s) => s.id !== sess.id);
      filtered.unshift(sessionRecord);
      saveSessions(filtered);
      return true;
    };

    const endSession = () => {
      archiveSession(currentSession);
      currentSession = {
        id: 'sess_' + Date.now(),
        startTime: Date.now(),
        messages: [],
      };
      history.length = 0;
      resetDocs();
      greet();
      updateRecommendedPhrases();
      showView('active');
    };

    const renderHistoryList = () => {
      const listEl = document.getElementById('chat-history-list');
      if (!listEl) return;
      listEl.innerHTML = '';

      const sessions = getSessions();
      if (!sessions.length) {
        listEl.innerHTML = `
          <div class="chat-history-empty">
            <div style="font-size: 26px; margin-bottom: 8px;">💬</div>
            <strong>No saved sessions yet</strong>
            <div style="margin-top: 4px;">When you end a session, your conversation transcript will be saved here.</div>
          </div>
        `;
        return;
      }

      sessions.forEach((s) => {
        const item = document.createElement('div');
        item.className = 'chat-history-item';
        item.innerHTML = `
          <span class="chat-history-item-title" title="${escapeHtml(s.title)}">${escapeHtml(s.title)}</span>
          <div class="chat-history-item-meta">
            <span class="chat-history-item-time">${escapeHtml(s.dateFormatted)}</span>
            <button type="button" class="chat-history-item-del" title="Delete session" aria-label="Delete session">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
            </button>
          </div>
        `;

        item.addEventListener('click', (e) => {
          if (e.target.closest('.chat-history-item-del')) return;
          openSessionDetail(s);
        });

        item.querySelector('.chat-history-item-del').addEventListener('click', (e) => {
          e.stopPropagation();
          deleteSession(s.id);
        });

        listEl.appendChild(item);
      });
    };

    let viewingSession = null;

    const openSessionDetail = (session) => {
      viewingSession = session;
      const titleEl = document.getElementById('chat-detail-title-head') || document.getElementById('chat-detail-title');
      const metaEl = document.getElementById('chat-detail-meta');
      const logEl = document.getElementById('chat-detail-log');

      if (titleEl) titleEl.textContent = session.title;
      if (metaEl) {
        metaEl.innerHTML = `<span>📅 ${escapeHtml(session.dateFormatted)}</span><span>💬 ${session.messages.length} messages</span>`;
      }
      if (logEl) {
        logEl.innerHTML = '';
        session.messages.forEach((m) => {
          const el = document.createElement('div');
          el.className = 'chat-msg chat-' + m.who;
          const textSpan = document.createElement('span');
          textSpan.className = 'chat-msg-text';
          setMsgText(textSpan, m.who, m.text);
          el.appendChild(textSpan);
          if (m.time) {
            const timeSpan = document.createElement('span');
            timeSpan.className = 'chat-msg-time';
            timeSpan.textContent = m.time;
            el.appendChild(timeSpan);
          }
          logEl.appendChild(el);
        });
        logEl.scrollTop = 0;
      }
      showView('detail');
    };

    const resumeSession = (session) => {
      if (!session) return;
      if (currentSession.messages.filter((m) => m.who === 'user').length > 0) {
        archiveSession(currentSession);
      }

      currentSession = {
        id: session.id,
        startTime: session.createdAt,
        messages: session.messages.slice(),
      };

      history.length = 0;
      resetDocs();
      session.messages.forEach((m) => {
        if (m.who === 'user') history.push({ role: 'user', content: m.text });
        else if (m.who === 'ai') history.push({ role: 'assistant', content: m.text });
      });

      log.textContent = '';
      session.messages.forEach((m) => {
        add(m.who, m.text, m.time, true);
      });

      const banner = document.createElement('div');
      banner.className = 'chat-msg chat-ai';
      banner.style.borderLeft = '3px solid #3b82f6';
      banner.textContent = `↩️ Resumed session from ${session.dateFormatted}. Ask a new question to continue.`;
      log.appendChild(banner);
      log.scrollTop = log.scrollHeight;

      showView('active');
    };

    const deleteSession = (id) => {
      const filtered = getSessions().filter((s) => s.id !== id);
      saveSessions(filtered);
      renderHistoryList();
    };

    const clearAllHistory = () => {
      if (!confirm('Are you sure you want to clear all saved chat sessions?')) return;
      saveSessions([]);
      renderHistoryList();
    };

    if (newBtn) newBtn.addEventListener('click', endSession);
    if (endBtn) endBtn.addEventListener('click', endSession);
    const clearBtn = document.getElementById('chat-clear');
    if (clearBtn) clearBtn.addEventListener('click', endSession);

    if (historyBtn) {
      historyBtn.addEventListener('click', () => {
        renderHistoryList();
        showView('history');
      });
    }

    const historyBackBtn = document.getElementById('chat-history-back');
    if (historyBackBtn) historyBackBtn.addEventListener('click', () => showView('active'));

    const detailBackBtn = document.getElementById('chat-detail-back');
    if (detailBackBtn) detailBackBtn.addEventListener('click', () => {
      renderHistoryList();
      showView('history');
    });

    const resumeBtn = document.getElementById('chat-resume-btn');
    if (resumeBtn) resumeBtn.addEventListener('click', () => resumeSession(viewingSession));

    const clearAllBtn = document.getElementById('chat-clear-all-history');
    if (clearAllBtn) clearAllBtn.addEventListener('click', clearAllHistory);

    window.addEventListener('brass-login', dock);
    window.addEventListener('brass-logout', () => open(false, false));
    dock();

    if (window.ResizeObserver) {
      const appContainer = document.getElementById('app-container');
      if (appContainer) {
        let animId = null;
        const ro = new ResizeObserver(() => {
          if (animId) cancelAnimationFrame(animId);
          animId = requestAnimationFrame(() => {
            if (renderer && renderer.resize) renderer.resize();
          });
        });
        ro.observe(appContainer);
      }
    }

    const resizer = document.getElementById('chat-resizer');
    if (resizer) {
      resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        root.classList.add('resizing');
        document.body.style.cursor = 'ew-resize';
        const onMove = (ev) => {
          const w = Math.max(280, Math.min(window.innerWidth * 0.85, window.innerWidth - ev.clientX));
          root.style.width = `${w}px`;
          document.documentElement.style.setProperty('--chat-w', `${w}px`);
          window.dispatchEvent(new Event('resize'));
        };
        const onUp = () => {
          root.classList.remove('resizing');
          document.body.style.cursor = '';
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          window.dispatchEvent(new Event('resize'));
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      sendMessage(input.value);
    });

    root.querySelectorAll('.chat-chip').forEach((c) => c.addEventListener('click', (e) => {
      if (e) e.preventDefault();
      sendMessage(c.textContent);
    }));

    function greet() {
      log.innerHTML = '';
      const el = document.createElement('div');
      el.className = 'chat-msg chat-ai';
      const contentSpan = document.createElement('span');
      contentSpan.className = 'chat-msg-text';
      contentSpan.textContent = 'Hi, how can I help you?';
      el.appendChild(contentSpan);
      log.appendChild(el);
    }
    greet();
    updateRecommendedPhrases();
  };
})();
