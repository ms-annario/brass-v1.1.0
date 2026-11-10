/* BRASS — the 2026 sample projects: 10 named projects through every stage, each with real changes on this map.
 * Seeded once, before the Current Map, its history and the date-range schedule load, and with no documents attached.
 * What it replaces is kept: small entries in brass_backup_projects, maps under brass_proj_doc_backup__<their key>. */
(function () {
  const B = window.B;
  const VERSION = '2026.2';
  const FLAG = 'brass_sample_projects';
  const DAY = 86400000;
  const at = (s) => new Date(s.replace(' ', 'T')).getTime();

  // [name, stage, period, owner, collaborators, changes]
  // period: ['start', 'end'] for a Temporary change, or the day a Permanent change goes live
  // changes: area (a zone that closes the roads in it) · close (a stretch of a road)
  //          bus (a new service between two interchanges) · withdraw (a bus number) · stop (a new stop)
  const PROJECTS = [
    // Permanent changes already on the Current Map
    ['Bus 12B: Bishan – Toa Payoh Express', 'go_live', '2026-02-22', 'bops-1', ['lead-1', 'bops-2'], [{ bus: '12B', from: 'Bishan Int', to: 'Toa Payoh Int', express: 2 }]],
    ['Bus 75 Withdrawal & Express 118X', 'go_live', '2026-03-29', 'lead-1', ['bops-1'], [{ withdraw: '75' }, { bus: '118X', from: 'Tampines Int', to: 'Changi Int', express: 3 }]],
    ['Tengah MRT Bus Stop Opening', 'go_live', '2026-09-27', 'ops-3', ['bops-2'], [{ stop: 'Tengah Stn Exit A', at: 'mrt:Tengah' }]],
    // Temporary changes that have ended
    ['Chingay Parade 2026', 'archive', ['2026-02-20 16:00', '2026-02-21 23:30'], 'bops-1', ['lead-1', 'bops-2'], [{ area: 'Chingay Parade Route', at: 'mrt:Downtown Core', r: 450 }]],
    ['National Day Parade 2026', 'archive', ['2026-08-09 12:00', '2026-08-09 23:30'], 'bops-1', ['lead-1'], [{ area: 'NDP 2026 Zone', at: 'mrt:Kallang', r: 650 }, { close: 'Upper Paya Lebar Road', at: 'mrt:Upper Paya Lebar', r: 700 }]],
    ['Singapore Grand Prix 2026: Marina Bay', 'archive', ['2026-10-05 00:00', '2026-10-13 06:00'], 'bops-1', ['lead-1', 'eng-1'], [{ area: 'Marina Bay Street Circuit', at: 'mrt:Downtown Core', r: 700 }]],
    // A temporary change live now, and one scheduled
    ['Deepavali Light-Up 2026: Serangoon Road', 'go_live', ['2026-10-03 18:00', '2026-11-16 02:00'], 'bops-2', ['bops-1'], [{ close: 'Serangoon Road', at: 'mrt:Balestier', r: 800 }]],
    ['Christmas on A Great Street 2026: Orchard Road', 'schedule', ['2026-11-14 18:00', '2026-12-27 02:00'], 'bops-1', ['bops-2'], [{ close: 'Orchard Road', at: 'mrt:Orchard', r: 700 }]],
    // Still being prepared
    ['Tampines Avenue 10 Resurfacing (Jan 2027)', 'review', ['2027-01-10 22:00', '2027-01-31 05:00'], 'bops-2', ['eng-1'], [{ close: 'Tampines Avenue 10', at: 'Tampines Int', r: 600 }]],
    ['Punggol Digital District Shuttle 82A', 'progress', '2027-02-21', 'bops-1', ['ops-3'], [{ bus: '82A', from: 'Punggol Int', to: 'Seletar Int' }]],
  ];

  // The changes, made on a map the way the editor makes them
  const changer = (city, net) => {
    const intStop = (doc, name) => Object.values(doc.stops).find((s) => B.isInterchange(s) && s.name === name);
    const placeOf = (doc, p) => {
      if (p.startsWith('mrt:')) {
        const m = (city.mrtStations || []).find((x) => x.name === p.slice(4));
        return m && { x: m.x, y: m.y };
      }
      const st = intStop(doc, p);
      return st && net.posPoint(st, 0.78);
    };
    // The stretch of a road nearest a place (its closest pieces when none are within r)
    const stretch = (road, p, r) => {
      const near = net.edges
        .filter((e) => e && e.name === road)
        .map((e) => ({ id: e.id, d: Math.min(...e.pts.map((q) => Math.hypot(q.x - p.x, q.y - p.y))) }))
        .sort((a, b) => a.d - b.d);
      const inside = near.filter((x) => x.d <= r);
      return (inside.length ? inside : near.slice(0, 3)).map((x) => x.id);
    };
    const routesNumbered = (doc, num) => Object.values(doc.routes).filter((r) => String(r.number).trim() === num);
    const newId = (doc, prefix) => prefix + doc.seq++;
    // A new service along the roads from one interchange to the other, stopping at the stops on the way
    const service = (doc, o) => {
      const a = intStop(doc, o.from), b = intStop(doc, o.to);
      if (!a || !b) return;
      const leg = net.route({ edge: a.edge, s: a.s, dir: a.dir }, { edge: b.edge, s: b.s, dir: b.dir });
      if (!leg.ok) return;
      const lanes = new Map();
      for (const st of Object.values(doc.stops)) {
        if (st.active === false) continue;
        const k = st.edge * 2 + (st.dir > 0 ? 0 : 1);
        if (lanes.has(k)) lanes.get(k).push(st); else lanes.set(k, [st]);
      }
      let ids = [a.id];
      for (const sg of leg.segs) {
        const lo = Math.min(sg.s0, sg.s1) - 1, hi = Math.max(sg.s0, sg.s1) + 1;
        (lanes.get(sg.edge * 2 + (sg.dir > 0 ? 0 : 1)) || [])
          .filter((st) => st.s >= lo && st.s <= hi)
          .sort((x, y) => (sg.dir > 0 ? x.s - y.s : y.s - x.s))
          .forEach((st) => { if (!ids.includes(st.id)) ids.push(st.id); });
      }
      if (!ids.includes(b.id)) ids.push(b.id);
      const step = Math.max(o.express || 1, Math.ceil(ids.length / 24));
      if (step > 1) ids = ids.filter((id, k) => k === 0 || k === ids.length - 1 || k % step === 0);
      if (ids.length < 3) return;
      const id = newId(doc, 'R');
      doc.routes[id] = {
        id, number: o.bus, name: `Bus ${o.bus} (${a.name} ➔ ${b.name})`,
        color: B.pickRouteColor(Object.values(doc.routes).map((r) => r.color)),
        kind: 'proposed', baseId: null, override: false,
        hours: { start: '05:45', end: '23:30' }, days: B.ALL_DAYS.slice(), fleet: o.fleet || 6,
        anchors: ids.map((sid) => ({ t: 'stop', id: sid })),
      };
    };
    const make = {
      area: (doc, o) => {
        const p = placeOf(doc, o.at);
        if (!p) return;
        const id = newId(doc, 'A');
        doc.areas[id] = { id, name: o.area, shape: 'circle', cx: Math.round(p.x), cy: Math.round(p.y), r: o.r };
      },
      close: (doc, o, name) => {
        const p = placeOf(doc, o.at);
        if (p) B.ops.setClosed(doc, stretch(o.close, p, o.r), true, { reason: name });
      },
      bus: service,
      withdraw: (doc, o) => routesNumbered(doc, o.withdraw).forEach((r) => { r.active = false; }),
      stop: (doc, o, name, when) => {
        const p = placeOf(doc, o.at);
        const cls = p && net.classify(p, 160);
        if (!cls || !cls.pos) return;
        const near = Object.values(doc.stops).reduce((best, s) => {
          const q = net.posPoint(s, 0.78), d = Math.hypot(q.x - p.x, q.y - p.y);
          return !best || d < best.d ? { s, d } : best;
        }, null);
        const id = newId(doc, 'S');
        doc.stops[id] = {
          id, code: (near ? near.s.code.slice(0, 2) : '99') + '9' + String(doc.seq % 100).padStart(2, '0'), name: o.stop,
          edge: cls.edge, s: cls.pos.s, dir: cls.pos.dir, kind: 'proposed', userCreated: true, createdAt: when,
        };
      },
    };
    return (doc, o, name, when) => {
      const kind = Object.keys(make).find((k) => k in o);
      try { make[kind](doc, o, name, when); } catch (e) { console.warn('Sample change skipped', name, e); }
    };
  };

  // Projects, maps, history and schedules from before are set aside, and attached documents removed
  const SAMPLE_KEYS = /^(brass_projects_list|brass_active_project_id|brass_proj_doc_|brass_proj_base_|brass_map_versions|brass_map_snapshot_|brass_map_before_|brass_project_map_|brass_scheduled_changes|brass_scheduled_base|brass_seeded_default_docs_v1|brass\.doc\.)/;
  const MAPS = /^(brass_proj_doc_|brass_proj_base_|brass_map_snapshot_|brass_project_map_|brass_scheduled_base$|brass\.doc\.)/;
  const putAside = (now) => {
    Object.keys(localStorage).filter((x) => x.startsWith('brass_proj_doc_backup__')).forEach((x) => localStorage.removeItem(x));
    const small = {};
    for (const k of Object.keys(localStorage).filter((x) => SAMPLE_KEYS.test(x))) {
      const v = localStorage.getItem(k);
      if (v == null) continue;
      if (MAPS.test(k)) { try { localStorage.setItem('brass_proj_doc_backup__' + k, v); } catch (e) { /* no room: not kept */ } }
      else small[k] = v;
      localStorage.removeItem(k);
    }
    if (Object.keys(small).length) localStorage.setItem('brass_backup_projects', JSON.stringify({ at: now, entries: small }));
    if (B.docs) B.docs.all().then((list) => list.forEach((d) => B.docs.remove(d.id))).catch(() => {});
  };

  B.seedSampleProjects = (c) => {
    try { if (localStorage.getItem(FLAG) === VERSION) return; } catch (e) { return; }
    try {
      const now = Date.now();
      putAside(now);
      const users = Object.fromEntries((B.SYSTEM_USERS || []).map((u) => [u.id, { name: u.name, email: u.email, role: u.role }]));
      const change = changer(c.city, c.net);
      const clone = (d) => JSON.parse(JSON.stringify(d));
      const pad = (n) => String(n).padStart(2, '0');
      const day = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
      const time = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

      const list = PROJECTS.map(([name, stage, period, owner, collabs, changes], i) => {
        const temp = Array.isArray(period);
        const start = at(temp ? period[0] : period + ' 05:30');
        const end = temp ? at(period[1]) : null;
        const lead = (20 + (i * 11) % 30) * DAY;
        const preparing = !['go_live', 'archive', 'schedule'].includes(stage);
        const createdAt = Math.min(preparing ? now - lead : start - lead, now - DAY);
        let updatedAt = now - ((i * 13) % 9 + 1) * DAY;
        if (stage === 'go_live') updatedAt = Math.min(start, now);
        if (stage === 'archive') updatedAt = Math.min(end + 2 * DAY, now);
        if (stage === 'schedule') updatedAt = Math.min(createdAt + 6 * DAY, now);
        return { name, stage, temp, start, end, owner, collabs, changes, createdAt, updatedAt: Math.max(updatedAt, createdAt) };
      });
      // Ids follow the order they were created in
      [...list].sort((a, b) => a.createdAt - b.createdAt).forEach((s, i) => { s.id = `prj-${i + 1}`; });

      let main = JSON.parse(c.store.sample);
      const versions = [], schedules = [];
      const version = (entry, snapshot) => {
        const v = Object.assign({ id: `ver-${entry.appliedAt}-${versions.length + 1}`, status: null }, entry);
        if (snapshot) { localStorage.setItem('brass_map_snapshot_' + v.id, JSON.stringify(snapshot)); v.hasSnapshot = true; }
        versions.push(v);
      };
      version({ type: 'start', projectName: 'Starting point', appliedAt: at('2026-01-01 00:00') }, main);

      // Through the year: each project starts from the Current Map of its time
      for (const s of [...list].sort((a, b) => a.start - b.start)) {
        const base = clone(main), doc = clone(main);
        s.changes.forEach((o) => change(doc, o, s.name, s.start));
        localStorage.setItem('brass_proj_base_' + s.id, JSON.stringify(base));
        localStorage.setItem('brass_proj_doc_' + s.id, JSON.stringify(doc));
        const ref = { projectId: s.id, projectName: s.name };
        const scheduledAt = Math.min(s.createdAt + 10 * DAY, s.start, now);
        if (s.stage === 'go_live' && !s.temp) {
          main = doc;
          version(Object.assign({ type: 'permanent', appliedAt: s.start }, ref), main);
        } else if (s.stage === 'archive') {
          version(Object.assign({ type: 'temporary', scheduleId: 'sched-' + s.id, start: s.start, end: s.end, appliedAt: scheduledAt, status: 'ended', endedAt: s.end }, ref));
        } else if (s.stage === 'go_live' || s.stage === 'schedule') {
          // Waiting in the schedule: the app puts it live once its start has passed
          schedules.push(Object.assign({ id: 'sched-' + s.id, start: s.start, end: s.end, status: 'pending', patch: c._diffDocs(main, doc), createdAt: scheduledAt }, ref));
          version(Object.assign({ type: 'temporary', scheduleId: 'sched-' + s.id, start: s.start, end: s.end, appliedAt: scheduledAt }, ref));
        }
      }
      versions.sort((a, b) => a.appliedAt - b.appliedAt).forEach((v, i) => { v.version = i; });

      const projects = [...list].sort((a, b) => a.createdAt - b.createdAt).map((s) => ({
        id: s.id,
        name: s.name,
        mode: ['go_live', 'archive'].includes(s.stage) ? 'view' : 'edit',
        status: s.stage,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        owner: users[s.owner],
        // John Doe, who the app opens as, works on every project, so all of them are in his list
        collaborators: [...new Set(s.owner === 'bops-1' ? s.collabs : ['bops-1', ...s.collabs])]
          .filter((u) => users[u]).map((u) => Object.assign({ addedAt: s.createdAt + DAY }, users[u])),
        applyPeriod: s.temp
          ? { mode: 'scheduled', startDate: day(s.start), startTime: time(s.start), endDate: day(s.end), endTime: time(s.end), repeat: 'none' }
          : { mode: 'permanent', startDate: day(s.start), startTime: time(s.start) },
      }));

      const mainStr = JSON.stringify(main);
      localStorage.setItem('brass_proj_doc_main', mainStr);
      localStorage.setItem(c.store.KEY, mainStr);
      localStorage.setItem('brass_map_versions', JSON.stringify(versions));
      localStorage.setItem('brass_scheduled_changes', JSON.stringify(schedules));
      localStorage.setItem('brass_projects_list', JSON.stringify(projects));
      const opening = projects.find((p) => p.status === 'progress' && p.owner && p.owner.email === 'john.doe@brass.sg');
      localStorage.setItem('brass_active_project_id', opening ? opening.id : 'main');
      localStorage.setItem(FLAG, VERSION);
    } catch (e) {
      console.warn('Could not create the sample projects', e);
    }
  };
})();
