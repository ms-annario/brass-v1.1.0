/* BRASS — View Setting: the layer switches and the map opacity live in a pop-up off a bottom-left button. */
(function () {
  const B = window.B;
  B.initViewSetting = function () {
    const btn = document.getElementById('btn-view-setting');
    const pop = document.getElementById('view-setting-pop');
    const body = document.getElementById('view-setting-body');
    const layers = document.getElementById('body-layers');
    if (!btn || !pop || !body || !layers) return;
    // The same controls the map already listens to, so they keep working from here
    body.appendChild(layers);
    layers.classList.remove('legend-section-body');
    const open = (v) => { pop.hidden = !v; btn.classList.toggle('on', v); btn.setAttribute('aria-expanded', String(v)); };
    btn.addEventListener('click', (e) => { e.stopPropagation(); open(pop.hidden); });
    document.getElementById('view-setting-close').addEventListener('click', () => open(false));
    pop.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => open(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') open(false); });
  };
})();
