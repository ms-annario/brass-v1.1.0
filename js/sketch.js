/* BRASS — sketch an area on the map and save it as a file attached to the project.
 * The file lists the polygon, the roads and the bus stops inside it, so the AI can read it with the other documents.
 */
(function () {
  const B = window.B;

  B.initSketch = function (app) {
    const { store, renderer, net, controller: c } = app;
    const btn = document.getElementById('btn-header-sketch');
    const bar = document.getElementById('sk-bar');
    if (!btn || !bar) return;
    let pts = null, hover = null, press = null;
    const toast = (m, k) => c._showToast && c._showToast(m, k || 'info');
    const count = () => bar.querySelector('.sk-count');

    const world = (e) => { const r = renderer.canvas.getBoundingClientRect(); return renderer.screenToWorld(e.clientX - r.left, e.clientY - r.top); };
    const onCanvas = (e) => e.target === renderer.canvas;
    const swallow = (e) => { if (pts && onCanvas(e)) { e.stopImmediatePropagation(); e.preventDefault(); return true; } return false; };

    const start = () => {
      pts = []; hover = null;
      bar.hidden = false; btn.classList.add('active'); update();
    };
    const stop = () => { pts = null; hover = null; bar.hidden = true; btn.classList.remove('active'); renderer.requestRender(); };
    const update = () => { count().textContent = pts.length ? `${pts.length} point${pts.length === 1 ? '' : 's'}` : 'No points yet'; bar.querySelector('[data-act=finish]').disabled = pts.length < 3; renderer.requestRender(); };

    // What lies inside a drawn polygon: its roads and bus stops (also used for uploaded polygon files)
    B.describeArea = (poly) => {
      const roads = [...new Set(net.edgesInPolygon(poly).map((id) => net.edge(id).name))].sort();
      const stops = Object.values(store.doc.stops).filter((st) => B.pointInPoly(net.posPoint({ edge: st.edge, s: st.s, dir: st.dir || 1 }, 0), poly)).map((st) => ({ code: st.code, name: st.name }));
      return { roads, stops };
    };

    const finish = async () => {
      if (!pts || pts.length < 3) return;
      const poly = pts.slice();
      const { roads, stops } = B.describeArea(poly);
      const project = c.projects.find((p) => p.id === c.activeProjectId);
      const n = (await B.docs.all()).filter((d) => d.projectId === c.activeProjectId && /^area-drawing/.test(d.name)).length + 1;
      const name = `Area drawing ${n}`;
      const file = new File([JSON.stringify({
        kind: 'brass-area-drawing', name, project: project ? project.name : '', created: new Date().toISOString(),
        polygon: poly.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })), roads, stops,
      }, null, 2)], `area-drawing-${n}.json`, { type: 'application/json' });
      await B.docs.add(c.activeProjectId, file);
      stop();
      toast(`${file.name} attached`, 'success');
      // two or more files now: offer the AI again
      if (B.offerSuggestions) B.offerSuggestions(c.activeProjectId, true);
    };

    window.addEventListener('mousedown', (e) => { if (swallow(e)) press = { x: e.clientX, y: e.clientY, moved: false }; }, true);
    window.addEventListener('mousemove', (e) => {
      if (!pts || !onCanvas(e)) return;
      hover = world(e);
      if (press && (e.buttons & 1)) {
        const dx = e.clientX - press.x, dy = e.clientY - press.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) press.moved = true;
        if (press.moved) { renderer.cameraAnim = null; renderer.camera.x -= dx / renderer.camera.zoom; renderer.camera.y -= dy / renderer.camera.zoom; press.x = e.clientX; press.y = e.clientY; }
      }
      renderer.requestRender();
    }, true);
    window.addEventListener('mouseup', (e) => {
      if (!swallow(e)) return;
      const was = press; press = null;
      if (!was || was.moved) return;
      pts.push(world(e)); update();
    }, true);
    window.addEventListener('click', swallow, true);
    window.addEventListener('dblclick', (e) => {
      if (!swallow(e)) return;
      if (pts.length > 3) pts.pop(); // the double-click's second click added a duplicate point
      finish();
    }, true);
    window.addEventListener('keydown', (e) => {
      if (!pts) return;
      if (e.key === 'Escape') stop();
      else if (e.key === 'Enter') finish();
      else if ((e.key === 'Backspace' || e.key === 'Delete') && pts.length) { e.preventDefault(); pts.pop(); update(); }
    }, true);

    btn.addEventListener('click', () => (pts ? stop() : start()));
    bar.querySelector('[data-act=finish]').addEventListener('click', finish);
    bar.querySelector('[data-act=cancel]').addEventListener('click', stop);
    document.getElementById('btn-header-projects').addEventListener('click', () => { if (pts) stop(); });

    // Drawn on the map while sketching
    const prev = renderer.suggestOverlay;
    renderer.suggestOverlay = (ctx) => {
      if (prev) prev(ctx);
      if (!pts || !pts.length) return;
      const z = renderer.camera.zoom, line = hover ? [...pts, hover] : pts;
      ctx.save();
      ctx.beginPath(); ctx.moveTo(line[0].x, line[0].y); line.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
      if (pts.length >= 3) ctx.closePath();
      ctx.fillStyle = 'rgba(37,99,235,0.12)'; ctx.fill();
      ctx.lineWidth = 2.5 / z; ctx.strokeStyle = '#2563eb'; ctx.lineJoin = 'round'; ctx.stroke();
      pts.forEach((p) => { ctx.beginPath(); ctx.arc(p.x, p.y, 5 / z, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 2 / z; ctx.stroke(); });
      ctx.restore();
    };
  };
})();
