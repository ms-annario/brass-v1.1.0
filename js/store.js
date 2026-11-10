/* BRASS — editable document, history (undo/redo), save/reset and derived geometry.
 * Road geometry is immutable city data; the document only stores editable objects:
 * stops, routes (anchors), accidents, affected areas and road closures — each separately.
 */
(function () {
  const B = window.B;
  const SPEED_MS = 5.3;   // ≈19 km/h average bus running speed (illustrative)
  const DWELL_S = 25;     // per-stop dwell (illustrative)

  B.Store = class {
    constructor(city, net, sampleDoc) {
      this.city = city; this.net = net;
      this.KEY = 'brass.doc.' + B.MAP_VERSION;
      this.sample = JSON.stringify(sampleDoc);
      let saved = null;
      try { saved = localStorage.getItem(this.KEY); } catch (e) { /* storage unavailable */ }
      if (saved && !this._validDoc(saved)) saved = null;
      this.saved = saved || this.sample;
      this.doc = JSON.parse(this.saved);

      // Ensure 3 more active bus routes exist (total at least 6 active bus routes)
      const currentRouteCount = Object.keys(this.doc.routes).length;
      if (currentRouteCount < 6) {
        const existingNums = Object.values(this.doc.routes).map((r) => r.number);
        const pool = ['12', '33', '65', '14', '80', '190', '48', '77', '106'];
        const needed = 6 - currentRouteCount;
        const newNums = pool.filter((n) => !existingNums.includes(n)).slice(0, needed);
        B.generateRandomRoutes(city, net, this.doc, needed, newNums);
      }

      // Ensure bus interchanges exist and are assigned in the document
      if (!this.doc.interchanges) this.doc.interchanges = {};
      for (const st of Object.values(this.doc.stops || {})) {
        if (B.isInterchange(st)) {
          st.isInterchange = true;
          if (!this.doc.interchanges[st.id]) {
            this.doc.interchanges[st.id] = {
              id: st.id,
              stopId: st.id,
              name: st.name.replace(/\s+Int$/i, ' Bus Interchange'),
              shortName: st.name,
              edge: st.edge,
            };
          }
        }
      }

      // Clean up any redundant consecutive stops closer than 220m on existing routes
      for (const r of Object.values(this.doc.routes || {})) {
        if (!r.anchors || r.anchors.length <= 2) continue;
        const cleaned = [r.anchors[0]];
        for (let i = 1; i < r.anchors.length - 1; i++) {
          const prev = cleaned[cleaned.length - 1];
          const cur = r.anchors[i];
          if (prev.t === 'stop' && cur.t === 'stop') {
            const stPrev = this.doc.stops[prev.id];
            const stCur = this.doc.stops[cur.id];
            if (stPrev && stCur) {
              const p1 = net.posPoint(stPrev, 0.78);
              const p2 = net.posPoint(stCur, 0.78);
              if (Math.hypot(p1.x - p2.x, p1.y - p2.y) < 220 && !B.isInterchange(stCur)) {
                continue; // drop duplicate / colliding stop
              }
            }
          }
          cleaned.push(cur);
        }
        const last = r.anchors[r.anchors.length - 1];
        if (cleaned.length > 1 && last.t === 'stop') {
          const prev = cleaned[cleaned.length - 1];
          const stPrev = this.doc.stops[prev.id];
          const stLast = this.doc.stops[last.id];
          if (stPrev && stLast) {
            const p1 = net.posPoint(stPrev, 0.78);
            const p2 = net.posPoint(stLast, 0.78);
            if (Math.hypot(p1.x - p2.x, p1.y - p2.y) < 220 && !B.isInterchange(stPrev) && B.isInterchange(stLast)) {
              cleaned.pop();
            }
          }
        }
        cleaned.push(last);
        r.anchors = cleaned;
      }
      this.baseTemplate = JSON.stringify(this.doc);

      this.past = []; this.future = []; this.tx = null;
      this.legCache = new Map();
      this.derive();
    }

    _validDoc(str) {
      try {
        const d = JSON.parse(str);
        return d && d.map === B.MAP_VERSION && d.stops && d.routes && Object.values(d.stops).every((s) => this.net.edges[s.edge]);
      } catch (e) { return false; }
    }

    // ------------------------------------------------------------- history
    commit(label, fn) {
      const snap = JSON.stringify(this.doc);
      const res = fn(this.doc);
      if (JSON.stringify(this.doc) !== snap) {
        this.past.push({ doc: snap, label }); if (this.past.length > 120) this.past.shift();
        this.future = [];
      }
      this.changed(label);
      return res;
    }
    begin() { if (this.tx === null) this.tx = JSON.stringify(this.doc); }
    // Mouse events outrun the screen, so a drag works the routes out once per frame
    live() {
      if (this._liveFrame) return;
      this._liveFrame = requestAnimationFrame(() => {
        this._liveFrame = null;
        this.changed(null, true);
      });
    }
    end(label) {
      if (this.tx === null) return false;
      const changed = this.tx !== JSON.stringify(this.doc);
      if (changed) { this.past.push({ doc: this.tx, label }); if (this.past.length > 120) this.past.shift(); this.future = []; }
      this.tx = null; this.changed(changed ? label : null);
      return changed;
    }
    cancel() { if (this.tx !== null) { this.doc = JSON.parse(this.tx); this.tx = null; this.changed(null); } }
    undo() {
      if (!this.past.length) return null;
      const it = this.past.pop();
      this.future.push({ doc: JSON.stringify(this.doc), label: it.label });
      this.doc = JSON.parse(it.doc); this.changed('Undo'); return it.label;
    }
    redo() {
      if (!this.future.length) return null;
      const it = this.future.pop();
      this.past.push({ doc: JSON.stringify(this.doc), label: it.label });
      this.doc = JSON.parse(it.doc); this.changed('Redo'); return it.label;
    }
    loadDoc(docOrString, options = {}) {
      let parsed = null;
      if (typeof docOrString === 'string') {
        try { parsed = JSON.parse(docOrString); } catch (e) {}
      } else if (docOrString && typeof docOrString === 'object') {
        parsed = JSON.parse(JSON.stringify(docOrString));
      }
      if (!parsed || !this._validDoc(JSON.stringify(parsed))) {
        parsed = JSON.parse(this.baseTemplate || this.sample);
      }
      this.doc = parsed;
      this.past = [];
      this.future = [];
      this.tx = null;
      // The roads never change, so the legs worked out for one map still hold for the next
      this.saved = JSON.stringify(this.doc);
      this.changed(options.label || 'Load Draft'); // works the map out again, then tells everyone
    }
    save(storageKey) {
      this.saved = JSON.stringify(this.doc);
      const key = storageKey || this.KEY;
      try { localStorage.setItem(key, this.saved); } catch (e) { /* ignore */ }
      this.changed('Saved');
    }
    newId(prefix) { return prefix + this.doc.seq++; }

    changed(label, live) {
      if (this._liveFrame) { cancelAnimationFrame(this._liveFrame); this._liveFrame = null; }
      this.derive();
      B.events.emit('doc', { label, live: !!live });
    }

    // ------------------------------------------------------------- derived
    areaPoly(a) { return a.shape === 'circle' ? B.circlePoly(a.cx, a.cy, a.r, 48) : a.pts; }

    derive() {
      const d = this.doc;
      this.rev = (this.rev || 0) + 1; // bumps on every change; keys the detour options cache
      d.closures = d.closures || {};
      d.areas = d.areas || {};
      this.areaEdges = {}; this.affected = new Map();
      for (const a of Object.values(d.areas)) {
        const ids = this.net.edgesInPolygon(this.areaPoly(a));
        this.areaEdges[a.id] = ids;
        for (const id of ids) { if (!this.affected.has(id)) this.affected.set(id, []); this.affected.get(id).push(a.id); }
      }
      // Roads another project blocks at the same time count as affected here too (set by the controller)
      if (this.extraAffected) for (const id of this.extraAffected) if (!this.affected.has(id)) this.affected.set(id, []);
      // Every road segment intersecting an affected area is closed while the area covers it
      for (const [edgeKey, cl] of Object.entries(d.closures)) {
        if (!cl) continue;
        const byReasonArea = (typeof cl.reason === 'string' && cl.reason.startsWith('Closed by '))
          ? Object.values(d.areas).find((ar) => cl.reason === `Closed by ${ar.name}`)
          : null;
        const ownerAreaId = cl.areaId || (byReasonArea && byReasonArea.id) || null;
        if (ownerAreaId) {
          const areaNow = d.areas[ownerAreaId];
          const edgeNum = Number(edgeKey);
          const stillInside = Boolean(areaNow && (this.areaEdges[ownerAreaId] || []).includes(edgeNum));
          if (!stillInside) delete d.closures[edgeKey];
        } else if (typeof cl.reason === 'string' && cl.reason.startsWith('Closed by ')) {
          delete d.closures[edgeKey];
        }
      }
      for (const a of Object.values(d.areas)) {
        const ids = this.areaEdges[a.id] || [];
        for (const id of ids) {
          if (!d.closures[id]) {
            d.closures[id] = { reason: `Closed by ${a.name || a.id}`, areaId: a.id };
          }
        }
      }
      this.closedSet = new Set(Object.keys(d.closures).map(Number));
      this.closedKey = [...this.closedSet].sort((a, b) => a - b).join(',');
      this.geom = {}; this.stopRoutes = {}; this.stopLines = {};
      // Stops by lane (road + direction), so each stretch a route drives only looks at the stops on it
      const laneStops = new Map();
      for (const st of Object.values(d.stops)) {
        const key = st.edge * 2 + (st.dir > 0 ? 0 : 1);
        const arr = laneStops.get(key);
        if (arr) arr.push(st); else laneStops.set(key, [st]);
      }

      // For a normal route with no affected areas, road closures, or rejected constraints, won't have detour applied
      const hasAnyClosures = this.closedSet && this.closedSet.size > 0;
      const hasAnyAreas = (d.areas && Object.keys(d.areas).length > 0) || (this.affected && this.affected.size > 0) || (this.extraBlocked && this.extraBlocked.size > 0);

      for (const r of Object.values(d.routes)) {
        if (r.isChunk) {
          delete r.originalAnchors;
          delete r.detourApplied;
          delete r.viaName;
          delete r.detourTitle;
          delete r.activeOptionIdx;
          continue;
        }
        const rejEdges = this.rejectedConstraintEdges(r);
        const hasRej = rejEdges && rejEdges.size > 0;
        if (r.detourApplied) {
          if (!hasAnyClosures && !hasAnyAreas && !hasRej) {
            this._clearDetour(r);
          } else {
            const checkAnchors = r.originalAnchors || r.anchors;
            const gCheck = this.computeRoute({ anchors: checkAnchors, kind: 'existing', number: r.number, constraintDecisions: r.constraintDecisions });
            const isAffected = (gCheck.conflicts && gCheck.conflicts.length > 0) ||
                               (gCheck.rejectedConflicts && gCheck.rejectedConflicts.length > 0) ||
                               (gCheck.stopsOnClosed && gCheck.stopsOnClosed.length > 0) ||
                               (gCheck.legs && gCheck.legs.some(l => l.ok && l.segs && l.segs.some(sg => this.closedSet.has(sg.edge) || rejEdges.has(sg.edge) || (this.extraBlocked && this.extraBlocked.has(sg.edge)) || (this.affected && this.affected.has(sg.edge)))));
            if (!isAffected) {
              this._clearDetour(r);
            }
          }
        }
      }

      // First pass: register canonical constraints for whole (unchunked) routes
      const wholeRouteGeom = new Map(); // the second pass uses these rather than working each route out twice
      for (const r of Object.values(d.routes)) {
        if (!r.isChunk) {
          const g = this.computeRoute(r);
          wholeRouteGeom.set(r.id, g);
          const c = this._buildRouteConstraint(r, g);
          if (c) {
            this._canonicalConstraints = this._canonicalConstraints || new Map();
            const numKey = String(r.number).trim();
            this._canonicalConstraints.set(numKey, { ...c });
            d.canonicalConstraints = d.canonicalConstraints || {};
            d.canonicalConstraints[numKey] = { ...c };
          }
        }
      }

      for (const r of Object.values(d.routes)) {
        const g = wholeRouteGeom.get(r.id) || this.computeRoute(r);
        g.constraint = this._buildRouteConstraint(r, g);
        this.geom[r.id] = g;

        // 1. Explicit anchors
        for (const a of r.anchors) {
          if (a.t === 'stop') {
            const arr = (this.stopRoutes[a.id] = this.stopRoutes[a.id] || []);
            if (!arr.includes(r.id)) arr.push(r.id);
          }
        }

        // 2. Traversed road segments: only stops that this route ACTUALLY passes through
        if (g && g.legs) {
          for (const leg of g.legs) {
            if (!leg.ok || !leg.segs) continue;
            for (const seg of leg.segs) {
              const onLane = laneStops.get(seg.edge * 2 + (seg.dir > 0 ? 0 : 1));
              if (!onLane) continue;
              const sMin = Math.min(seg.s0, seg.s1) - 4;
              const sMax = Math.max(seg.s0, seg.s1) + 4;
              for (const st of onLane) {
                if (st.s >= sMin && st.s <= sMax) {
                  const arr = (this.stopRoutes[st.id] = this.stopRoutes[st.id] || []);
                  if (!arr.includes(r.id)) arr.push(r.id);
                }
              }
            }
          }
        }
      }

      // One route per bus number at each stop: pieces of the same bus count as a single line
      for (const [sid, rids] of Object.entries(this.stopRoutes)) {
        const seen = new Set();
        this.stopLines[sid] = rids.filter((rid) => {
          const num = String(d.routes[rid].number).trim();
          if (seen.has(num)) return false;
          seen.add(num);
          return true;
        });
      }
      // Thousands of buses' legs stay cached between changes; only a runaway cache is dropped
      if (this.legCache.size > 120000) this.legCache.clear();
    }

    // Drops a route's detour and puts its original path and name back
    _clearDetour(r) {
      const d = this.doc;
      delete r.detourApplied;
      delete r.detourTitle;
      delete r.activeOptionIdx;
      delete r.viaName;
      if (r.originalAnchors) {
        r.anchors = JSON.parse(JSON.stringify(r.originalAnchors));
        delete r.originalAnchors;
        const firstStop = d.stops[r.anchors[0]?.id];
        const lastStop = d.stops[r.anchors[r.anchors.length - 1]?.id];
        r.name = `Bus ${r.number} (${firstStop ? firstStop.name : ''} ➔ ${lastStop ? lastStop.name : ''})`;
      }
    }

    resolveAnchor(a) {
      if (a.t === 'stop') { const s = this.doc.stops[a.id]; return s ? { edge: s.edge, s: s.s, dir: s.dir, stopId: s.id } : null; }
      return { edge: a.edge, s: a.s, dir: a.dir || 1, auto: !a.fixed };
    }

    // blocked: optional { set, key } of roads to avoid instead of just the closures (detour suggestions)
    leg(A, Bp, avoid, blocked = null) {
      const key = A.edge + ':' + A.s.toFixed(1) + ':' + A.dir + '|' + Bp.edge + ':' + Bp.s.toFixed(1) + ':' + Bp.dir + '|' + (avoid ? (blocked ? blocked.key : this.closedKey) : '-');
      let r = this.legCache.get(key);
      if (!r) {
        const opts = { closed: avoid ? (blocked ? blocked.set : this.closedSet) : null };
        r = this.net.route(A, Bp, opts);
        if (!r.ok) {
          const altB = { edge: Bp.edge, s: Bp.s, dir: -Bp.dir };
          const rAlt = this.net.route(A, altB, opts);
          if (rAlt.ok) r = rAlt;
          else {
            const rU = this.net.route(A, Bp, { ...opts, allowUturn: true });
            if (rU.ok) r = rU;
            else {
              const rAltU = this.net.route(A, altB, { ...opts, allowUturn: true });
              if (rAltU.ok) r = rAltU;
            }
          }
        }
        this.legCache.set(key, r);
      }
      return r;
    }

    // Road constraints on a single road segment
    edgeConstraints(edgeId) {
      const e = this.city && this.city.edges && this.city.edges[edgeId];
      return (e && Array.isArray(e.constraints)) ? e.constraints : [];
    }

    // Exact midpoint along a polyline (optionally restricted to points belonging to `edgeId`)
    _polylineMidpoint(pts, edgeId = null) {
      if (!Array.isArray(pts) || !pts.length) return null;
      let subset = pts;
      if (edgeId != null) {
        const prefix = `${edgeId}:`;
        const matching = pts.filter((p) => p && p.lane && String(p.lane).startsWith(prefix));
        if (matching.length >= 2) subset = matching;
      }
      if (subset.length === 1) return { x: subset[0].x, y: subset[0].y, ang: 0 };
      let total = 0;
      const lens = [];
      for (let i = 1; i < subset.length; i++) {
        const d = Math.hypot(subset[i].x - subset[i - 1].x, subset[i].y - subset[i - 1].y);
        lens.push(d);
        total += d;
      }
      if (total <= 0) {
        const mid = subset[Math.floor(subset.length / 2)];
        return { x: mid.x, y: mid.y, ang: 0 };
      }
      const half = total * 0.5;
      let acc = 0;
      for (let i = 0; i < lens.length; i++) {
        const d = lens[i];
        if (acc + d >= half || i === lens.length - 1) {
          const t = d > 0 ? Math.max(0, Math.min(1, (half - acc) / d)) : 0.5;
          const p0 = subset[i];
          const p1 = subset[i + 1];
          return {
            x: p0.x + (p1.x - p0.x) * t,
            y: p0.y + (p1.y - p0.y) * t,
            ang: Math.atan2(p1.y - p0.y, p1.x - p0.x),
          };
        }
        acc += d;
      }
      const last = subset[subset.length - 1];
      return { x: last.x, y: last.y, ang: 0 };
    }

    // 1 route has 1 constraint only, anchored on 1 road segment of its original path
    _buildRouteConstraint(r, g) {
      if (!r || !g || !Array.isArray(g.legs) || !g.legs.length) return null;
      const num = String(r.number || '').trim();

      // If this route is an operating chunk:
      // Retain the bus number's canonical constraint without changing it.
      // Only assign the constraint to this chunk if this chunk actually traverses that constrained road segment!
      if (r.isChunk) {
        let baseConst = r.baseConstraint ||
          (this.doc && this.doc.canonicalConstraints && this.doc.canonicalConstraints[num]) ||
          (this._canonicalConstraints && this._canonicalConstraints.get(num));

        if (!baseConst && this.doc && this.doc.routes) {
          const siblings = Object.values(this.doc.routes).filter((x) => String(x.number).trim() === num);
          for (const s of siblings) {
            if (s.baseConstraint) {
              baseConst = s.baseConstraint;
              break;
            }
          }
          if (!baseConst) {
            // Check edges of sibling chunks for existing predefined road constraints
            for (const s of siblings) {
              for (const a of s.anchors || []) {
                if (a.t === 'stop') {
                  const st = this.doc.stops && this.doc.stops[a.id];
                  if (st && st.edge != null) {
                    const ec = this.edgeConstraints(st.edge);
                    if (ec && ec.length) {
                      const e = this.city && this.city.edges ? this.city.edges[st.edge] : null;
                      if (e) {
                        baseConst = {
                          id: ec[0].id || `c_${e.id}_clear`,
                          edgeId: e.id,
                          roadName: e.name || ('Road #' + e.id),
                          code: ec[0].code || (e.cls === 'major' ? 'hours' : 'narrow'),
                          label: ec[0].label || (e.cls === 'major' ? 'Bus lane priority window (07:00–09:30)' : 'Narrow lane clearance (3.0m)'),
                          desc: ec[0].desc || (e.cls === 'major' ? 'Peak-hour bus corridor operating rule' : 'Standard collector lane width check for bus fleet'),
                          origPt: this._polylineMidpoint(e.pts),
                        };
                        break;
                      }
                    }
                  }
                }
              }
              if (baseConst) break;
            }
          }
          if (baseConst) {
            this._canonicalConstraints = this._canonicalConstraints || new Map();
            this._canonicalConstraints.set(num, { ...baseConst });
            if (this.doc) {
              this.doc.canonicalConstraints = this.doc.canonicalConstraints || {};
              this.doc.canonicalConstraints[num] = { ...baseConst };
            }
          }
        }

        if (baseConst && baseConst.edgeId != null) {
          // Check if this chunk's geometry traverses the constrained road segment
          let activeLegIdx = -1;
          for (let li = 0; li < g.legs.length; li++) {
            const l = g.legs[li];
            if (l && l.ok && Array.isArray(l.segs) && l.segs.some((sg) => sg.edge === baseConst.edgeId)) {
              activeLegIdx = li;
              break;
            }
          }

          let origTraversed = false;
          if (r.originalAnchors) {
            const gOrig = this.computeRoute({ anchors: r.originalAnchors, kind: 'existing', number: r.number });
            if (gOrig && gOrig.legs && gOrig.legs.some((l) => l.ok && l.segs && l.segs.some((sg) => sg.edge === baseConst.edgeId))) {
              origTraversed = true;
            }
          }

          if (activeLegIdx < 0 && !origTraversed) {
            // This chunk does not traverse the constrained road segment -> NO constraint
            return null;
          }

          const activeLeg = activeLegIdx >= 0 ? g.legs[activeLegIdx] : null;
          const pt = (activeLeg && this._polylineMidpoint(activeLeg.pts, baseConst.edgeId)) || baseConst.origPt || baseConst.pt;
          let fromStopName = baseConst.fromStopName;
          let toStopName = baseConst.toStopName;
          if (activeLegIdx >= 0 && Array.isArray(r.anchors)) {
            const a1 = r.anchors[activeLegIdx];
            const a2 = r.anchors[activeLegIdx + 1];
            const st1 = a1 && a1.t === 'stop' && this.doc && this.doc.stops ? this.doc.stops[a1.id] : null;
            const st2 = a2 && a2.t === 'stop' && this.doc && this.doc.stops ? this.doc.stops[a2.id] : null;
            if (st1) fromStopName = st1.name;
            if (st2) toStopName = st2.name;
          }
          return {
            ...baseConst,
            routeId: r.id,
            routeNumber: r.number,
            legIndex: activeLegIdx,
            bypassed: activeLegIdx < 0,
            fromStopName,
            toStopName,
            pt,
          };
        }
      }

      const baseAnchors = (r.originalAnchors && r.originalAnchors.length >= 2) ? r.originalAnchors : (r.anchors || []);
      if (baseAnchors.length < 2) return null;

      this._baseConstCache = this._baseConstCache || new Map();
      const cacheKey = `${r.id}|${JSON.stringify(baseAnchors)}`;
      let baseInfo = this._baseConstCache.get(cacheKey);

      if (!baseInfo) {
        const baseGeom = (baseAnchors === r.anchors) ? g : this.computeRoute({ anchors: baseAnchors, kind: 'existing', number: r.number });
        const baseLegs = (baseGeom && baseGeom.legs) || [];
        if (!baseLegs.length) return null;

        // Pick the middle valid leg of the route
        const validIdxs = baseLegs
          .map((l, idx) => (l && l.ok && Array.isArray(l.segs) && l.segs.length ? idx : -1))
          .filter((idx) => idx >= 0);
        if (!validIdxs.length) return null;

        const origLegIdx = validIdxs[Math.floor(validIdxs.length / 2)];
        const origLeg = baseLegs[origLegIdx];
        const segs = origLeg.segs || [];
        const midSegPos = Math.floor(segs.length / 2);

        // Prefer a segment near the middle of that leg that has a road constraint, else the middle segment itself
        let chosenSeg = segs[midSegPos];
        let bestDist = Infinity;
        for (let si = 0; si < segs.length; si++) {
          const ec = this.edgeConstraints(segs[si].edge);
          if (ec.length && Math.abs(si - midSegPos) < bestDist) {
            bestDist = Math.abs(si - midSegPos);
            chosenSeg = segs[si];
          }
        }
        const eid = chosenSeg ? chosenSeg.edge : null;
        const e = eid != null && this.city && this.city.edges ? this.city.edges[eid] : null;
        if (!e) return null;

        const existingC = this.edgeConstraints(e.id)[0];
        const cObj = existingC ? { ...existingC } : {
          id: `c_${e.id}_clear`,
          edgeId: e.id,
          roadName: e.name || ('Road #' + e.id),
          code: e.cls === 'major' ? 'hours' : 'narrow',
          label: e.cls === 'major' ? 'Bus lane priority window (07:00–09:30)' : 'Narrow lane clearance (3.0m)',
          desc: e.cls === 'major' ? 'Peak-hour bus corridor operating rule' : 'Standard collector lane width check for bus fleet',
        };

        const a1 = baseAnchors[origLegIdx];
        const a2 = baseAnchors[origLegIdx + 1];
        const st1 = a1 && a1.t === 'stop' && this.doc && this.doc.stops ? this.doc.stops[a1.id] : null;
        const st2 = a2 && a2.t === 'stop' && this.doc && this.doc.stops ? this.doc.stops[a2.id] : null;

        baseInfo = {
          ...cObj,
          origLegIdx,
          fromStopName: st1 ? st1.name : `Stop ${origLegIdx + 1}`,
          toStopName: st2 ? st2.name : `Stop ${origLegIdx + 2}`,
          origPt: this._polylineMidpoint(origLeg.pts, e.id) || this._polylineMidpoint(e.pts),
        };
        this._baseConstCache.set(cacheKey, baseInfo);
      }

      // Check which leg of the route's current geometry traverses this constrained road segment
      let activeLegIdx = -1;
      for (let li = 0; li < g.legs.length; li++) {
        const l = g.legs[li];
        if (l && l.ok && Array.isArray(l.segs) && l.segs.some((sg) => sg.edge === baseInfo.edgeId)) {
          activeLegIdx = li;
          break;
        }
      }

      const activeLeg = activeLegIdx >= 0 ? g.legs[activeLegIdx] : null;
      const pt = activeLeg
        ? (this._polylineMidpoint(activeLeg.pts, baseInfo.edgeId) || baseInfo.origPt)
        : baseInfo.origPt;

      let fromStopName = baseInfo.fromStopName;
      let toStopName = baseInfo.toStopName;
      if (activeLegIdx >= 0 && Array.isArray(r.anchors)) {
        const a1 = r.anchors[activeLegIdx];
        const a2 = r.anchors[activeLegIdx + 1];
        const st1 = a1 && a1.t === 'stop' && this.doc && this.doc.stops ? this.doc.stops[a1.id] : null;
        const st2 = a2 && a2.t === 'stop' && this.doc && this.doc.stops ? this.doc.stops[a2.id] : null;
        if (st1) fromStopName = st1.name;
        if (st2) toStopName = st2.name;
      }

      if (!r.isChunk && baseInfo) {
        this._canonicalConstraints = this._canonicalConstraints || new Map();
        this._canonicalConstraints.set(num, { ...baseInfo });
        if (this.doc) {
          this.doc.canonicalConstraints = this.doc.canonicalConstraints || {};
          this.doc.canonicalConstraints[num] = { ...baseInfo };
        }
      }

      return {
        ...baseInfo,
        routeId: r.id,
        routeNumber: r.number,
        legIndex: activeLegIdx,
        bypassed: activeLegIdx < 0,
        fromStopName,
        toStopName,
        pt,
      };
    }

    // Returns the single constraint for a given route (or bus number)
    routeConstraint(routeOrId) {
      if (!routeOrId || !this.doc || !this.doc.routes) return null;
      let r = null;
      if (typeof routeOrId === 'object') {
        r = this.doc.routes[routeOrId.id] || routeOrId;
      } else if (this.doc.routes[routeOrId]) {
        r = this.doc.routes[routeOrId];
      } else {
        const num = String(routeOrId).trim();
        r = Object.values(this.doc.routes).find((x) => String(x.number).trim() === num) || null;
      }
      if (!r) return null;
      const g = this.geom && this.geom[r.id];
      return (g && g.constraint) || null;
    }

    // Returns [constraint] ONLY if `leg` (or `fallbackEdgeId`) is the route's single constrained segment; [] otherwise
    legConstraints(leg, fallbackEdgeId = null, routeOrId = null) {
      if (routeOrId) {
        const c = this.routeConstraint(routeOrId);
        if (!c) return [];
        const r = typeof routeOrId === 'object' ? routeOrId : this.doc.routes[routeOrId];
        const g = r && this.geom ? this.geom[r.id] : null;
        if (leg && g && Array.isArray(g.legs)) {
          const idx = g.legs.indexOf(leg);
          if (idx >= 0) return idx === c.legIndex ? [c] : [];
        }
        if (leg && Array.isArray(leg.segs)) {
          return (!c.bypassed && leg.segs.some((sg) => sg.edge === c.edgeId)) ? [c] : [];
        }
        if (fallbackEdgeId != null) {
          return c.edgeId === fallbackEdgeId ? [c] : [];
        }
        return [];
      }

      // Without an explicit route, check if any route's single constraint is on this leg or edge
      for (const r of Object.values((this.doc && this.doc.routes) || {})) {
        const g = this.geom && this.geom[r.id];
        const c = g && g.constraint;
        if (!c) continue;
        if (leg && g.legs && g.legs[c.legIndex] === leg) return [c];
        if (!leg && fallbackEdgeId != null && c.edgeId === fallbackEdgeId) return [c];
      }
      return [];
    }

    getConstraintDecision(routeOrNum, constraintId) {
      if (!routeOrNum || !constraintId) return null;
      const num = typeof routeOrNum === 'object' ? String(routeOrNum.number || '').trim() : String(routeOrNum).trim();
      const map = (this.doc && this.doc.constraintDecisions) || {};
      if (num && map[`${num}:${constraintId}`]) return map[`${num}:${constraintId}`];
      if (typeof routeOrNum === 'object' && routeOrNum.constraintDecisions && routeOrNum.constraintDecisions[constraintId]) {
        return routeOrNum.constraintDecisions[constraintId];
      }
      return null;
    }

    // Road segment IDs where this route (or bus number) has marked a constraint as "rejected" (Not Accepted)
    rejectedConstraintEdges(routeOrNum) {
      const set = new Set();
      if (!routeOrNum) return set;
      const num = typeof routeOrNum === 'object' ? String(routeOrNum.number || '').trim() : String(routeOrNum).trim();
      const map = (this.doc && this.doc.constraintDecisions) || {};
      const prefix = num ? `${num}:c_` : null;
      if (prefix) {
        for (const [k, val] of Object.entries(map)) {
          if (val === 'rejected' && k.startsWith(prefix)) {
            const parts = k.slice(prefix.length).split('_');
            const eid = Number(parts[0]);
            if (Number.isFinite(eid)) set.add(eid);
          }
        }
      }
      if (typeof routeOrNum === 'object' && routeOrNum.constraintDecisions) {
        for (const [cid, val] of Object.entries(routeOrNum.constraintDecisions)) {
          if (val === 'rejected' && cid.startsWith('c_')) {
            const parts = cid.slice(2).split('_');
            const eid = Number(parts[0]);
            if (Number.isFinite(eid)) set.add(eid);
          }
        }
      }
      return set;
    }

    computeRoute(r, blocked = null) {
      const avoid = r.kind === 'proposed' && !r.override;
      const rejSet = this.rejectedConstraintEdges(r);
      const res = []; const anchorIdx = [];
      r.anchors.forEach((a, i) => { const x = this.resolveAnchor(a); if (x) { res.push(x); anchorIdx.push(i); } });
      for (let i = 0; i < res.length; i++) {
        const x = res[i]; if (!x.auto) continue;
        let best = 1, bc = Infinity;
        for (const dir of [1, -1]) {
          const c = { ...x, dir }; let cost = 0;
          if (i > 0) { const l = this.leg(res[i - 1], c, avoid, blocked); cost += l.ok ? l.length : 1e7; }
          if (i < res.length - 1) { const l = this.leg(c, res[i + 1], avoid, blocked); cost += l.ok ? l.length : 1e7; }
          if (cost < bc) { bc = cost; best = dir; }
        }
        x.dir = best;
      }
      const legs = []; let length = 0; const conflicts = new Set(); const rejectedConflicts = new Set(); const invalidLegs = [];
      for (let i = 0; i < res.length - 1; i++) {
        const l = this.leg(res[i], res[i + 1], avoid, blocked);
        legs.push(l);
        if (!l.ok) { invalidLegs.push(i); continue; }
        length += l.length;
        for (const sg of l.segs) {
          if (this.closedSet.has(sg.edge)) conflicts.add(sg.edge);
          if (rejSet.has(sg.edge)) rejectedConflicts.add(sg.edge);
        }
      }
      const stops = res.filter((x) => x.stopId);
      const stopsOnClosed = stops.filter((x) => this.closedSet.has(x.edge)).map((x) => x.stopId);
      return {
        res, anchorIdx, legs, length, conflicts: [...conflicts], rejectedConflicts: [...rejectedConflicts], invalidLegs, stopsOnClosed,
        stopCount: stops.length, time: length / SPEED_MS + stops.length * DWELL_S, ok: invalidLegs.length === 0,
      };
    }

    disruptedRoutes() {
      return Object.values(this.doc.routes).filter((r) => {
        const g = this.geom[r.id];
        if (!g) return false;
        if (g.conflicts.length || (g.rejectedConflicts && g.rejectedConflicts.length) || g.stopsOnClosed.length) return true;
        if (this.affected && this.affected.size > 0 && g.legs) {
          if (g.legs.some((l) => l.ok && l.segs && l.segs.some((s) => this.affected.has(s.edge)))) return true;
        }
        return false;
      });
    }

    routesUsingEdge(edgeId) {
      const out = [];
      for (const r of Object.values(this.doc.routes)) {
        const g = this.geom[r.id];
        if (g && g.legs && g.legs.some((l) => l.ok && l.segs && l.segs.some((s) => s.edge === edgeId))) {
          out.push(r);
        }
      }
      return out;
    }

    // Nearest bus terminal / interchange to a given stop or point
    nearestInterchange(ref, mustBeClear = true) {
      if (!this.doc || !this.doc.stops) return null;
      let refPt = { x: 0, y: 0 };
      if (ref && typeof ref.x === 'number' && typeof ref.y === 'number') {
        refPt = ref;
      } else if (ref && ref.id && this.doc.stops[ref.id]) {
        refPt = this.net.posPoint(this.doc.stops[ref.id], 0.78);
      } else if (ref && ref.edge != null) {
        refPt = this.net.posPoint(ref, 0.78);
      }
      const areas = Object.values(this.doc.areas || {});
      const isClear = (st) => {
        if (!st || st.active === false) return false;
        if (!mustBeClear) return true;
        if (this.closedSet && this.closedSet.has(st.edge)) return false;
        if (this.affected && this.affected.has(st.edge)) return false;
        const pt = this.net.posPoint(st, 0.78);
        for (const a of areas) {
          const poly = this.areaPoly(a);
          if (poly && B.pointInPoly(pt, poly)) return false;
        }
        return true;
      };
      const candidates = Object.values(this.doc.stops).filter((st) => B.isInterchange(st) && isClear(st));
      if (!candidates.length) {
        const anyInt = Object.values(this.doc.stops).filter((st) => B.isInterchange(st) && st.active !== false);
        if (!anyInt.length) return null;
        return anyInt.sort((a, b) => {
          const pa = this.net.posPoint(a, 0.78);
          const pb = this.net.posPoint(b, 0.78);
          return Math.hypot(pa.x - refPt.x, pa.y - refPt.y) - Math.hypot(pb.x - refPt.x, pb.y - refPt.y);
        })[0];
      }
      candidates.sort((a, b) => {
        const pa = this.net.posPoint(a, 0.78);
        const pb = this.net.posPoint(b, 0.78);
        const da = Math.hypot(pa.x - refPt.x, pa.y - refPt.y);
        const db = Math.hypot(pb.x - refPt.x, pb.y - refPt.y);
        return da - db;
      });
      return candidates[0];
    }

    // Pins a route with waypoints so that it keeps off closed roads and affected areas
    pinRoute(anchors, avoid = null) {
      if (!Array.isArray(anchors) || anchors.length < 2) return anchors;
      const blockedSet = new Set(this.closedSet);
      if (this.affected) for (const e of this.affected.keys()) blockedSet.add(e);
      for (const a of Object.values(this.doc.areas || {})) {
        const poly = this.areaPoly(a);
        if (!poly) continue;
        for (const e of this.city.edges) {
          if (!e || blockedSet.has(e.id)) continue;
          if (e.pts && e.pts.some((pt) => B.pointInPoly(pt, poly))) {
            blockedSet.add(e.id);
          }
        }
      }
      const blk = avoid || { set: blockedSet, key: 'blk:' + [...blockedSet].sort((a, b) => a - b).join(',') };
      const touches = (g, set) => g.legs.some((l) => l.ok && (l.segs || []).some((sg) => set.has(sg.edge)));
      const isGeomInArea = (g) => {
        if (!g || !g.ok) return true;
        if (g.conflicts && g.conflicts.some((e) => blk.set.has(e))) return true;
        const areas = Object.values(this.doc.areas || {});
        for (const l of g.legs || []) {
          if (!l.ok) return true;
          if (l.segs && l.segs.some((sg) => blk.set.has(sg.edge))) return true;
          if (l.pts && areas.length > 0) {
            for (const a of areas) {
              const poly = this.areaPoly(a);
              if (!poly) continue;
              for (let i = 0; i < l.pts.length; i += 2) {
                if (B.pointInPoly(l.pts[i], poly)) return true;
              }
            }
          }
        }
        return false;
      };

      let pins = anchors.map((a) => ({ ...a }));
      for (let tries = 0; tries < 8; tries++) {
        const g = this.computeRoute({ anchors: pins, kind: 'existing' });
        if (!g.ok) return pins;
        if (!touches(g, blk.set) && !isGeomInArea(g)) return pins;
        const clear = this.computeRoute({ anchors: pins, kind: 'proposed' }, blk);
        if (!clear.ok) return pins;
        const next = [];
        pins.forEach((a, k) => {
          next.push(a);
          const i = g.anchorIdx.indexOf(k);
          const strays = i >= 0 && i < g.legs.length && (
            (g.legs[i].segs || []).some((sg) => blk.set.has(sg.edge)) ||
            (g.legs[i].pts && Object.values(this.doc.areas || {}).some(ar => { const poly = this.areaPoly(ar); return poly && g.legs[i].pts.some(pt => B.pointInPoly(pt, poly)); }))
          );
          const segs = strays && clear.legs[i] ? clear.legs[i].segs || [] : [];
          const picks = [...new Set([0.25, 0.5, 0.75].map((f) => Math.floor(segs.length * f)))];
          for (const j of picks) {
            const sg = segs[j];
            if (sg) next.push({ t: 'waypoint', edge: sg.edge, s: (sg.s0 + sg.s1) / 2, dir: sg.dir, fixed: true });
          }
        });
        if (next.length === pins.length) return pins;
        pins = next;
      }
      return pins;
    }

    // Detour options for a disrupted bus. Each one keeps the original route, its first and last stop and its
    // other stops, and changes only the stretch that runs on a closed road or through an affected area.
    // Shortest first, then a few small variations: other bypasses, one by an MRT station, and ones that pass
    // one extra stop near the blocked roads.
    generateDetourOptions(rid) {
      const r = this.doc.routes[rid];
      if (!r) return [];
      const baseRoute = (r.kind === 'proposed' && r.baseId && this.doc.routes[r.baseId]) ? this.doc.routes[r.baseId] : r;

      // Roads a detour must keep off: closures plus every road inside an affected area, rejected road constraints,
      // and the same from other projects applied at the same time (extraBlocked, set by the controller)
      const blockedSet = new Set(this.closedSet);
      if (this.affected) for (const e of this.affected.keys()) blockedSet.add(e);
      for (const e of this.rejectedConstraintEdges(baseRoute)) blockedSet.add(e);
      if (this.extraBlocked) for (const e of this.extraBlocked) blockedSet.add(e);
      // Roads in changes the AI has only suggested so far: detours keep off them too
      if (this.suggestBlocked) for (const e of this.suggestBlocked) blockedSet.add(e);

      // CRITICAL: Ensure every road segment intersecting or inside ANY affected area polygon is in blockedSet
      for (const a of Object.values(this.doc.areas || {})) {
        const poly = this.areaPoly(a);
        if (!poly) continue;
        for (const e of this.city.edges) {
          if (!e || blockedSet.has(e.id)) continue;
          if (e.pts && e.pts.some((pt) => B.pointInPoly(pt, poly))) {
            blockedSet.add(e.id);
          }
        }
      }

      if (!blockedSet.size) return [];
      const blocked = { set: blockedSet, key: 'blk:' + [...blockedSet].sort((a, b) => a - b).join(',') };
      const touches = (g, set) => g.legs.some((l) => l.ok && (l.segs || []).some((sg) => set.has(sg.edge)));
      const touchesBlocked = (g) => touches(g, blockedSet);
      const anchorEdge = (a) => (a.t === 'stop' ? (this.doc.stops[a.id] || {}).edge : a.edge);

      const stopPt = (st) => this.net.posPoint(st, 0.78);
      const isStopInArea = (st) => {
        if (!st) return true;
        if (blockedSet.has(st.edge)) return true;
        const pt = stopPt(st);
        for (const a of Object.values(this.doc.areas || {})) {
          const poly = this.areaPoly(a);
          if (poly && B.pointInPoly(pt, poly)) return true;
        }
        return false;
      };

      const legInArea = (l) => {
        if (!l || !l.ok) return true;
        if (l.segs && l.segs.some((sg) => blockedSet.has(sg.edge))) return true;
        const areas = Object.values(this.doc.areas || {});
        if (l.pts && areas.length > 0) {
          for (const a of areas) {
            const poly = this.areaPoly(a);
            if (!poly) continue;
            for (let i = 0; i < l.pts.length; i += 2) {
              if (B.pointInPoly(l.pts[i], poly)) return true;
            }
          }
        }
        return false;
      };

      const isGeomInArea = (g) => {
        if (!g || !g.ok) return true;
        if (g.conflicts && g.conflicts.some((e) => blockedSet.has(e))) return true;
        for (const l of g.legs || []) {
          if (legInArea(l)) return true;
        }
        return false;
      };

      // Options come from the route as it was before any detour, so they stay the same once one is applied
      const srcAnchors = baseRoute.originalAnchors || baseRoute.anchors || [];
      const gOrig = this.computeRoute({ anchors: srcAnchors, kind: 'existing' });
      const origAffected = touchesBlocked(gOrig) || isGeomInArea(gOrig) || srcAnchors.some((a) => a.t === 'stop' && isStopInArea(this.doc.stops[a.id]));
      if (!origAffected) return [];

      // A stop this bus can use: on an open road, active, outside affected area, and taking its bus model
      const model = B.busModel(this.doc, baseRoute.number);
      const takes = (st) => !!st && !isStopInArea(st) && st.active !== false &&
        B.stopBusTypes(this.doc, st.id, this.stopLines[st.id] || []).includes(model);

      // Working out detours is slow, so reuse them until the map changes
      const cacheKey = `${baseRoute.id}|${this.rev}|${this.extraBlockedKey || ''}`;
      if (this._detourCache && this._detourCache.key === cacheKey) return this._detourCache.options;

      // An applied detour stays an existing route, which the map draws straight through closures. Pin it with
      // waypoints taken from its clear path, leg by leg, until it keeps off the blocked roads when drawn that way.
      const pin = (anchors, avoid = blocked) => {
        let pins = anchors.map((a) => ({ ...a }));
        for (let tries = 0; tries < 8; tries++) {
          const g = this.computeRoute({ anchors: pins, kind: 'existing' });
          if (!g.ok) return null;
          if (!touches(g, avoid.set) && !isGeomInArea(g)) return { anchors: pins, geom: g };
          const clear = this.computeRoute({ anchors: pins, kind: 'proposed' }, avoid);
          if (!clear.ok) return null;
          const next = [];
          pins.forEach((a, k) => {
            next.push(a);
            const i = g.anchorIdx.indexOf(k);
            const strays = i >= 0 && i < g.legs.length && (
              (g.legs[i].segs || []).some((sg) => avoid.set.has(sg.edge)) ||
              legInArea(g.legs[i])
            );
            const segs = strays && clear.legs[i] ? clear.legs[i].segs || [] : [];
            // A quarter, half and three quarters along the clear leg, so it holds after a try or two
            const picks = [...new Set([0.25, 0.5, 0.75].map((f) => Math.floor(segs.length * f)))];
            for (const j of picks) {
              const sg = segs[j];
              if (sg) next.push({ t: 'waypoint', edge: sg.edge, s: (sg.s0 + sg.s1) / 2, dir: sg.dir, fixed: true });
            }
          });
          if (next.length === pins.length) return null;
          pins = next;
        }
        return null;
      };

      const options = [];
      const seenPaths = new Set();
      const edgesOf = (g) => new Set(g.legs.flatMap((l) => (l.segs || []).map((sg) => sg.edge)));
      const origEdges = edgesOf(gOrig);
      // How much of the route's own roads an option leaves: the smaller, the closer it stays to the route
      const leaves = (g) => {
        const own = edgesOf(g);
        let m = 0;
        for (const e of origEdges) if (!own.has(e)) m += (this.city.edges[e] && this.city.edges[e].len) || 0;
        return m;
      };
      // Two options are the same if they drive the same roads, wherever their stops split the legs
      const pathKey = (g) => g.legs
        .flatMap((l) => (l.segs || []).map((sg) => sg.edge))
        .filter((e, i, all) => i === 0 || e !== all[i - 1])
        .join('.');
      // "+1.2 km", "−300 m": the sign in front, the size formatted as usual (tiny changes read +0)
      const signed = (v, fmt, tiny) => (Math.abs(v) < tiny ? '+' + fmt(0) : (v > 0 ? '+' : '−') + fmt(Math.abs(v)));
      // keyExtra tells apart options on the same roads that stop somewhere different (the MRT stop)
      const addOption = (id, label, viaName, anchors, maxLength = Infinity, avoid = blocked, maxLeave = Infinity, keyExtra = '') => {
        // STRICT REQUIREMENT: Option MUST start and end in a bus terminal
        const sStart = this.doc.stops[anchors[0]?.id];
        const sEnd = this.doc.stops[anchors[anchors.length - 1]?.id];
        if (!sStart || !B.isInterchange(sStart) || isStopInArea(sStart)) return null;
        if (!sEnd || !B.isInterchange(sEnd) || isStopInArea(sEnd)) return null;

        const p = pin(anchors, avoid);
        if (!p || p.geom.length > maxLength || leaves(p.geom) > maxLeave) return null;
        if (touches(p.geom, avoid.set) || isGeomInArea(p.geom)) return null;
        const key = pathKey(p.geom) + keyExtra;
        if (seenPaths.has(key)) return null;
        seenPaths.add(key);
        options.push({
          id,
          label,
          title: label,
          viaName,
          anchors: p.anchors,
          geom: p.geom,
          length: p.geom.length,
          time: p.geom.time,
          stopCount: p.geom.stopCount,
          distDeltaKm: signed(p.geom.length - gOrig.length, B.fmtKm, 5),
          timeDeltaMin: signed(p.geom.time - gOrig.time, B.fmtMin, 30),
        });
        return options[options.length - 1];
      };

      // 1. Prepare base anchors: remove any stops in affected area or closed roads
      let cleanAnchors = srcAnchors.filter((a) => {
        if (a.t === 'stop') {
          const st = this.doc.stops[a.id];
          return st && !isStopInArea(st);
        }
        return !blockedSet.has(a.edge);
      });

      // 2. Origin MUST start at a bus terminal outside affected area
      const s0 = this.doc.stops[cleanAnchors[0]?.id];
      if (!s0 || !B.isInterchange(s0) || isStopInArea(s0)) {
        const ref = s0 || this.doc.stops[srcAnchors[0]?.id] || srcAnchors[0];
        const term0 = this.nearestInterchange(ref, true);
        if (term0) {
          if (s0 && isStopInArea(s0)) {
            cleanAnchors[0] = { t: 'stop', id: term0.id };
          } else {
            cleanAnchors = [{ t: 'stop', id: term0.id }, ...cleanAnchors];
          }
        }
      }

      // 3. Destination MUST end at a bus terminal outside affected area
      const sLast = this.doc.stops[cleanAnchors[cleanAnchors.length - 1]?.id];
      if (!sLast || !B.isInterchange(sLast) || isStopInArea(sLast)) {
        const ref = sLast || this.doc.stops[srcAnchors[srcAnchors.length - 1]?.id] || srcAnchors[srcAnchors.length - 1];
        const termLast = this.nearestInterchange(ref, true);
        if (termLast) {
          if (sLast && isStopInArea(sLast)) {
            cleanAnchors[cleanAnchors.length - 1] = { t: 'stop', id: termLast.id };
          } else {
            cleanAnchors = [...cleanAnchors, { t: 'stop', id: termLast.id }];
          }
        }
      }

      // Deduplicate consecutive identical stops
      const dedupedAnchors = [];
      for (let i = 0; i < cleanAnchors.length; i++) {
        if (i === 0 || cleanAnchors[i].id !== cleanAnchors[i - 1]?.id) {
          dedupedAnchors.push(cleanAnchors[i]);
        }
      }
      let baseAnchors = dedupedAnchors;
      if (baseAnchors.length >= 2) {
        addOption('opt_direct', 'Shortest bypass', 'Same stops, around the blocked roads', baseAnchors);
      }
      if (!baseAnchors || baseAnchors.length < 2) return [];

      // Every other option may add only a little to the shortest bypass, and leave only a little more of the route
      const direct = options[0];
      const maxLength = direct ? direct.length + Math.max(700, direct.length * 0.2) : gOrig.length * 1.25 + 700;
      const maxLeave = direct ? leaves(direct.geom) + 800 : Infinity;
      const MAX_OPTIONS = 12;
      const roadName = (e) => (this.city.edges[e] && this.city.edges[e].name) || null;

      // 2. Next-best bypasses: keep off one road the shortest bypass newly uses, and go around it
      if (direct) {
        const directEdges = edgesOf(direct.geom);
        for (const e of [...directEdges].filter((id) => !origEdges.has(id))) {
          if (options.length >= MAX_OPTIONS) break;
          const set = new Set(blockedSet);
          set.add(e);
          const opt = addOption('opt_alt_' + e, 'Alternative bypass', 'Alternative bypass', baseAnchors, maxLength, { set, key: blocked.key + '+' + e }, maxLeave);
          if (!opt) continue;
          // Name it after the first road it takes that neither the route nor the shortest bypass uses
          const own = [...edgesOf(opt.geom)].find((id) => !origEdges.has(id) && !directEdges.has(id) && roadName(id));
          if (own) opt.label = opt.title = opt.viaName = 'Via ' + roadName(own);
          // Two bypasses by the same road read as one option: keep the shorter
          const twin = options.find((o) => o !== opt && o.label === opt.label);
          if (twin) options.splice(options.indexOf(twin.length <= opt.length ? opt : twin), 1);
        }
      }

      // 3 & 4. Small variations: a stop by an MRT station, then one extra stop near the blocked roads.
      // "Near" is around the part of this route that's blocked, not every blocked road on the map.
      const routeBlocked = new Set([...origEdges].filter((e) => blockedSet.has(e)));
      for (const a of srcAnchors) if (blockedSet.has(anchorEdge(a))) routeBlocked.add(anchorEdge(a));
      let cx = 0, cy = 0, n = 0;
      const blockedPts = [];
      for (const id of (routeBlocked.size ? routeBlocked : blockedSet)) {
        const e = this.city.edges[id];
        if (!e) continue;
        for (const pt of e.pts) { cx += pt.x; cy += pt.y; n++; blockedPts.push(pt); }
      }
      if (n) { cx /= n; cy /= n; }
      const reach = blockedPts.reduce((m, pt) => Math.max(m, Math.hypot(pt.x - cx, pt.y - cy)), 0) + 500;

      const anchorPt = (a) => {
        if (a.t === 'stop') {
          const st = this.doc.stops[a.id];
          return st ? this.net.posPoint(st, 0.78) : null;
        }
        const e = this.city.edges[a.edge];
        return e ? B.pointAlong(e.pts, e.cum, a.s) : null;
      };
      const basePts = baseAnchors.map(anchorPt);
      // Each extra stop goes where it adds the least distance along the route
      const bestInsertAt = (p) => {
        let best = 1;
        let bestCost = Infinity;
        for (let i = 1; i < basePts.length; i++) {
          const a = basePts[i - 1];
          const b = basePts[i];
          if (!a || !b) continue;
          const cost = Math.hypot(p.x - a.x, p.y - a.y) + Math.hypot(p.x - b.x, p.y - b.y) - Math.hypot(a.x - b.x, a.y - b.y);
          if (cost < bestCost) { bestCost = cost; best = i; }
        }
        return best;
      };

      // 3. By an MRT station near the blocked roads that the route doesn't reach yet, stopping beside it so
      // riders can still change to the train. Of the nearest few stations, the one that adds the least;
      // it may run longer than the other variations
      const nearPt = (pts, p, d) => pts.some((q) => q && Math.hypot(q.x - p.x, q.y - p.y) <= d);
      const stations = (this.city.mrtStations || [])
        .filter((m) => !nearPt(basePts, m, 350))
        .map((m) => ({ m, d: Math.hypot(m.x - cx, m.y - cy) }))
        .filter((x) => x.d <= reach + 800)
        .sort((a, b) => a.d - b.d)
        .slice(0, 4);
      const mrtMaxLength = direct ? direct.length + Math.max(2000, direct.length * 0.6) : maxLength;
      let mrtPick = null;
      for (const { m } of stations) {
        let best = null;
        for (const st of Object.values(this.doc.stops)) {
          if (!takes(st) || baseAnchors.some((a) => a.id === st.id)) continue;
          const p = stopPt(st);
          const d = Math.hypot(p.x - m.x, p.y - m.y);
          if (d <= 300 && (!best || d < best.d)) best = { st, p, d };
        }
        if (!best) continue;
        const at = bestInsertAt(best.p);
        const anchors = [...baseAnchors.slice(0, at), { t: 'stop', id: best.st.id }, ...baseAnchors.slice(at)];
        const p = pin(anchors);
        if (!p || p.geom.length > mrtMaxLength || leaves(p.geom) > maxLeave + 1000) continue;
        if (!mrtPick || p.geom.length < mrtPick.length) mrtPick = { m, anchors, length: p.geom.length, stopId: best.st.id };
      }
      if (mrtPick && options.length < MAX_OPTIONS) {
        const name = `Via ${mrtPick.m.name} MRT`;
        const opt = addOption('opt_mrt_' + mrtPick.m.id, name, name, mrtPick.anchors, Infinity, blocked, Infinity, '|mrt:' + mrtPick.stopId);
        if (opt) opt.mrt = mrtPick.m.name;
      }

      // 3b. By a Bus Interchange near the route / blocked roads that the route doesn't stop at yet,
      // routing to/stopping at the bus interchange so passengers can transfer to other bus services.
      const intCandidates = Object.values(this.doc.stops)
        .filter((st) => window.B && window.B.isInterchange(st) && takes(st) && !baseAnchors.some((a) => a.id === st.id))
        .map((st) => {
          const pt = this.net.posPoint(st, 0.78);
          let dRoute = Infinity;
          for (const bp of basePts) {
            if (bp) {
              const d = Math.hypot(pt.x - bp.x, pt.y - bp.y);
              if (d < dRoute) dRoute = d;
            }
          }
          return { st, pt, dRoute };
        })
        .filter((x) => x.dRoute <= reach + 3500 && !basePts.some((bp) => bp && Math.hypot(x.pt.x - bp.x, x.pt.y - bp.y) < 280))
        .sort((a, b) => a.dRoute - b.dRoute)
        .slice(0, 3);

      for (const { st, pt } of intCandidates) {
        if (options.length >= MAX_OPTIONS) break;
        const at = bestInsertAt(pt);
        const prevPt = basePts[at - 1], nextPt = basePts[at];
        if (prevPt && Math.hypot(pt.x - prevPt.x, pt.y - prevPt.y) < 280) continue;
        if (nextPt && Math.hypot(pt.x - nextPt.x, pt.y - nextPt.y) < 280) continue;
        const anchors = [...baseAnchors.slice(0, at), { t: 'stop', id: st.id }, ...baseAnchors.slice(at)];
        const cleanName = (st.name || '').replace(/\s+Int$/i, '') + ' Interchange';
        const name = `Via ${cleanName}`;
        const opt = addOption('opt_int_' + st.id, name, name, anchors, Infinity, blocked, Infinity, '|int:' + st.id);
        if (opt) {
          opt.interchange = cleanName;
          opt.isInterchangeOption = true;
        }
      }

      // 4. One extra stop near the blocked roads (at least 280m away from existing stops)
      const candidates = Object.values(this.doc.stops)
        .filter((st) => takes(st) && !baseAnchors.some((a) => a.id === st.id))
        .map((st) => ({ st, pt: this.net.posPoint(st, 0.78) }))
        .filter(({ pt }) => Math.hypot(pt.x - cx, pt.y - cy) <= reach && !basePts.some((bp) => bp && Math.hypot(pt.x - bp.x, pt.y - bp.y) < 280))
        .sort((a, b) => Math.hypot(a.pt.x - cx, a.pt.y - cy) - Math.hypot(b.pt.x - cx, b.pt.y - cy));

      let tested = 0;
      for (const { st, pt } of candidates) {
        if (options.length >= MAX_OPTIONS || tested >= 60) break;
        tested++;
        const at = bestInsertAt(pt);
        const prevPt = basePts[at - 1], nextPt = basePts[at];
        if (prevPt && Math.hypot(pt.x - prevPt.x, pt.y - prevPt.y) < 280) continue;
        if (nextPt && Math.hypot(pt.x - nextPt.x, pt.y - nextPt.y) < 280) continue;
        const anchors = [...baseAnchors.slice(0, at), { t: 'stop', id: st.id }, ...baseAnchors.slice(at)];
        addOption('opt_' + st.id, 'Via ' + st.name, 'Via ' + st.name, anchors, maxLength, blocked, maxLeave);
      }

      // Shortest bypass first, then the rest from the least to the most extra distance
      const [first, ...rest] = options;
      const ordered = first && first.id === 'opt_direct'
        ? [first, ...rest.sort((a, b) => a.length - b.length)]
        : options.sort((a, b) => a.length - b.length);
      ordered.forEach((o, i) => {
        o.index = i;
        o.isRecommended = i === 0;
      });

      this._detourCache = { key: cacheKey, options: ordered };
      return ordered;
    }
  };

  // ------------------------------------------------------------------ domain operations
  // Pure functions on a doc (used inside store.commit / begin..end transactions).
  B.ops = {
    // Removing a stop drops it from every route that uses it; a route left without a line (fewer
    // than two stops) is removed too, so no empty bus pieces stay behind
    deleteStop(doc, sid) {
      const affected = [];
      for (const r of Object.values(doc.routes)) {
        if (!r.anchors.some((a) => a.t === 'stop' && a.id === sid)) continue;
        r.anchors = r.anchors
          .filter((a) => !(a.t === 'stop' && a.id === sid))
          // A → B → A with B gone would visit A twice in a row, which is not a line
          .filter((a, i, arr) => !(i > 0 && a.t === 'stop' && arr[i - 1].t === 'stop' && arr[i - 1].id === a.id));
        affected.push(r.number);
      }
      delete doc.stops[sid];
      return { affected, removed: B.ops.pruneEmptyRoutes(doc) };
    },
    // Routes with fewer than two anchors can't be drawn or selected; returns the bus numbers removed.
    // A planned bus (made from New Bus Number, no stops linked yet) stays until its route is drawn.
    pruneEmptyRoutes(doc) {
      const removed = [];
      for (const r of Object.values(doc.routes || {})) {
        if (r.planned && !(r.anchors || []).length) continue;
        if (!r.anchors || r.anchors.length < 2) {
          delete doc.routes[r.id];
          removed.push(r.number);
        }
      }
      return removed;
    },
    setClosed(doc, ids, closed, meta) {
      for (const id of ids) { if (closed) doc.closures[id] = meta || { reason: 'Road closure' }; else delete doc.closures[id]; }
    },
    // Deletes an affected area and the road closures it made (tagged with its id, or older ones
    // recorded as "Closed by <area name>"); returns how many closures went with it
    deleteArea(doc, areaId) {
      const area = doc.areas[areaId];
      if (!area) return 0;
      const madeBy = `Closed by ${area.name}`;
      let removed = 0;
      for (const [edge, c] of Object.entries(doc.closures || {})) {
        if (c && (c.areaId === areaId || c.reason === madeBy)) { delete doc.closures[edge]; removed++; }
      }
      delete doc.areas[areaId];
      return removed;
    },
  };
})();
