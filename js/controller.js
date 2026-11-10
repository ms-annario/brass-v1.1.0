/* BRASS — Interactive Controller and Tool Engine
 * Handles tool switching, mouse/keyboard events, road-constrained dragging,
 * bus stop line adjustment, polygon reshaping and detour calculation.
 */
(function () {
  const B = window.B;

  class Controller {
    constructor(city, net, store, renderer) {
      this.city = city;
      this.net = net;
      this.store = store;
      this.renderer = renderer;
      this.hiddenChunkIds = new Set();
      this.renderer.hiddenChunkIds = this.hiddenChunkIds;

      this.mode = 'view'; // 'view' | 'edit'
      this.reviewMode = false;
      if (/^#(?:review|share|draw)=/.test(location.hash)) document.body.classList.add('review-mode');
      if (/^#draw=/.test(location.hash)) document.body.classList.add('draw-mode');
      this.activeTool = 'select'; // 'select' | 'stop' | 'route' | 'area' | 'closure'

      // Interaction state
      this.isPanning = false;
      this.panStart = { x: 0, y: 0 };
      this.dragTarget = null; // { type, id, origPos, handle, ... }
      this.dragCandidate = null; // candidate for drag vs click
      this.pendingStopClick = null; // pending bus stop click target
      this.mouseDownPos = null; // mouse coordinates at mousedown
      this.hasDragged = false; // whether mouse moved > 6px while pressed
      this.isDragging = false;
      this.polyDrawingPts = []; // for drawing affected area
      this.routeDrawingAnchors = []; // for drafting new route
      this._activeConnectStopId = null; // starting/previous stop in drawing/connecting sequence
      this._lastActiveRouteId = null; // last active or edited route to continue automatically
      this._activeConnectRouteId = null; // route being extended in the current connecting chain
      this.selectedRouteIds = new Set(); // Multi-selected bus route IDs
      this.isAllRoutesSelected = true;
      this.routeSearchQuery = '';
      this.selectedEntities = new Map(); // Non-bus entities (Address, Road, Stop, MRT, Interchange)
      this.showingDetourOptionsRouteId = null; // route whose detour preview is kept on the map
      this.pinnedDetourIdx = -1; // which of its options is kept
      this.pendingDeleteRouteId = null; // route ID pending deletion confirmation
      this.pendingDeleteProjectId = null; // project ID pending deletion confirmation
      this.pendingRestoreVersionId = null; // Current Map version pending restore confirmation
      this.expandedProjectIds = new Set(); // Set of project IDs with expanded drawers
      this.activeStopPillId = null; // stop ID whose floating action pill is active
      this.connectBusNumber = null; // bus number chosen in the stop pill; links without prompting while set
      this.detourScorecardRouteId = null; // bus route whose detour scorecard fills the side panel
      this.pendingNewBus = null; // { number } of a bus just made from New Bus Number: the next stop click starts its route

      // View mode polygon area filter state
      this.isDrawingAreaFilter = false;
      this.areaFilterPts = [];
      this.areaFilterPolygon = null;
      this.areaFilterPassingRoutes = [];
      this.areaFilterPassingIds = null;
      this.areaFilterSelectedRouteIds = null;
      this.areaFilterOutlineHidden = false; // a map click hides the drawn area; its filter stays
      this.timeFilter = { from: '00:00', to: '23:59' }; // only buses running in this window show on the map
      this.dayFilter = B.ALL_DAYS.slice(); // ...and on one of these days (0 = Mon)
      this.filterMapToArea = true;


      if (this.renderer) {
        this.renderer.controller = this;
        this.renderer.onRender = () => {
          this._updateFloatingPositions();
        };
      }

      this._bindEvents();

      // Initialize application mode (default: view)
      const savedMode = (typeof localStorage !== 'undefined' && localStorage.getItem('brass_app_mode')) || 'view';
      this.setMode(savedMode === 'edit' ? 'edit' : 'view');
    }

    get activeConnectStopId() {
      return this._activeConnectStopId;
    }
    set activeConnectStopId(val) {
      this._activeConnectStopId = val;
      if (this.renderer) {
        this.renderer.activeConnectStopId = val;
        // A new connecting move supersedes the "just created" pulse
        if (val && this.renderer.justCreatedStopId && this.renderer.justCreatedStopId !== val) {
          this.renderer.justCreatedStopId = null;
        }
      }
    }

    get lastActiveRouteId() {
      return this._lastActiveRouteId;
    }
    set lastActiveRouteId(val) {
      this._lastActiveRouteId = val;
      if (this.renderer) {
        this.renderer.lastActiveRouteId = val;
      }
    }

    get activeConnectRouteId() {
      return this._activeConnectRouteId;
    }
    set activeConnectRouteId(val) {
      this._activeConnectRouteId = val;
      if (this.renderer) {
        this.renderer.activeConnectRouteId = val;
      }
    }

    setMode(mode) {
      // The Current Map is read-only: it only changes by applying (or restoring) a project. An archived
      // project is too: it opens like a shared link, still with search and filters
      const archived = this._isArchivedActive();
      if (this.activeProjectId === 'main' || archived) mode = 'view';
      this.mode = (mode === 'edit') ? 'edit' : 'view';
      document.body.classList.toggle('archived-view', archived);
      if (this.renderer) {
        this.renderer.mode = this.mode;
      }

      document.body.classList.toggle('mode-view', this.mode === 'view');
      document.body.classList.toggle('mode-edit', this.mode === 'edit');

      if (this.mode === 'view') {
        if (this.activeConnectStopId) {
          this._cancelConnectingStops();
        }
        this.setTool('select');
        this._hideFloatingLegActions();
        this._hideFloatingStopActions();
        this.dragTarget = null;
        this.dragCandidate = null;

        // In view mode: preserve selected route-leg metadata so line and road info is kept
        if (this.renderer && this.renderer.selected && this.renderer.selected.type === 'route-leg') {
          const rId = this.renderer.selected.routeId || this.renderer.selected.id;
          const rObj = this.renderer.selected.obj || (this.store && this.store.doc.routes[rId]);
          this.renderer.selected = { ...this.renderer.selected, type: 'route-leg', id: rId, routeId: rId, obj: rObj };
        }
        this._updateAreaFilterUI();
        this._renderRoutePills();
      } else {
        if (this.isDrawingAreaFilter) {
          this._cancelAreaFilterDrawing();
        }
        this._updateAreaFilterUI();
        this._renderRoutePills();
      }

      if (this.renderer && this.renderer.selected) {
        this._showInspector(this.renderer.selected);
      }

      if (this.projects) {
        const activeProj = this.projects.find((p) => p.id === this.activeProjectId);
        if (activeProj) {
          activeProj.mode = this.mode;
          this._saveProjects();
        }
        this._renderProjects();
      }

      try {
        if (!this.reviewMode) localStorage.setItem('brass_app_mode', this.mode);
      } catch (e) {}

      this.renderer.requestRender();
    }

    setTool(tool) {
      // A drawing link only has the area and closure tools
      if (this.drawMode) {
        if (tool !== 'area' && tool !== 'closure') tool = 'select';
      } else if (tool !== 'select' && this._isCurrentMapReadOnly()) tool = 'select';
      if (tool !== 'stop' && tool !== 'route' && this.activeConnectStopId) {
        this._finishConnectingStops();
      }
      this.activeTool = tool;
      this.polyDrawingPts = [];
      this.routeDrawingAnchors = [];
      this.renderer.drawingArea = null;
      this.renderer.drawingAreaPreview = null;
      this.renderer.drawingRoute = null;
      this.renderer.snapTarget = null;
      if (tool !== 'route') {
        this.activeConnectStopId = null;
        this.renderer.activeConnectStopId = null;
        this.renderer.connectingPreview = null;
      }

      this._syncToolbar();
      this._updateConnectingBar();
      this.renderer.requestRender();
    }

    // ------------------------------------------------------------- Commuters per stop (estimate)
    // There is no ridership data, so this is a rough daily figure: busiest in the city centre and near
    // town centres, more for every bus that calls there, with a steady per-stop variation
    _stopCommuters(stopId) {
      const s = this.store.doc.stops[stopId];
      if (!s) return 0;
      const pt = this.net.posPoint(s, 0.78);
      const district = this.store.city.districtAt(pt);
      const base = { cbd: 1400, mixed: 950, hdb: 800, industrial: 450, landed: 300 }[district && district.type] || 500;
      const toCentre = district ? Math.hypot(pt.x - district.x, pt.y - district.y) : 1000;
      const nearCentre = 0.6 + 0.8 * Math.exp(-toCentre / 450);
      const buses = Math.max(1, (this.store.stopLines[stopId] || []).length);
      const byBuses = 0.5 + 0.5 * buses;
      let h = 0;
      for (const ch of String(stopId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      const vary = 0.8 + (h % 41) / 100;
      return Math.max(20, Math.round((base * nearCentre * byBuses * vary) / 10) * 10);
    }

    // "~520", "~1.4k"
    _formatCommuters(n) {
      return n >= 1000 ? `~${(n / 1000).toFixed(1)}k` : `~${n}`;
    }

    // Detour options ranked best first by, in order of weight: travel time (40%), distance (30%),
    // stops skipped (20%) and commuters affected at those stops (10%). Every caller uses this, so
    // an option's position means the same in the panel, on the map and when applied.
    // Running cost a day of a route, keeping today's trips: trips a day (operating hours × buses ÷ the trip time
    // now) × (S$1.80 a bus-km + S$75 a bus-hour). An estimate, to compare options; length in m, time in s
    _runCost(number, nowTime) {
      const COST_KM = 1.8, COST_HOUR = 75;
      const h = B.busHours(this.store.doc, number);
      let mins = B.timeToMin(h.end) - B.timeToMin(h.start);
      if (mins <= 0) mins += 24 * 60;
      const trips = nowTime > 0 ? (mins * 60 * this._busFleet(number)) / nowTime : 0;
      return (length, time) => (length == null || time == null ? null : trips * ((length / 1000) * COST_KM + (time / 3600) * COST_HOUR));
    }

    _rankedDetourOptions(routeId) {
      let options = this.store.generateDetourOptions(routeId);
      if (!options.length) return options;

      const doc = this.store.doc;
      // Filter strictly: every option MUST start and end in a bus terminal, and avoid the affected area
      options = options.filter((o) => {
        if (!o || !o.anchors || o.anchors.length < 2) return false;
        const s0 = doc.stops[o.anchors[0]?.id];
        const sLast = doc.stops[o.anchors[o.anchors.length - 1]?.id];
        if (!s0 || !B.isInterchange(s0)) return false;
        if (!sLast || !B.isInterchange(sLast)) return false;
        if (this._checkRouteInArea({ id: o.id, anchors: o.anchors })) return false;
        if (o.geom && o.geom.legs && o.geom.legs.some((l) => l.segs && l.segs.some((sg) => this.store.closedSet.has(sg.edge) || (this.store.affected && this.store.affected.has(sg.edge))))) return false;
        return true;
      });
      if (!options.length || options._ranked) return options;

      const r = doc.routes[routeId];
      const base = r && r.kind === 'proposed' && r.baseId && doc.routes[r.baseId] ? doc.routes[r.baseId] : r;
      const origStops = ((base && (base.originalAnchors || base.anchors)) || []).filter((a) => a.t === 'stop').map((a) => a.id);
      const nowGeom = base && this.store.geom[base.id];
      const cost = base ? this._runCost(base.number, nowGeom && nowGeom.time) : () => 0;
      for (const o of options) {
        o.cost = cost(o.length, o.time) || 0;
        const served = new Set(o.anchors.filter((a) => a.t === 'stop').map((a) => a.id));
        const skipped = origStops.filter((id) => !served.has(id));
        o.stopsSkipped = skipped.length;
        o.commutersAffected = skipped.reduce((sum, id) => sum + this._stopCommuters(id), 0);
      }

      // Each criterion scaled 0 (best of these options) to 1 (worst), then weighted
      const scaled = (key) => {
        const vals = options.map((o) => o[key]);
        const lo = Math.min(...vals), hi = Math.max(...vals);
        return (o) => (hi > lo ? (o[key] - lo) / (hi - lo) : 0);
      };
      const time = scaled('time'), dist = scaled('length'), skips = scaled('stopsSkipped'), riders = scaled('commutersAffected'), costs = scaled('cost');
      for (const o of options) {
        o.score = 0.3 * time(o) + 0.3 * costs(o) + 0.15 * dist(o) + 0.15 * skips(o) + 0.1 * riders(o);
        if (o.isInterchangeOption) o.score -= 0.15; // prioritize bus interchange detour options!
      }

      options.sort((a, b) => a.score - b.score);
      options.forEach((o, i) => {
        o.index = i;
        o.isRecommended = i === 0;
      });
      options._ranked = true;
      return options;
    }

    // ------------------------------------------------------------- Buses in view (the In view chip)
    // Bus numbers whose drawn line crosses the part of the map on screen, honouring the bus, time and layer filters
    _busesInView(ignoreSelection = false) {
      const R = this.renderer;
      const a = R.screenToWorld(0, 0);
      const b = R.screenToWorld(R.width, R.height);
      const vp = { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
      const inRect = (p) => p.x >= vp.x0 && p.x <= vp.x1 && p.y >= vp.y0 && p.y <= vp.y1;
      const side = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
      const crosses = (p, q, r, t) => side(p, q, r) !== side(p, q, t) && side(r, t, p) !== side(r, t, q);
      const corners = [{ x: vp.x0, y: vp.y0 }, { x: vp.x1, y: vp.y0 }, { x: vp.x1, y: vp.y1 }, { x: vp.x0, y: vp.y1 }];
      const segOnScreen = (p, q) => inRect(p) || inRect(q) || corners.some((c, i) => crosses(p, q, c, corners[(i + 1) % 4]));
      const running = this._runningBusNumbers();

      const shown = Object.values(this.store.doc.routes).filter((r) => {
        if (r.kind === 'proposed' ? !R.layers.proposedRoutes : !R.layers.existingRoutes) return false;
        if (!ignoreSelection && R.visibleRouteIds && !R.visibleRouteIds.has(r.id)) return false;
        if (running && !running.has(String(r.number).trim())) return false;
        const g = this.store.geom[r.id];
        return !!g && g.legs.some((l) => l.ok && l.pts && l.pts.some((p, i) => i > 0 && segOnScreen(l.pts[i - 1], p)));
      });
      return this._busGroups(shown).sort((x, y) => x.number.localeCompare(y.number, undefined, { numeric: true }));
    }

    // ------------------------------------------------------------- Tools panel (Move · Create Bus · Create Obstacle)
    _initToolbar() {
      const bar = document.getElementById('toolbar-floating');
      if (!bar) return;
      const closeMenus = (except = null) => {
        bar.querySelectorAll('.tool-group').forEach((group) => {
          if (group === except) return;
          group.querySelector('.tool-menu').hidden = true;
          group.querySelector('.tool-group-btn').setAttribute('aria-expanded', 'false');
        });
      };

      const select = document.getElementById('tool-select');
      if (select) {
        select.addEventListener('click', () => {
          closeMenus();
          this.setTool('select');
        });
      }

      bar.querySelectorAll('.tool-group').forEach((group) => {
        const btn = group.querySelector('.tool-group-btn');
        const menu = group.querySelector('.tool-menu');
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const opening = menu.hidden;
          closeMenus(group);
          menu.hidden = !opening;
          btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
        });
        menu.querySelectorAll('.tool-menu-item').forEach((item) => {
          item.addEventListener('click', (e) => {
            e.stopPropagation();
            closeMenus();
            if (item.dataset.action === 'new-bus') this._promptNewBus();
            else this.setTool(item.dataset.tool);
          });
        });
      });

      // A click anywhere else, or Esc, closes an open menu
      document.addEventListener('click', (e) => {
        if (!bar.contains(e.target)) closeMenus();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeMenus();
      });
      this._syncToolbar();
    }

    // Highlights the tool in use; a group's button takes the name and icon of its active item.
    // "route" is drawing a bus route: New Bus Number, or linking stops.
    _syncToolbar(shownTool = null) {
      const tool = shownTool || ((this.pendingNewBus || this.activeTool === 'route') ? 'route' : this.activeTool);
      const select = document.getElementById('tool-select');
      if (select) select.classList.toggle('active', tool === 'select');
      document.querySelectorAll('#toolbar-floating .tool-group').forEach((group) => {
        const items = [...group.querySelectorAll('.tool-menu-item')];
        const current = items.find((item) => item.dataset.tool === tool) || null;
        items.forEach((item) => item.classList.toggle('active', item === current));
        const btn = group.querySelector('.tool-group-btn');
        btn.classList.toggle('active', !!current);
        btn.querySelector('.tool-label').textContent = current ? current.querySelector('.tool-menu-label').textContent : btn.dataset.label;
        btn.querySelector('.tool-icon').textContent = current ? current.querySelector('.tool-icon').textContent : btn.dataset.icon;
      });
    }

    _isCreatingRoute() {
      return !!(
        this.activeConnectStopId ||
        this.activeTool === 'route' ||
        (this.routeDrawingAnchors && this.routeDrawingAnchors.length > 0) ||
        (this.renderer && this.renderer.connectingPreview !== null)
      );
    }

    _canMoveStop(stopId) {
      if (!stopId) return false;
      const stop = this.store.doc.stops[stopId];
      if (!stop) return false;
      if (this.mode === 'view') return false;
      if (this._isCreatingRoute()) return false;
      // Pre-existing baseline bus stops ("bus stop that we have before") cannot move!
      // Only newly created/proposed bus stops can be moved along roads.
      const isCreated = (stop.kind === 'proposed' || stop.userCreated || stop.isNew || (this.renderer && this.renderer.justCreatedStopId === stop.id));
      return !!isCreated;
    }

    _bindEvents() {
      const canvas = this.renderer.canvas;

      canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
      window.addEventListener('mousemove', (e) => this._onMouseMove(e));
      window.addEventListener('mouseup', (e) => this._onMouseUp(e));
      canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
      canvas.addEventListener('dblclick', (e) => this._onDblClick(e));
      canvas.addEventListener('mouseleave', () => {
        if (this.renderer.hovered) {
          this.renderer.hovered = null;
          this.renderer.requestRender();
        }
        if (this.renderer.hoveredForeign) {
          this.renderer.hoveredForeign = null;
          this.renderer.requestRender();
        }
        const tip = document.getElementById('map-tooltip');
        if (tip) tip.hidden = true;
      });
      window.addEventListener('keydown', (e) => this._onKeyDown(e));

      // Handle window resize
      window.addEventListener('resize', () => {
        this.renderer.resize();
      });

      this._initConfirmDeleteModal();
      this._initConfirmDeleteProjectModal();
      this._initConfirmApplyProjectModal();
      this._initConfirmRestoreVersionModal();
      this._initNewBusModal();
      this._initStopModals();
      this._initToolbar();
      this.renderer.onViewChange = () => {
        this._syncInViewFilter();
        this._renderQuickFilters();
      };
      this.renderer.getBlockedStops = () => this._blockedStopIds();
      this.renderer.getProjectScope = () => this._activeProjectScope();
      // View Changes: the button toggles the side panel; while it's open, its list follows the map
      const btnChanges = document.getElementById('btn-header-changes');
      if (btnChanges) btnChanges.addEventListener('click', () => this._toggleProjectChanges());
      const closeChanges = document.querySelector('#changes-panel .changes-close');
      if (closeChanges) closeChanges.addEventListener('click', () => this._toggleProjectChanges(false));
      B.events.on('doc', () => { if (this.projectChangesOpen) this._showChangesPanel(this._projectBase(this.activeProjectId)); });
      // Changes made by AI, in a bus card: Restore asks inline, then undoes changes to this route only
      const inspector = document.getElementById('inspector-panel');
      if (inspector) inspector.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act^="ai-restore"]');
        if (!b) return;
        const box = b.closest('.doc-notes');
        if (b.dataset.act === 'ai-restore') box.classList.add('confirming');
        else if (b.dataset.act === 'ai-restore-no') box.classList.remove('confirming');
        else if (b.dataset.act === 'ai-restore-yes') {
          const routeId = b.dataset.routeId || (this.renderer.selected && this.renderer.selected.type === 'route' && this.renderer.selected.id);
          const busNum = b.dataset.bus;
          this.restoreRouteAiChanges(routeId || busNum);
        }
      });
      document.querySelectorAll('#header-compare [data-view]').forEach((b) => {
        b.addEventListener('click', () => this.setBeforeView(b.dataset.view === 'before'));
      });
      window.addEventListener('storage', (e) => {
        if (!this.reviewMode && e.key && e.key.startsWith('brass_draw_')) this._renderProjects();
      });
      const btnDrawSend = document.getElementById('btn-draw-send');
      if (btnDrawSend) btnDrawSend.addEventListener('click', () => this._sendDrawUpdate());
      this._initLinkLineModalEvents();
      this._initLegendCollapsibles();
      if (B.seedSampleProjects) B.seedSampleProjects(this);
      this._removeEmptyRoutes();
      this._separateBusColors();
      this._initMapVersions();
      this._initScheduledChanges();
      this._initProjects();
      this._openSharedProject();
      window.addEventListener('hashchange', () => this._openSharedProject());
      this._initConnectingBarEvents();

      // View Mode Area Filter Buttons (Under Dropdown)
      const btnDrawArea = document.getElementById('btn-draw-area-filter');

      if (btnDrawArea) {
        btnDrawArea.addEventListener('click', () => {
          if (this.isDrawingAreaFilter) {
            if (this.areaFilterPts.length >= 3) {
              this._finishAreaFilterDrawing();
            } else {
              this._cancelAreaFilterDrawing();
            }
          } else if (this.areaFilterPolygon && this.areaFilterPolygon.length >= 3) {
            // A drawn area shows ✕: a click clears it
            this._clearAreaFilter();
          } else {
            this._startAreaFilterDrawing();
          }
        });
      }

      // Operating time window under the bus filter
      const timeFrom = document.getElementById('filter-time-from');
      const timeTo = document.getElementById('filter-time-to');
      const onTimeEdit = () => {
        this.timeFilter = { from: (timeFrom && timeFrom.value) || '00:00', to: (timeTo && timeTo.value) || '23:59' };
        this._applyTimeFilter();
      };
      [timeFrom, timeTo].forEach((input) => {
        if (!input) return;
        input.addEventListener('input', onTimeEdit);
        input.addEventListener('change', onTimeEdit);
      });
      const timeReset = document.getElementById('filter-time-reset');
      if (timeReset) {
        timeReset.addEventListener('click', () => {
          if (timeFrom) timeFrom.value = '00:00';
          if (timeTo) timeTo.value = '23:59';
          onTimeEdit();
        });
      }

      // Operating days above the time: a bus shows if it runs on any of the days picked
      document.querySelectorAll('#filter-days .day-chip').forEach((chip) => {
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          const d = Number(chip.dataset.day);
          const days = new Set(this.dayFilter);
          if (days.has(d)) days.delete(d);
          else days.add(d);
          this.dayFilter = [...days].sort((a, b) => a - b);
          this._applyTimeFilter();
        });
      });
      const dayReset = document.getElementById('filter-days-reset');
      if (dayReset) {
        dayReset.addEventListener('click', (e) => {
          e.stopPropagation();
          this.dayFilter = B.ALL_DAYS.slice();
          this._applyTimeFilter();
        });
      }

      // Multi-selection dropdown interactions
      const msTrigger = document.getElementById('multi-select-trigger');
      const msMenu = document.getElementById('multi-select-dropdown');
      const msContainer = document.getElementById('route-multi-select-container');
      const msSearchInput = document.getElementById('ms-search-input');
      const msSearchClear = document.getElementById('ms-search-clear');

      const hasFocusItem = () => {
        const tag = document.getElementById('ms-search-focus-tag');
        const hasTag = tag && !tag.classList.contains('hidden') && tag.innerHTML.trim().length > 0;
        return Boolean(this.currentFocusItem || (this.selectedEntities && this.selectedEntities.size > 0) || hasTag);
      };

      const openDropdown = () => {
        if (!msMenu) return;
        msMenu.classList.remove('hidden');
        if (msTrigger) {
          msTrigger.classList.add('open');
          msTrigger.setAttribute('aria-expanded', 'true');
        }
        if (msSearchInput) {
          msSearchInput.placeholder = hasFocusItem() ? '' : 'Search bus number, stop, MRT, road, postal...';
          setTimeout(() => {
            msSearchInput.focus();
            if (msSearchInput.value) msSearchInput.select();
          }, 20);
        }
      };

      const closeDropdown = () => {
        if (!msMenu) return;
        msMenu.classList.add('hidden');
        if (msTrigger) {
          msTrigger.classList.remove('open');
          msTrigger.setAttribute('aria-expanded', 'false');
        }
        if (msSearchInput) {
          msSearchInput.value = '';
          if (msSearchClear) msSearchClear.classList.add('hidden');
          this._filterRouteDropdown('');
          msSearchInput.placeholder = hasFocusItem() ? '' : 'Search bus number, stop, MRT, road, postal...';
          msSearchInput.blur();
        }
      };

      if (msTrigger && msMenu) {
        const msArrow = document.getElementById('multi-select-arrow');
        if (msArrow) {
          msArrow.addEventListener('click', (e) => {
            e.stopPropagation();
            if (msMenu.classList.contains('hidden')) {
              openDropdown();
            } else {
              closeDropdown();
            }
          });
        }

        msTrigger.addEventListener('click', (e) => {
          if (e.target.closest('#multi-select-arrow') || e.target.closest('#ms-search-clear')) return;
          if (msMenu.classList.contains('hidden')) {
            openDropdown();
          }
        });

        // Close when clicking outside
        document.addEventListener('click', (e) => {
          if (msContainer && !msContainer.contains(e.target)) {
            closeDropdown();
          }
        });

        // Close on Escape
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && !msMenu.classList.contains('hidden')) {
            closeDropdown();
          }
        });
      }

      if (msSearchInput) {
        msSearchInput.addEventListener('focus', () => {
          if (msMenu && msMenu.classList.contains('hidden')) {
            openDropdown();
          }
        });

        msSearchInput.addEventListener('input', (e) => {
          if (msMenu && msMenu.classList.contains('hidden')) {
            openDropdown();
          }
          if (msSearchClear) {
            msSearchClear.classList.toggle('hidden', !e.target.value);
          }
          this._filterRouteDropdown(e.target.value);
        });

        msSearchInput.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            if (msSearchInput.value) {
              msSearchInput.value = '';
              if (msSearchClear) msSearchClear.classList.add('hidden');
              this._filterRouteDropdown('');
              e.stopPropagation();
            } else {
              closeDropdown();
            }
          } else if (e.key === 'Enter') {
            const listContainer = document.getElementById('ms-options-list');
            if (listContainer) {
              const visibleRows = Array.from(listContainer.querySelectorAll('.ms-option-row')).filter(
                (r) => r.style.display !== 'none'
              );
              if (visibleRows.length >= 1) {
                visibleRows[0].click();
              }
            }
          }
        });
      }

      if (msSearchClear) {
        msSearchClear.addEventListener('click', (e) => {
          e.stopPropagation();
          if (msSearchInput) {
            msSearchInput.value = '';
            msSearchClear.classList.add('hidden');
            msSearchInput.focus();
          }
          this._filterRouteDropdown('');
        });
      }

      const btnSelectAll = document.getElementById('ms-select-all-chk');
      if (btnSelectAll) {
        btnSelectAll.addEventListener('change', (e) => {
          const listContainer = document.getElementById('ms-options-list');
          const visibleRows = listContainer
            ? Array.from(listContainer.querySelectorAll('.ms-option-row')).filter((r) => r.style.display !== 'none')
            : [];
          const visibleRouteIds = visibleRows.flatMap((r) => (r.dataset.routeIds || '').split(',')).filter(Boolean);

          if (e.target.checked && this.areaFilterPolygon && !this.routeSearchQuery) {
            this._clearAreaFilter();
            return;
          }
          if (e.target.checked) {
            if (this.routeSearchQuery && visibleRouteIds.length) {
              visibleRouteIds.forEach((rid) => this.selectedRouteIds.add(rid));
            } else {
              this.selectedRouteIds = new Set(Object.keys(this.store.doc.routes));
            }
            this.isAllRoutesSelected = (this.selectedRouteIds.size === Object.keys(this.store.doc.routes).length);
          } else {
            if (this.routeSearchQuery && visibleRouteIds.length) {
              visibleRouteIds.forEach((rid) => this.selectedRouteIds.delete(rid));
            } else {
              this.selectedRouteIds = new Set();
            }
            this.isAllRoutesSelected = false;
          }
          this._applyRouteMultiSelection();
        });
      }

      const btnClearAll = document.getElementById('ms-clear-btn');
      if (btnClearAll) {
        btnClearAll.addEventListener('click', (e) => {
          e.stopPropagation();
          const listContainer = document.getElementById('ms-options-list');
          const visibleRows = listContainer
            ? Array.from(listContainer.querySelectorAll('.ms-option-row')).filter((r) => r.style.display !== 'none')
            : [];
          const visibleRouteIds = visibleRows.flatMap((r) => (r.dataset.routeIds || '').split(',')).filter(Boolean);

          if (this.routeSearchQuery && visibleRouteIds.length) {
            visibleRouteIds.forEach((rid) => this.selectedRouteIds.delete(rid));
          } else {
            this.selectedRouteIds = new Set();
          }
          this.isAllRoutesSelected = false;
          this._applyRouteMultiSelection();
        });
      }

      // Map Opacity Slider (Adjusts background map opacity, leaves bus routes & stops at 100%)
      const opacitySlider = document.getElementById('map-opacity-slider');
      const opacityBadge = document.getElementById('map-opacity-badge');
      if (opacitySlider) {
        const updateOpacity = (val) => {
          const num = Math.round(Number(val));
          if (opacityBadge) opacityBadge.textContent = `${num}%`;
          this.renderer.setMapOpacity(num / 100);
        };
        opacitySlider.addEventListener('input', (e) => updateOpacity(e.target.value));
        opacitySlider.addEventListener('change', (e) => updateOpacity(e.target.value));
      }

      // Listen to store events
      B.events.on('doc', (ev) => {
        this.renderer.requestRender();
        // While dragging, the panels catch up a few times a second (and fully when the drag ends)
        if (ev && ev.live) {
          if (!this._liveUITimer) {
            this._liveUITimer = setTimeout(() => {
              this._liveUITimer = null;
              this._updateUIState();
            }, 200);
          }
          return;
        }
        if (this._liveUITimer) {
          clearTimeout(this._liveUITimer);
          this._liveUITimer = null;
        }
        if (this.drawMode) this._updateDrawSendState();
        else if (this.activeProjectId) {
          if (this.store && Array.isArray(this.store.past) && this.store.past.length > 0) {
            this._markProjectInProgress(this.activeProjectId);
          }
          this._saveCurrentProjectDraft(false);
        }
        this._updateUIState();
      });
    }

    _getMouseWorld(e) {
      const rect = this.renderer.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      return {
        screen: { x: sx, y: sy },
        world: this.renderer.screenToWorld(sx, sy),
      };
    }

    _onMouseDown(e) {
      // Grabbing the map stops a camera glide where it is; a project name shown by a click goes away
      this.renderer.cameraAnim = null;
      this._hideForeignName();

      // Before: the map before this project, read-only; dragging pans, nothing else
      if (this.beforeView) {
        if (e.button === 0 || e.button === 1) {
          this.isPanning = true;
          this.panStart = { x: e.clientX, y: e.clientY };
          this.mouseDownPos = { x: e.clientX, y: e.clientY };
          this.hasMovedMap = false;
          this.renderer.canvas.style.cursor = 'grabbing';
        }
        return;
      }

      // Drawing page, Move tool: drag the points of an area drawn here to adjust it (the middle point moves it)
      if (this.reviewMode && this.drawMode && this.activeTool === 'select' && e.button === 0) {
        const sel = this.renderer.selected;
        const area = sel && sel.type === 'area' && !this.drawBase.areas[sel.id] ? this.store.doc.areas[sel.id] : null;
        const handle = area && this._hitTestAreaHandle(area, this._getMouseWorld(e).world);
        if (handle) {
          this.mouseDownPos = { x: e.clientX, y: e.clientY };
          this.isDragging = true;
          this.dragTarget = { type: 'area-handle', area, handle, orig: JSON.parse(JSON.stringify(area)) };
          this.store.begin();
          return;
        }
      }
      if (this.reviewMode && !this.isDrawingAreaFilter && !(this.drawMode && this.activeTool !== 'select' && e.button === 0)) {
        if (e.button === 0 || e.button === 1) {
          this.isPanning = true;
          this.panStart = { x: e.clientX, y: e.clientY };
          this.mouseDownPos = { x: e.clientX, y: e.clientY };
          this.hasMovedMap = false;
          const pressWorld = this._getMouseWorld(e).world;
          const pickable = e.button === 0 && !this.drawMode;
          const pressMrt = pickable ? this._hitTestMrt(pressWorld) : null;
          this.reviewPressStop = pressMrt ? { mrt: pressMrt } : (pickable ? this._hitTestStop(pressWorld) : null);
          this.renderer.canvas.style.cursor = 'grabbing';
        }
        return;
      }
      if (e.button === 1 || (e.button === 0 && e.spaceKey)) { // Middle click or space+click
        this.isPanning = true;
        this.panStart = { x: e.clientX, y: e.clientY };
        return;
      }
      if (e.button !== 0) return;

      const { world, screen } = this._getMouseWorld(e);

      this.mouseDownPos = { x: e.clientX, y: e.clientY };
      this.hasDragged = false;
      this.dragCandidate = null;
      this.pendingStopClick = null;

      // 0. IF ALREADY CONNECTING: Connect to next bus stop dot only!
      if (this.activeConnectStopId) {
        // Target must be an existing bus stop dot (excluding origin)
        const targetStop = (this.renderer.connectingPreview && this.renderer.connectingPreview.toStop) ||
                           this._hitTestStop(world, this.activeConnectStopId, 32);

        if (targetStop && targetStop.id !== this.activeConnectStopId) {
          this._connectStops(this.activeConnectStopId, targetStop.id);
          return;
        }

        // Did not click on an existing bus stop: automatically in Move mode -> pan map or click blank space to confirm route!
        this.isPanning = true;
        this.panStart = { x: e.clientX, y: e.clientY };
        this.hasMovedMap = false;
        this.renderer.canvas.style.cursor = 'grabbing';
        this.renderer.requestRender();
        return;
      }

      // Handle polygon area filter drawing
      if (this.isDrawingAreaFilter) {
        if (this.areaFilterPts.length >= 3) {
          const firstPt = this.areaFilterPts[0];
          const dist = Math.hypot(world.x - firstPt.x, world.y - firstPt.y);
          const tol = 16 / this.renderer.camera.zoom;
          if (dist <= tol) {
            this._finishAreaFilterDrawing();
            return;
          }
        }
        this.areaFilterPts.push({ x: world.x, y: world.y });
        this.renderer.drawingAreaFilter = this.areaFilterPts;
        this._updateAreaFilterUI();
        this.renderer.requestRender();
        return;
      }

      if (this.activeTool === 'select') {
        // Check for area handles first if an area is selected
        if (this.renderer.selected && this.renderer.selected.type === 'area' && this.mode !== 'view') {
          const area = this.store.doc.areas[this.renderer.selected.id];
          if (area) {
            const handle = this._hitTestAreaHandle(area, world);
            if (handle) {
              this.isDragging = true;
              this.dragTarget = { type: 'area-handle', area, handle, orig: JSON.parse(JSON.stringify(area)) };
              this.store.begin();
              return;
            }
          }
        }

        // Hit-test objects: Bus Stop, Affected Area, Bus Route, Road Segment
        const hit = this._hitTest(world);
        if (!hit && this.activeTool === 'select') {
          const foreignHit = this._foreignAt(world);
          if (foreignHit) {
            this.pendingForeignClick = foreignHit;
          }
        }
        if (hit && hit.type === 'mrt') {
          this._hideAreaFilterOutline();
          this._hideFloatingStopActions();
          this._hideFloatingLegActions();
          this.renderer.selected = hit;
          if (hit.type === 'route' || hit.type === 'route-leg') {
            const rId = hit.routeId || hit.id;
            const rObj = hit.obj || (this.store && this.store.doc.routes[rId]);
            if (rObj) {
              const busNum = String(rObj.number).trim();
              const siblingIds = Object.values(this.store.doc.routes)
                .filter((r) => String(r.number).trim() === busNum)
                .map((r) => r.id);
              this.selectedRouteIds = new Set(siblingIds);
              this.isAllRoutesSelected = false;
            }
          }
          this._showInspector(hit);
          this.renderer.requestRender();
          return;
        }
        if (hit) {
          this._hideAreaFilterOutline();
          if (this.pendingNewBus && hit.type === 'stop') {
            const num = this.pendingNewBus.number;
            this._startConnectingFrom(hit.id, null, { busNumber: num, explicit: true });
            this._showToast(`Click the next stop for Bus ${B.esc(num)}`, 'info');
            return;
          }
          if (this.mode === 'view') {
            this._hideFloatingStopActions();
            this._hideFloatingLegActions();

            // In view mode: clicking any line selects the bus line while preserving clicked leg and road info!
            if (hit.type === 'route-leg' || hit.type === 'route') {
              const rId = hit.routeId || hit.id;
              const rObj = hit.obj || (this.store && this.store.doc.routes[rId]);
              const routeTarget = {
                ...hit,
                type: 'route-leg',
                id: rId,
                routeId: rId,
                obj: rObj,
              };
              this.renderer.selected = routeTarget;
              this._showInspector(routeTarget);
            } else {
              this.renderer.selected = hit;
              this._showInspector(hit);
            }

            this.renderer.requestRender();
            return;
          }

          this.renderer.selected = hit;
          if (hit.type === 'route' || hit.type === 'route-leg') {
            const rId = hit.routeId || hit.id;
            const rObj = hit.obj || (this.store && this.store.doc.routes[rId]);
            if (rObj) {
              const busNum = String(rObj.number).trim();
              const siblingIds = Object.values(this.store.doc.routes)
                .filter((r) => String(r.number).trim() === busNum)
                .map((r) => r.id);
              this.selectedRouteIds = new Set(siblingIds);
              this.isAllRoutesSelected = false;
            }
          }
          this._showInspector(hit);

          if (hit.type === 'route-leg') {
            // Selected a specific line between two bus stops!
            this._hideFloatingStopActions();
            if (hit.isConstraintHit || hit.constraint) {
              this._hideFloatingLegActions();
            } else {
              this._showFloatingLegActions(hit, screen);
            }
            this.renderer.requestRender();
            return;
          }

          if (hit.type === 'stop') {
            if (this.activeConnectStopId && hit.id !== this.activeConnectStopId) {
              // Flexible connecting of dots: connect activeConnectStopId to hit.id!
              this._connectStops(this.activeConnectStopId, hit.id);
              this.renderer.selected = hit;
              this._showInspector(hit);
              this._hideFloatingStopActions();
              this.renderer.requestRender();
              return;
            }
            if (this._isCreatingRoute()) {
              this.renderer.selected = hit;
              this._showInspector(hit);
              this._showFloatingStopActions(hit.id);
              this.renderer.requestRender();
              return;
            }
            // Candidate for click (to select & inspect) or drag (to move)
            this.pendingStopClick = hit;
            if (this._canMoveStop(hit.id)) {
              this.dragCandidate = {
                type: 'stop',
                id: hit.id,
                origWorld: { ...world },
                origObj: { ...this.store.doc.stops[hit.id] },
              };
            } else {
              this.dragCandidate = null;
            }
          } else {
            this._hideFloatingStopActions();
            this.isDragging = true;
            this.dragTarget = {
              type: hit.type,
              id: hit.id,
              origWorld: { ...world },
            };
          }
        } else {
          // Click on empty space:
          // A plain click (no drag) also hides a drawn area filter on mouse up
          this.renderer.selected = null;
          this._hideInspector();
          this._hideFloatingLegActions();
          this._hideFloatingStopActions();
          this.isPanning = true;
          this.panStart = { x: e.clientX, y: e.clientY };
          this.hasMovedMap = false;
        }
        this.renderer.requestRender();
        return;
      }

      // 2. Tool: Bus Stop (Only when placing standalone bus stop, NOT during adjusting route line)
      if (this.activeTool === 'stop') {
        if (this._isCreatingRoute() || this.activeConnectStopId) {
          const hitStop = this._hitTestStop(world, this.activeConnectStopId, 32);
          if (hitStop && hitStop.id !== this.activeConnectStopId) {
            this._connectStops(this.activeConnectStopId, hitStop.id);
            this._hideFloatingStopActions();
            this.renderer.requestRender();
            return;
          }
          // Away from bus stop point: pan map in move mode!
          this.isPanning = true;
          this.panStart = { x: e.clientX, y: e.clientY };
          this.renderer.canvas.style.cursor = 'grabbing';
          this.renderer.requestRender();
          return;
        }

        const hitStop = this._hitTestStop(world);
        if (hitStop) {
          // Clicked existing stop: simply select and inspect
          this.renderer.selected = { type: 'stop', id: hitStop.id, obj: hitStop };
          this._showInspector(this.renderer.selected);
          this._showFloatingStopActions(hitStop.id);
          this.renderer.requestRender();
          return;
        }

        const cls = this.net.classify(world, 50);
        if (!cls.valid) {
          this.renderer.invalidPlacement = {
            x: world.x,
            y: world.y,
            reason: cls.reason || 'Road connection required',
            time: performance.now(),
          };
          this._showToast(`Can't place a stop here: ${cls.reason}`, 'error');
          this.renderer.requestRender();
          return;
        }

        let newStopId = null;
        this.store.commit('Create bus stop', (doc) => {
          newStopId = this.store.newId('S');
          const d = this.city.districtAt(this.net.posPoint({ edge: cls.edge, s: cls.pos.s, dir: cls.pos.dir }));
          doc.stops[newStopId] = {
            id: newStopId,
            code: d.code + String(Math.floor(Math.random() * 800 + 100)),
            name: `Stn ${this.net.edgeLabel(cls.edge).split(' ')[0]}`,
            edge: cls.edge,
            s: cls.pos.s,
            dir: cls.pos.dir,
            kind: 'proposed',
            userCreated: true,
            createdAt: Date.now(),
          };
        });

        this.renderer.justCreatedStopId = newStopId;
        this.renderer.selected = { type: 'stop', id: newStopId, obj: this.store.doc.stops[newStopId] };
        this._showInspector(this.renderer.selected);
        this.renderer.requestRender();
        return;
      }

      // 3. Tool: Affected Area (drawn like the area filter: click points, close on the first point)
      if (this.activeTool === 'area') {
        const pts = this.polyDrawingPts;
        const tol = 16 / this.renderer.camera.zoom;
        if (pts.length >= 3 && Math.hypot(world.x - pts[0].x, world.y - pts[0].y) <= tol) {
          this._finishPolygonArea();
          return;
        }
        // The second click of a double-click lands on the last point: don't add it twice
        const last = pts[pts.length - 1];
        if (last && Math.hypot(world.x - last.x, world.y - last.y) <= 4 / this.renderer.camera.zoom) return;
        pts.push({ x: world.x, y: world.y });
        this.renderer.drawingArea = pts;
        if (pts.length === 1) {
          this._showToast('Click to add points · Click the first point, double-click or Enter to finish', 'info');
        }
        this.renderer.requestRender();
        return;
      }

      // 4. Tool: Road Closure
      if (this.activeTool === 'closure') {
        const near = this.net.nearest(world, 45);
        if (near) {
          const e = this.net.edge(near.edge);
          // A drawing link adds closures; the project's own stay as they are
          if (this.drawMode && this.drawBase.closures[near.edge]) {
            this._showToast(`${B.esc(e.name)} is already closed`, 'info');
            return;
          }
          // A click closes an open road and reopens a closed one
          const wasClosed = !!this.store.doc.closures[near.edge];
          this.store.commit(`Toggle closure: ${e.name}`, (doc) => {
            B.ops.setClosed(doc, [near.edge], !wasClosed, { reason: 'Incident closure' });
          });
          this._showToast(`${e.name} ${wasClosed ? 'reopened' : 'closed'}`, wasClosed ? 'info' : 'warn');
          this._showInspector({ type: 'closure', id: near.edge });
        }
        this.renderer.requestRender();
        return;
      }


      // 6. Tool: Bus Route (connecting bus stop dots only)
      if (this.activeTool === 'route') {
        const hitStop = this._hitTestStop(world, this.activeConnectStopId, 32);
        if (hitStop) {
          if (this.activeConnectStopId && hitStop.id !== this.activeConnectStopId) {
            this._connectStops(this.activeConnectStopId, hitStop.id);
            this.renderer.requestRender();
            return;
          }
          this.routeDrawingAnchors.push({ t: 'stop', id: hitStop.id });
          this.activeConnectStopId = hitStop.id;
          this.renderer.drawingRoute = this.routeDrawingAnchors;
          this.renderer.requestRender();
          return;
        }

        // Did not click on an existing bus stop: in move mode, pan map or click blank space to confirm route!
        this.isPanning = true;
        this.panStart = { x: e.clientX, y: e.clientY };
        this.hasMovedMap = false;
        this.renderer.canvas.style.cursor = 'grabbing';
        this.renderer.requestRender();
        return;
      }
    }

    _onMouseMove(e) {
      const { world, screen } = this._getMouseWorld(e);

      // 1. Pan map
      if (this.isPanning) {
        const dx = e.clientX - this.panStart.x;
        const dy = e.clientY - this.panStart.y;
        if (Math.hypot(e.clientX - this.mouseDownPos.x, e.clientY - this.mouseDownPos.y) > 4) {
          this.hasMovedMap = true;
        }
        this.renderer.camera.x -= dx / this.renderer.camera.zoom;
        this.renderer.camera.y -= dy / this.renderer.camera.zoom;
        this.panStart = { x: e.clientX, y: e.clientY };
        this.renderer.requestRender();
        return;
      }

      // 2. Drag threshold check for bus stop drag
      if (this.dragCandidate && !this.isDragging) {
        if (this.dragCandidate.type === 'stop' && !this._canMoveStop(this.dragCandidate.id)) {
          this.dragCandidate = null;
        } else {
          const dist = Math.hypot(e.clientX - this.mouseDownPos.x, e.clientY - this.mouseDownPos.y);
          if (dist > 6) {
            this.hasDragged = true;
            this.isDragging = true;
            this.dragTarget = this.dragCandidate;
            this.pendingStopClick = null;
            this._hideFloatingStopActions();
            if (this.dragTarget.type === 'stop') {
              this.store.begin();
            }
          }
        }
      }

      // 3. Dragging objects
      if (this.isDragging && this.dragTarget) {
        this.renderer.requestRender();
        // Drag Bus Stop along the road network (only newly created/proposed stops)
        if (this.dragTarget.type === 'stop') {
          if (!this._canMoveStop(this.dragTarget.id)) {
            this.isDragging = false;
            this.dragTarget = null;
            return;
          }
          const stop = this.store.doc.stops[this.dragTarget.id];
          if (stop) {
            // Check road classification
            const cls = this.net.classify(world, 50);
            if (cls.valid) {
              // Valid road snapping
              stop.edge = cls.pos.edge;
              stop.s = cls.pos.s;
              stop.dir = cls.pos.dir;
              this.renderer.snapTarget = {
                x: cls.point.x, y: cls.point.y, roadId: cls.edge,
              };
              this.renderer.invalidPlacement = null;
              this.store.live();
            } else {
              // Invalid placement indicator (over building, water, off-road)
              this.renderer.snapTarget = null;
              this.renderer.invalidPlacement = {
                x: world.x, y: world.y, reason: cls.reason || 'Inside non-drivable obstacle', time: performance.now(),
              };
            }
          }
          return;
        }

        // Drag affected area handles (resize, reshape, or move)
        if (this.dragTarget.type === 'area-handle') {
          const { area, handle } = this.dragTarget;
          if (area.shape === 'circle') {
            if (handle.type === 'center') {
              area.cx = world.x;
              area.cy = world.y;
            } else if (handle.type === 'radius') {
              area.r = Math.max(30, Math.hypot(world.x - area.cx, world.y - area.cy));
            }
          } else {
            // Polygon handle
            if (handle.type === 'center') {
              const dx = world.x - handle.cx;
              const dy = world.y - handle.cy;
              area.pts.forEach((p, idx) => {
                p.x = handle.origPts[idx].x + dx;
                p.y = handle.origPts[idx].y + dy;
              });
            } else if (handle.type === 'vertex') {
              area.pts[handle.index].x = world.x;
              area.pts[handle.index].y = world.y;
            }
          }
          this.store.live();
          return;
        }
      }

      // 4. Hovering bus stop snapping & travel line preview
      if (this.activeConnectStopId) {
        const fromStop = this.store.doc.stops[this.activeConnectStopId];
        if (fromStop) {
          const fromPos = { edge: fromStop.edge, s: fromStop.s, dir: fromStop.dir };
          const hitStop = this._hitTestStop(world, this.activeConnectStopId, 32);
          const hitBlocked = hitStop && (this._blockedStopIds() || new Set()).has(hitStop.id);
          if (hitBlocked) {
            this.renderer.connectingPreview = null;
            this.renderer.snapTarget = null;
            this.renderer.canvas.style.cursor = 'not-allowed';
          } else if (hitStop) {
            const targetPos = { edge: hitStop.edge, s: hitStop.s, dir: hitStop.dir };
            const leg = this._findRoute(fromPos, targetPos);
            this.renderer.connectingPreview = {
              fromStop, toPos: targetPos, toStop: hitStop, leg, valid: leg.ok, worldCursor: world,
            };
            const hitPt = this.net.posPoint(hitStop, 0.78);
            this.renderer.snapTarget = { type: 'stop', id: hitStop.id, x: hitPt.x, y: hitPt.y, roadId: hitStop.edge };
            this.renderer.canvas.style.cursor = 'pointer';
            this._updateConnectingModeUI('link', hitStop);
          } else {
            // SNAP ON BUS STOP ONLY: Do not snap to arbitrary road coordinates
            this.renderer.connectingPreview = null;
            this.renderer.snapTarget = null;
            this.renderer.canvas.style.cursor = 'grab';
            this._updateConnectingModeUI('move');
          }
          this.renderer.requestRender();
          return;
        }
      }

      // Check if drawing route with existing anchors
      if (this.activeTool === 'route' && this.routeDrawingAnchors.length > 0) {
        const lastA = this.routeDrawingAnchors[this.routeDrawingAnchors.length - 1];
        let fromPos = lastA;
        let fromStop = null;
        if (lastA.t === 'stop') {
          fromStop = this.store.doc.stops[lastA.id];
          if (fromStop) fromPos = { edge: fromStop.edge, s: fromStop.s, dir: fromStop.dir };
        }
        if (fromPos) {
          const hitStop = this._hitTestStop(world, fromStop ? fromStop.id : null, 32);
          if (hitStop && (!fromStop || hitStop.id !== fromStop.id)) {
            const targetPos = { edge: hitStop.edge, s: hitStop.s, dir: hitStop.dir };
            const leg = this._findRoute(fromPos, targetPos);
            this.renderer.connectingPreview = {
              fromStop: fromStop || { name: 'Anchor ' + this.routeDrawingAnchors.length, edge: fromPos.edge, s: fromPos.s, dir: fromPos.dir },
              toPos: targetPos, toStop: hitStop, leg, valid: leg.ok, worldCursor: world,
            };
            const hitPt = this.net.posPoint(hitStop, 0.78);
            this.renderer.snapTarget = { type: 'stop', id: hitStop.id, x: hitPt.x, y: hitPt.y, roadId: hitStop.edge };
            this.renderer.canvas.style.cursor = 'pointer';
            this._updateConnectingModeUI('link', hitStop);
          } else {
            // SNAP ON BUS STOP ONLY: Do not snap to roads
            this.renderer.connectingPreview = null;
            this.renderer.snapTarget = null;
            this.renderer.canvas.style.cursor = 'grab';
            this._updateConnectingModeUI('move');
          }
          this.renderer.requestRender();
          return;
        }
      }

      if (this.activeTool === 'route') {
        // In route mode: snap only to bus stop dots!
        const hitStop = this._hitTestStop(world, null, 32);
        const oldTarget = this.renderer.snapTarget;
        if (hitStop) {
          const pt = this.net.posPoint(hitStop, 0.78);
          this.renderer.snapTarget = { type: 'stop', id: hitStop.id, x: pt.x, y: pt.y, roadId: hitStop.edge };
        } else {
          this.renderer.snapTarget = null;
        }
        if (oldTarget !== this.renderer.snapTarget) {
          this.renderer.requestRender();
        }
        return;
      }

      if (this.activeTool === 'stop') {
        // Bus stop tool: snaps to road to place a new stop
        this.renderer.connectingPreview = null;
        const cls = this.net.classify(world, 45);
        const oldTarget = this.renderer.snapTarget;
        if (cls.valid) {
          this.renderer.snapTarget = {
            x: cls.point.x, y: cls.point.y, roadId: cls.edge,
          };
        } else {
          this.renderer.snapTarget = null;
        }
        if (oldTarget !== this.renderer.snapTarget) {
          this.renderer.requestRender();
        }
        return;
      }

      // 3a. Affected Area live preview: a line from the last point to the cursor
      if (this.activeTool === 'area' && this.polyDrawingPts.length) {
        this.renderer.drawingAreaPreview = { x: world.x, y: world.y };
        this.renderer.canvas.style.cursor = 'crosshair';
        this.renderer.requestRender();
        return;
      }

      // 3b. Area Filter Live Preview
      if (this.isDrawingAreaFilter) {
        this.renderer.drawingAreaFilterPreview = { x: world.x, y: world.y };
        this.renderer.canvas.style.cursor = 'crosshair';
        this.renderer.requestRender();
        return;
      }

      // 4. Hover detection for cursor styling & inspector tooltip
      if (this.beforeView) {
        this.renderer.canvas.style.cursor = 'grab';
        return;
      }
      // Reviewing: only bus stops light up, since they're the only thing to click
      if (this.reviewMode) {
        if (this.drawMode) {
          let cursor = this.activeTool !== 'select' ? 'crosshair' : 'grab';
          const sel = this.renderer.selected;
          const area = this.activeTool === 'select' && sel && sel.type === 'area' && !this.drawBase.areas[sel.id] ? this.store.doc.areas[sel.id] : null;
          if (area && this._hitTestAreaHandle(area, world)) cursor = 'move';
          this.renderer.canvas.style.cursor = this.isDragging ? 'grabbing' : cursor;
          return;
        }
        const mrt = this._hitTestMrt(world);
        const stop = mrt ? null : this._hitTestStop(world);
        let next = mrt ? { type: 'mrt', id: mrt.id, obj: mrt } : (stop ? { type: 'stop', id: stop.id, obj: stop } : null);
        if (!next) {
          const hit = this._hitTest(world);
          if (hit && (hit.type === 'route' || hit.type === 'route-leg')) {
            const rId = hit.routeId || hit.id;
            next = { type: 'route', id: rId, obj: hit.obj || (this.store && this.store.doc.routes[rId]) };
          }
        }
        const prev = this.renderer.hovered;
        if ((prev && prev.id) !== (next && next.id)) {
          this.renderer.hovered = next;
          this.renderer.requestRender();
        }
        this.renderer.canvas.style.cursor = next ? 'pointer' : 'grab';
        return;
      }
      let hit = this._hitTest(world);
      if (this.mode === 'view' && hit && (hit.type === 'route-leg' || hit.type === 'route') && !hit.isConstraintHit) {
        const rId = hit.routeId || hit.id;
        hit = { type: 'route', id: rId, obj: hit.obj || (this.store && this.store.doc.routes[rId]) };
      }
      const prevHit = this.renderer.hovered;
      const isSameHit = (prevHit === hit) || (prevHit && hit && prevHit.type === hit.type && prevHit.id === hit.id && prevHit.legIndex === hit.legIndex);
      if (!isSameHit) {
        this.renderer.hovered = hit;
        this.renderer.requestRender();
      }

      // Check foreign obstacles under cursor when hovering with select tool
      const foreignHit = (!hit && this.activeTool === 'select') ? this._foreignAt(world) : null;
      const prevForeign = this.renderer.hoveredForeign;
      if (foreignHit !== prevForeign) {
        this.renderer.hoveredForeign = foreignHit;
        this.renderer.requestRender();
      }

      const tip = document.getElementById('map-tooltip');
      if (foreignHit && tip) {
        tip.innerHTML = `<span style="font-weight:700; color:#f8fafc;">${B.esc(foreignHit.projectName)}</span> <span style="font-size:10.5px; color:#94a3b8; font-weight:500;">· Click to view details</span>`;
        tip.style.left = `${e.clientX + 14}px`;
        tip.style.top = `${e.clientY + 14}px`;
        tip.hidden = false;
      } else if (!foreignHit && tip && !tip.hidden) {
        tip.hidden = true;
      }

      this.renderer.canvas.style.cursor = (hit || foreignHit) ? 'pointer' : (this.activeTool === 'select' ? 'default' : 'crosshair');
    }

    _onMouseUp(e) {
      this.renderer.requestRender();
      if (this.isPanning) {
        this.isPanning = false;
        const wasPan = this.hasMovedMap;
        this.hasMovedMap = false;
        if (this.beforeView) {
          this.renderer.canvas.style.cursor = 'grab';
          return;
        }

        // Drawing page, Move tool: a click picks one of your drawings (Delete removes it), elsewhere lets go
        if (this.reviewMode && this.drawMode) {
          this.reviewPressStop = null;
          if (!wasPan) {
            const hit = this._drawnAt(this._getMouseWorld(e).world);
            this.renderer.selected = hit;
            if (hit && !this._drawDeleteHinted) {
              this._drawDeleteHinted = true;
              this._showToast(hit.type === 'area' ? 'Drag its points to adjust · Delete to remove' : 'Press Delete to remove it', 'info');
            }
          }
          this.renderer.canvas.style.cursor = 'grab';
          this.renderer.requestRender();
          return;
        }

        // Reviewing: a click on a stop or bus route opens its info, a click elsewhere closes it
        if (this.reviewMode) {
          const stop = this.reviewPressStop;
          this.reviewPressStop = null;
          if (!wasPan && !stop && this._hideAreaFilterOutline()) {
            this.renderer.canvas.style.cursor = 'grab';
            this.renderer.requestRender();
            return;
          }
          if (!wasPan) {
            if (stop && stop.mrt) {
              this.renderer.selected = { type: 'mrt', id: stop.mrt.id, obj: stop.mrt };
              this._showInspector(this.renderer.selected);
            } else if (stop) {
              this.renderer.selected = { type: 'stop', id: stop.id, obj: stop };
              this._showInspector(this.renderer.selected);
            } else {
              const hit = this._hitTest(this._getMouseWorld(e).world);
              if (hit && (hit.type === 'route' || hit.type === 'route-leg')) {
                const rId = hit.routeId || hit.id;
                const rObj = hit.obj || (this.store && this.store.doc.routes[rId]);
                this.renderer.selected = { ...hit, type: 'route-leg', id: rId, routeId: rId, obj: rObj };
                this._showInspector(this.renderer.selected);
              } else {
                this.renderer.selected = null;
                this._hideInspector();
              }
            }
          }
          this.renderer.canvas.style.cursor = stop && !wasPan ? 'pointer' : 'grab';
          this.renderer.requestRender();
          return;
        }

        // User clicked in blank space (did not drag to pan):
        if (!wasPan && this.activeConnectStopId) {
          const r = (this.activeConnectRouteId && this.store.doc.routes[this.activeConnectRouteId]) ||
                    (this.lastActiveRouteId && this.store.doc.routes[this.lastActiveRouteId]);
          if (r && r.anchors && r.anchors.length >= 2) {
            // Done linking dots -> click blank space to confirm route!
            this._finishConnectingStops();
            this._showToast(`Route ${r.number} confirmed`, 'success');
            return;
          } else {
            // No route was linked yet -> cleanly exit connecting mode
            this._cancelConnectingStops(false);
            return;
          }
        }

        if (!wasPan && this.activeTool === 'route' && this.routeDrawingAnchors && this.routeDrawingAnchors.length >= 2) {
          this._finishRouteDrawing();
          this._showToast('Route confirmed', 'success');
          return;
        }

        // When drawing area filter: click blank space with >= 3 points finishes drawing & shows filtered results!
        if (!wasPan && this.isDrawingAreaFilter && this.areaFilterPts.length >= 3) {
          this._finishAreaFilterDrawing();
          return;
        }

        // When the drawn area is showing: a click on the map hides it, leaving only the filtered buses
        if (!wasPan && this._hideAreaFilterOutline()) return;

        // A plain click on another project's grey area or closure opens its project details in the right sidebar
        if (!wasPan && !this.activeConnectStopId) {
          const foreignHit = this.pendingForeignClick || this._foreignAt(this._getMouseWorld(e).world);
          this.pendingForeignClick = null;
          if (foreignHit) {
            this._showForeignDetails(foreignHit);
            return;
          }
        }
        this.pendingForeignClick = null;

        const { world } = this._getMouseWorld(e);
        if (this.activeConnectStopId) {
          const hitStop = this._hitTestStop(world, this.activeConnectStopId, 32);
          this.renderer.canvas.style.cursor = hitStop ? 'pointer' : 'grab';
          this._updateConnectingModeUI(hitStop ? 'link' : 'move', hitStop);
        } else if (this.reviewMode) {
          this.renderer.canvas.style.cursor = 'grab';
        } else {
          this.renderer.canvas.style.cursor = this.activeTool === 'select' ? 'default' : 'crosshair';
        }
        this.renderer.requestRender();
        return;
      }

      if (this.isDragging && this.dragTarget) {
        // Finishing bus stop drag
        if (this.dragTarget.type === 'stop') {
          if (!this._canMoveStop(this.dragTarget.id)) {
            this.isDragging = false;
            this.dragTarget = null;
            this.dragCandidate = null;
            return;
          }
          const stop = this.store.doc.stops[this.dragTarget.id];
          const { world } = this._getMouseWorld(e);
          const cls = this.net.classify(world, 50);

          if (!cls.valid) {
            // Invalid placement! Snap back to original position
            const orig = this.dragTarget.origObj;
            const origPt = this.net.posPoint(orig, 0.78);
            this.renderer.triggerSnapBack(world.x, world.y, origPt.x, origPt.y, () => {
              this.store.cancel();
              this._showToast(`Stop moved back: ${cls.reason}`, 'warn');
            });
          } else {
            // Valid road placement: commit to store
            this.store.end(`Moved bus stop ${stop.name}`);
            this._showToast(`Stop moved to ${this.net.edgeLabel(cls.edge)}`, 'info');
          }
          this.renderer.snapTarget = null;
        }

        // Finishing area handle dragging
        if (this.dragTarget.type === 'area-handle') {
          this.store.end('Adjusted affected area geometry');
        }

        this.isDragging = false;
        this.dragTarget = null;
        this.dragCandidate = null;
        this.pendingStopClick = null;
        return;
      }

      // If user simply clicked on the bus stop dot (released without dragging):
      if (!this.hasDragged && this.pendingStopClick) {
        const stopId = this.pendingStopClick.id;
        this.pendingStopClick = null;
        this.dragCandidate = null;
        // User clicked the dot -> simply select and inspect (does NOT enter create bus stop mode)
        this.renderer.selected = { type: 'stop', id: stopId, obj: this.store.doc.stops[stopId] };
        this._showInspector(this.renderer.selected);
        if (this.mode !== 'view') {
          this._showFloatingStopActions(stopId);
        }
        this.renderer.requestRender();
        return;
      }

      this.isDragging = false;
      this.dragTarget = null;
      this.dragCandidate = null;
      this.pendingStopClick = null;
    }

    _onWheel(e) {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 0.87;
      const rect = this.renderer.canvas.getBoundingClientRect();
      this.renderer.zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
    }

    _onDblClick(e) {
      if (this.beforeView) return;
      if (this.reviewMode && !this.isDrawingAreaFilter && !(this.drawMode && this.activeTool === 'area')) return;
      if (this.isDrawingAreaFilter && this.areaFilterPts.length >= 3) {
        this._finishAreaFilterDrawing();
        return;
      }

      // Finish bus stop connecting chain if active
      if (this.activeConnectStopId) {
        this._finishConnectingStops();
        return;
      }

      // Finish polygon drawing for Affected Area
      if (this.activeTool === 'area' && this.polyDrawingPts.length >= 3) {
        this._finishPolygonArea();
        return;
      }

      // Finish route creation
      if (this.activeTool === 'route' && this.routeDrawingAnchors.length >= 2) {
        this._finishRouteDrawing();
        return;
      }
    }

    _onKeyDown(e) {
      // Don't intercept if user is typing into an input / textarea
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      // Before is read-only: Esc goes back to After, every other shortcut is off
      if (this.beforeView) {
        if (e.key === 'Escape') this.setBeforeView(false);
        return;
      }
      // Reviewing: Enter finishes a drawn area and Esc clears it or closes the info; every other shortcut is off
      if (this.reviewMode) {
        // Drawing page: Enter finishes an area, Esc stops drawing, Delete removes an area drawn here
        if (this.drawMode && e.key === 'Enter' && this.activeTool === 'area' && this.polyDrawingPts.length >= 3) {
          e.preventDefault();
          this._finishPolygonArea();
          return;
        }
        if (this.drawMode && e.key === 'Escape') {
          if (this.activeTool !== 'select') this.setTool('select');
          else if (this.renderer.selected) { this.renderer.selected = null; this.renderer.requestRender(); }
          return;
        }
        if (this.drawMode && (e.key === 'Delete' || e.key === 'Backspace')) {
          this._deleteDrawn(this.renderer.selected);
          return;
        }
        if (this.drawMode && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const k = e.key.toLowerCase();
          const tool = k === 'm' ? 'select' : (k === 'a' ? 'area' : (k === 'c' ? 'closure' : null));
          if (tool) {
            this.setTool(tool);
            this.renderer.canvas.style.cursor = tool === 'select' ? 'grab' : 'crosshair';
            return;
          }
        }
        if (e.key === 'Enter' && this.isDrawingAreaFilter && this.areaFilterPts.length >= 3) {
          e.preventDefault();
          this._finishAreaFilterDrawing();
        } else if (e.key === 'Escape' && (this.isDrawingAreaFilter || this.areaFilterPolygon)) {
          if (this.isDrawingAreaFilter) this._cancelAreaFilterDrawing();
          else this._clearAreaFilter();
        } else if (e.key === 'Escape' && this.renderer.selected) {
          this.renderer.selected = null;
          this._hideInspector();
          this.renderer.requestRender();
        }
        return;
      }

      // Undo / Redo
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          const r = this.store.redo();
          if (r && this._showToast) this._showToast(`Redone: ${r}`, 'info');
        } else {
          const u = this.store.undo();
          if (u && this._showToast) this._showToast(`Undone: ${u}`, 'info');
        }
        this._updateHistoryButtons();
        this._updateSaveButton();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        const r = this.store.redo();
        if (r && this._showToast) this._showToast(`Redone: ${r}`, 'info');
        this._updateHistoryButtons();
        this._updateSaveButton();
        return;
      }

      // Save shortcut (Cmd+S / Ctrl+S)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        const btnSave = document.getElementById('btn-header-save');
        if (btnSave) btnSave.click();
        return;
      }

      // Tool shortcuts
      const key = e.key.toLowerCase();

      // If delete route confirmation modal is open, intercept escape and enter
      const deleteModal = document.getElementById('confirm-delete-modal');
      const isDeleteModalOpen = deleteModal && !deleteModal.classList.contains('hidden');
      if (isDeleteModalOpen) {
        if (key === 'escape') {
          e.preventDefault();
          this._closeConfirmDeleteModal();
          return;
        }
        if (key === 'enter') {
          if (document.activeElement && document.activeElement.id === 'btn-modal-cancel') {
            this._closeConfirmDeleteModal();
          } else {
            this._confirmDeleteRoute();
          }
          return;
        }
        return;
      }

      // If delete project confirmation modal is open, intercept escape and enter
      const deleteProjModal = document.getElementById('confirm-delete-project-modal');
      const isDeleteProjModalOpen = deleteProjModal && !deleteProjModal.classList.contains('hidden');
      if (isDeleteProjModalOpen) {
        if (key === 'escape') {
          e.preventDefault();
          this._closeConfirmDeleteProjectModal();
          return;
        }
        if (key === 'enter') {
          if (document.activeElement && document.activeElement.id === 'btn-project-modal-cancel') {
            this._closeConfirmDeleteProjectModal();
          } else {
            const btnConfirm = document.getElementById('btn-project-modal-confirm');
            if (btnConfirm && !btnConfirm.disabled) {
              this._confirmDeleteProject();
            }
          }
          return;
        }
        return;
      }

      // If apply project confirmation modal is open, intercept escape and enter
      const applyProjModal = document.getElementById('confirm-apply-project-modal');
      const isApplyProjModalOpen = applyProjModal && !applyProjModal.classList.contains('hidden');
      if (isApplyProjModalOpen) {
        if (key === 'escape') {
          e.preventDefault();
          this._closeConfirmApplyProjectModal();
          return;
        }
        if (key === 'enter') {
          if (document.activeElement && document.activeElement.id === 'btn-apply-modal-cancel') {
            this._closeConfirmApplyProjectModal();
          } else {
            this._confirmApplyProject();
          }
          return;
        }
        return;
      }

      // If restore version confirmation modal is open, intercept escape and enter
      const restoreModal = document.getElementById('confirm-restore-version-modal');
      const isRestoreModalOpen = restoreModal && !restoreModal.classList.contains('hidden');
      if (isRestoreModalOpen) {
        if (key === 'escape') {
          e.preventDefault();
          this._closeConfirmRestoreVersionModal();
          return;
        }
        if (key === 'enter') {
          e.preventDefault();
          if (document.activeElement && document.activeElement.id === 'btn-restore-modal-cancel') {
            this._closeConfirmRestoreVersionModal();
          } else {
            this._confirmRestoreMapVersion();
          }
          return;
        }
        return;
      }

      // If link line modal is open, intercept escape and enter
      const linkLineModal = document.getElementById('link-line-modal');
      const isLinkLineModalOpen = linkLineModal && !linkLineModal.classList.contains('hidden');
      if (isLinkLineModalOpen) {
        if (key === 'escape') {
          e.preventDefault();
          this._closeLinkLineModal();
          return;
        }
        if (key === 'enter') {
          e.preventDefault();
          if (document.activeElement && document.activeElement.id === 'btn-link-line-cancel') {
            this._closeLinkLineModal();
          } else {
            this._confirmLinkLine();
          }
          return;
        }
        return;
      }

      if (key === 'escape') {
        if (this.isDrawingAreaFilter) {
          this._cancelAreaFilterDrawing();
          return;
        }
        if (this.pendingNewBus && !this.activeConnectStopId) {
          this.pendingNewBus = null;
          this._syncToolbar();
          return;
        }
        if (this.areaFilterPolygon && !this.activeConnectStopId && !this.renderer.selected) {
          this._clearAreaFilter();
          return;
        }
        if (this.activeConnectStopId) {
          this._finishConnectingStops();
          return;
        }
        this.setTool('select');
        this.polyDrawingPts = [];
        this.routeDrawingAnchors = [];
        this.renderer.drawingArea = null;
        this.renderer.drawingRoute = null;
      } else if ((key === 'm' || key === 'v') && !e.metaKey && !e.ctrlKey) {
        this.setTool('select');
        this.polyDrawingPts = [];
        this.routeDrawingAnchors = [];
        this.renderer.drawingArea = null;
        this.renderer.drawingRoute = null;
      } else if (key === 's') {
        if (this.mode === 'view') this.setMode('edit');
        this.setTool('stop');
      } else if ((key === 'a' || key === 'z') && !e.metaKey && !e.ctrlKey) {
        if (this.mode === 'view') this.setMode('edit');
        this.setTool('area');
      } else if (key === 'c') {
        if (this.mode === 'view') this.setMode('edit');
        this.setTool('closure');
      } else if (key === 'f') {
        this.renderer.fitToBoundary();
      } else if (key === 'delete' || key === 'backspace') {
        if (this.mode === 'view') return;
        if (this._isCreatingRoute() && this.renderer.selected && this.renderer.selected.type === 'stop') {
          this._showToast('Finish the route before deleting stops', 'warn');
          return;
        }
        this._deleteSelected();
      } else if (key === 'enter' || e.code === 'Enter' || e.code === 'NumpadEnter') {
        if (this.isDrawingAreaFilter && this.areaFilterPts.length >= 3) {
          e.preventDefault();
          this._finishAreaFilterDrawing();
          return;
        }
        if (this.activeConnectStopId || this.activeConnectRouteId) {
          e.preventDefault();
          // If currently hovering/previewing/snapping on another valid bus stop, connect it first
          const targetStopId = (this.renderer.connectingPreview && this.renderer.connectingPreview.toStop && this.renderer.connectingPreview.toStop.id) ||
            (this.renderer.snapTarget && this.renderer.snapTarget.id) || null;
          if (this.activeConnectStopId && targetStopId && targetStopId !== this.activeConnectStopId) {
            this._connectStops(this.activeConnectStopId, targetStopId);
            return;
          }
          this._finishConnectingStops();
          return;
        }
        if (this.activeTool === 'area' && this.polyDrawingPts.length >= 3) {
          e.preventDefault();
          this._finishPolygonArea();
          return;
        } else if (this.activeTool === 'route' && this.routeDrawingAnchors.length > 0) {
          e.preventDefault();
          const targetStopId = (this.renderer.connectingPreview && this.renderer.connectingPreview.toStop && this.renderer.connectingPreview.toStop.id) ||
            (this.renderer.snapTarget && this.renderer.snapTarget.id) || null;
          if (targetStopId && (!this.routeDrawingAnchors.length || this.routeDrawingAnchors[this.routeDrawingAnchors.length - 1].id !== targetStopId)) {
            this.routeDrawingAnchors.push({ t: 'stop', id: targetStopId });
          }
          if (this.routeDrawingAnchors.length >= 2) {
            this._finishRouteDrawing();
          } else {
            this.setTool('select');
            this.routeDrawingAnchors = [];
            this.renderer.drawingRoute = null;
            this.renderer.requestRender();
          }
          return;
        }
      }
    }

    _finishPolygonArea() {
      const id = this.store.newId('A');
      const pts = [...this.polyDrawingPts];
      this.store.commit('Create affected polygon', (doc) => {
        doc.areas[id] = {
          id,
          name: 'Disruption Zone ' + id,
          shape: 'polygon',
          pts,
        };
      });
      this.polyDrawingPts = [];
      this.renderer.drawingArea = null;
      this.renderer.drawingAreaPreview = null;
      this.renderer.selected = { type: 'area', id };
      this._showInspector(this.renderer.selected);
      this._showToast(`Area ${id} finished`, 'warn');
    }


    _finishRouteDrawing() {
      const id = this.store.newId('R');
      const num = String(Math.floor(Math.random() * 80 + 20));
      const anchors = this.routeDrawingAnchors.map((pos) => {
        if (pos.t === 'stop') return { t: 'stop', id: pos.id };
        return {
          t: 'waypoint',
          edge: pos.edge,
          s: pos.s,
          dir: pos.dir,
        };
      });

      this.store.commit('Create bus route', (doc) => {
        const routeColor = B.pickRouteColor(Object.values(doc.routes).map((r) => r.color));
        doc.routes[id] = {
          id,
          number: num,
          name: `Proposed Express ${num}`,
          kind: 'proposed',
          color: routeColor,
          baseId: null,
          override: false,
          anchors,
        };
      });

      this.routeDrawingAnchors = [];
      this.renderer.drawingRoute = null;
      this.activeConnectStopId = null;
      this.renderer.connectingPreview = null;
      this._updateConnectingBar();
      this.renderer.selected = { type: 'route', id };
      this._showInspector(this.renderer.selected);
      this.store.save();
      this._saveCurrentProjectDraft(false);
    }

    _findRoute(fromPos, toPos, opts = {}) {
      let r = this.net.route(fromPos, toPos, opts);
      if (r.ok) return r;
      // If direct route failed, try the opposite direction on the target edge
      const altTo = { edge: toPos.edge, s: toPos.s, dir: -toPos.dir };
      const rAlt = this.net.route(fromPos, altTo, opts);
      if (rAlt.ok) return rAlt;
      // Also allow U-turn if standard routing failed
      const rU = this.net.route(fromPos, toPos, { ...opts, allowUturn: true });
      if (rU.ok) return rU;
      const rAltU = this.net.route(fromPos, altTo, { ...opts, allowUturn: true });
      if (rAltU.ok) return rAltU;
      return r;
    }

    // Ensure an editable draft project and edit mode are active when editing a route, stop, or constraint
    _ensureEditableForRoute() {
      if (this.reviewMode) return false;
      if (this._isArchivedActive()) return !this._isCurrentMapReadOnly();
      const sel = this.renderer && this.renderer.selected ? { ...this.renderer.selected } : null;
      if (this.activeProjectId === 'main') {
        if (this.projects && this.projects.length > 0) {
          this._switchProject(this.projects[0].id, 'edit');
        } else {
          this._createNewProject();
          this.editingProjectId = null;
          this._renderProjects();
        }
        if (sel && this.renderer) {
          this.renderer.selected = sel;
        }
      } else if (this.mode === 'view') {
        this.setMode('edit');
      }
      return true;
    }

    _pencilLock() {
      return null;
    }

    _stopStreetViewUrl(stopOrId) {
      const s = typeof stopOrId === 'object' ? stopOrId : (this.store && this.store.doc && this.store.doc.stops[stopOrId]);
      if (!s || !this.net) return 'https://www.google.com/maps';
      const pt = this.net.posPoint(s, 0.78);
      const ll = B.mapToLonLat
        ? B.mapToLonLat(pt.x, pt.y)
        : { lon: 103.6 + (pt.x / 50000) * (104.05 - 103.6), lat: 1.49 - (pt.y / 30000) * (1.49 - 1.22) };
      const heading = Number.isFinite(pt.ang)
        ? Math.round((((pt.ang * 180) / Math.PI + 90) % 360 + 360) % 360)
        : 0;
      return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${ll.lat.toFixed(6)},${ll.lon.toFixed(6)}&heading=${heading}`;
    }

    _streetViewLinkHtml(stopOrId, { label = 'Google Street View' } = {}) {
      const s = typeof stopOrId === 'object' ? stopOrId : (this.store && this.store.doc && this.store.doc.stops[stopOrId]);
      if (!s) return '';
      const url = this._stopStreetViewUrl(s);
      return `
        <a href="${B.esc(url)}" target="_blank" rel="noopener noreferrer" class="street-view-link" title="Open Google Street View for ${B.esc(s.name || 'this bus stop')}">
          <svg class="street-view-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="5.5" r="2.5"></circle>
            <path d="M9 20v-5l-1.5-2.5A2 2 0 0 1 9.2 9.5h5.6a2 2 0 0 1 1.7 3L15 15v5"></path>
          </svg>
          <span>${B.esc(label)}</span>
          <svg class="street-view-ext" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M7 17L17 7"></path>
            <path d="M8 7h9v9"></path>
          </svg>
        </a>
      `;
    }

    // ------------------------------------------------------------- Road Segment Constraints UI & Rerouting
    _renderConstraintItemHtml(c, routeOrNum = null, { compact = false, hideRoad = false, showStretch = false } = {}) {
      if (!c) return '';
      const rObj = (typeof routeOrNum === 'object' && routeOrNum)
        ? (this.store.doc.routes[routeOrNum.id] || routeOrNum)
        : (routeOrNum ? Object.values(this.store.doc.routes).find((x) => String(x.number).trim() === String(routeOrNum).trim()) : null);
      const decision = rObj && typeof this.store.getConstraintDecision === 'function'
        ? this.store.getConstraintDecision(rObj, c.id)
        : null;

      const canDecide = !!rObj && !this._isReadOnlyView();
      const subParts = [];
      if (!hideRoad && c.roadName) subParts.push(c.roadName);
      if (c.desc) subParts.push(c.desc);
      const descText = subParts.length ? `<div class="constraint-desc-sub">${B.esc(subParts.join(' · '))}</div>` : '';
      const stretchText = showStretch && c.fromStopName && c.toStopName
        ? `<div class="constraint-road-sub">${B.esc(c.fromStopName)} → ${B.esc(c.toStopName)}</div>`
        : '';
      const statusText = decision === 'accepted'
        ? ''
        : (decision === 'rejected'
          ? `<span class="seg-const-count is-rejected">${c.bypassed || (rObj && rObj.detourApplied) ? 'AI rerouted' : 'Not accepted'}</span>`
          : '<span class="seg-const-count">Pending</span>');

      const rawVia = String(rObj && rObj.viaName ? rObj.viaName : '').replace(/^via\s+/i, '').trim();
      const viaText = rawVia ? `via <strong>${B.esc(rawVia)}</strong>` : 'alternative corridor';
      const aiIcon = B.AI_ICON || '<svg class="ai-chip-icon" viewBox="0 0 24 24" aria-hidden="true" stroke-linejoin="round" stroke-width="1.5"><path d="M10 1.5Q13 7 18.5 10Q13 13 10 18.5Q7 13 1.5 10Q7 7 10 1.5Z" fill="#2196f3" stroke="#2196f3"/><path d="M18.5 14.5Q19.9 17.1 22.5 18.5Q19.9 19.9 18.5 22.5Q17.1 19.9 14.5 18.5Q17.1 17.1 18.5 14.5Z" fill="#7e57c2" stroke="#7e57c2"/></svg>';
      const aiNoteHtml = (decision === 'rejected' && rObj && (c.bypassed || rObj.detourApplied))
        ? `<div class="constraint-ai-status">
             <span class="constraint-ai-msg">${aiIcon}<span>Best way ${viaText}</span></span>
             ${!this._isReadOnlyView() ? `<button type="button" class="btn-constraint-compare" data-route-id="${B.esc(rObj.id)}">Compare options</button>` : ''}
           </div>`
        : '';

      return `
        <div class="constraint-row ${decision ? 'is-' + decision : ''}" data-constraint-id="${B.esc(c.id)}" data-edge-id="${c.edgeId}">
          <div class="constraint-title-line">
            <span class="constraint-title">${B.esc(c.label)}</span>
            ${statusText}
          </div>
          ${descText}
          ${stretchText}
          ${canDecide ? `
            <div class="constraint-actions-row">
              <button type="button" class="btn-constraint-choice btn-constraint-accept ${decision === 'accepted' ? 'active' : ''}" data-cid="${B.esc(c.id)}" data-eid="${c.edgeId}" data-decision="accepted">
                ✓ Accept
              </button>
              <button type="button" class="btn-constraint-choice btn-constraint-reject ${decision === 'rejected' ? 'active' : ''}" data-cid="${B.esc(c.id)}" data-eid="${c.edgeId}" data-decision="rejected">
                ✕ Not Accept
              </button>
            </div>
          ` : ''}
          ${aiNoteHtml}
        </div>
      `;
    }

    _renderRouteSegmentsConstraintsHtml() {
      return '';
    }

    _bindConstraintEvents(rootEl, routeOrNum, refreshFn = null) {
      if (!rootEl || !routeOrNum) return;
      const num = typeof routeOrNum === 'object' ? String(routeOrNum.number || '').trim() : String(routeOrNum).trim();
      const resolveRoute = () => {
        if (typeof routeOrNum === 'object' && this.store.doc.routes[routeOrNum.id]) return this.store.doc.routes[routeOrNum.id];
        return Object.values(this.store.doc.routes).find((x) => String(x.number).trim() === num) || null;
      };

      rootEl.querySelectorAll('.btn-constraint-choice').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const cid = btn.dataset.cid;
          const decision = btn.dataset.decision;
          const r = resolveRoute();
          if (!r || !cid) return;
          this._setConstraintDecision(r.id, cid, decision, refreshFn);
        });
      });

      rootEl.querySelectorAll('.btn-constraint-reroute').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const r = resolveRoute();
          if (!r) return;
          const legIdx = btn.dataset.legIdx !== undefined ? Number(btn.dataset.legIdx) : -1;
          this._rerouteToAvoidConstraints(r.id, legIdx, refreshFn);
        });
      });

      rootEl.querySelectorAll('.btn-constraint-compare').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const r = resolveRoute();
          if (!r) return;
          this._ensureEditableForRoute();
          const updatedR = resolveRoute() || r;
          this.detourScorecardRouteId = updatedR.id;
          this._closeNewBusModal();
          this.renderer.selected = { type: 'route', id: updatedR.id, obj: updatedR };
          this._showInspector(this.renderer.selected);
        });
      });

      rootEl.querySelectorAll('.route-seg-details > .route-seg-summary').forEach((summary) => {
        summary.addEventListener('click', () => {
          const detailsEl = summary.parentElement;
          const r = resolveRoute();
          if (!r || !detailsEl) return;
          const li = Number(detailsEl.dataset.legIdx);
          const g = this.store.geom[r.id];
          if (!g || !Array.isArray(g.legs) || !g.legs[li]) return;
          const leg = g.legs[li];
          const a1 = r.anchors[li];
          const a2 = r.anchors[li + 1];
          const fromStop = a1 && a1.t === 'stop' ? this.store.doc.stops[a1.id] : null;
          const toStop = a2 && a2.t === 'stop' ? this.store.doc.stops[a2.id] : null;
          const isConst = Boolean(g.constraint && g.constraint.legIndex === li);
          const edgeId = isConst ? g.constraint.edgeId : (leg.segs && leg.segs[0] ? leg.segs[0].edge : null);
          const clickedEdge = edgeId != null ? this.net.edge(edgeId) : null;
          const roadName = isConst && g.constraint.roadName
            ? g.constraint.roadName
            : (clickedEdge && clickedEdge.name ? clickedEdge.name : 'Main Corridor');
          const segDistKm = leg.ok ? B.fmtKm(leg.length) : '—';
          const segTimeMin = leg.ok ? B.fmtMin(leg.time || (leg.length / 5.3)) : '—';
          const fromStopName = fromStop ? fromStop.name : `Stop ${li + 1}`;
          const toStopName = toStop ? toStop.name : `Stop ${li + 2}`;
          const target = {
            type: 'route-leg',
            id: r.id,
            routeId: r.id,
            legIndex: li,
            fromStop,
            toStop,
            leg,
            obj: r,
            clickedEdge,
            roadName,
            isConstraintHit: isConst,
            constraint: isConst ? g.constraint : null,
          };
          this.renderer.selected = target;
          this._segmentDismissedFor = null;
          this._showSegmentPanel(target, roadName, {
            time: segTimeMin,
            km: segDistKm,
            rawLeg: leg,
            fromStopName,
            toStopName,
            legIdx: li,
            route: r,
            clickedEdge,
          });
          this.renderer.requestRender();
        });
      });
    }

    _setConstraintDecision(routeId, constraintId, decision, refreshFn = null) {
      if (!this._ensureEditableForRoute()) return;
      let r = this.store.doc.routes[routeId];
      if (!r && this.editingBusNumber) {
        r = Object.values(this.store.doc.routes).find((x) => String(x.number).trim() === String(this.editingBusNumber).trim());
      }
      if (!r) return;
      const num = String(r.number).trim();
      const current = this.store.getConstraintDecision(r, constraintId);
      const nextDecision = current === decision ? null : decision;

      const parts = constraintId.split('_');
      const edgeId = Number(parts[1]);
      const edgeObj = Number.isFinite(edgeId) ? this.net.edge(edgeId) : null;
      const roadLabel = edgeObj && edgeObj.name ? edgeObj.name : 'road segment';

      this.store.commit(`${nextDecision === 'accepted' ? 'Accept' : nextDecision === 'rejected' ? 'Not accept' : 'Clear'} constraint on ${roadLabel} (Bus ${num})`, (doc) => {
        doc.constraintDecisions = doc.constraintDecisions || {};
        const key = `${num}:${constraintId}`;
        if (nextDecision) doc.constraintDecisions[key] = nextDecision;
        else delete doc.constraintDecisions[key];

        for (const rt of Object.values(doc.routes)) {
          if (String(rt.number).trim() === num) {
            rt.constraintDecisions = rt.constraintDecisions || {};
            if (nextDecision) rt.constraintDecisions[constraintId] = nextDecision;
            else delete rt.constraintDecisions[constraintId];

            // If user now accepts (or clears) a constraint that previously triggered an AI constraint-only detour, restore the original path
            if (nextDecision !== 'rejected' && rt.constraintBypassOnly && rt.originalAnchors) {
              rt.anchors = JSON.parse(JSON.stringify(rt.originalAnchors));
              delete rt.originalAnchors;
              delete rt.detourApplied;
              delete rt.viaName;
              delete rt.detourTitle;
              delete rt.constraintBypassOnly;
            }
          }
        }
      });

      this.store.save();
      this._saveCurrentProjectDraft(false);

      if (nextDecision === 'rejected') {
        // When user clicks "Not accept", AI automatically finds and applies the best route avoiding that road segment
        const rerouted = this._rerouteToAvoidConstraints(r.id, -1, refreshFn, { autoFromAI: true, roadLabel });
        if (!rerouted) {
          this._showToast(`Constraint not accepted on ${B.esc(roadLabel)}`, 'warn');
        }
        return;
      }

      if (nextDecision === 'accepted') {
        this._showToast(`Accepted constraint on ${B.esc(roadLabel)}`, 'success');
      }

      if (this.renderer.selected) {
        this._showInspector(this.renderer.selected);
      }
      if (typeof refreshFn === 'function') refreshFn();
      this.renderer.requestRender();
    }

    _rerouteToAvoidConstraints(routeId, legIdx = -1, refreshFn = null, { autoFromAI = false, roadLabel = 'constrained segment' } = {}) {
      if (!this._ensureEditableForRoute()) return false;
      let r = this.store.doc.routes[routeId];
      if (!r && this.editingBusNumber) {
        r = Object.values(this.store.doc.routes).find((x) => String(x.number).trim() === String(this.editingBusNumber).trim());
      }
      if (!r) return false;

      const baseRouteId = (r.kind === 'proposed' && r.baseId) ? r.baseId : r.id;
      const hadOtherClosures = Boolean(
        (this.store.geom[baseRouteId] && this.store.geom[baseRouteId].conflicts && this.store.geom[baseRouteId].conflicts.length) ||
        this._routeInAffectedArea(r)
      );
      const options = this._rankedDetourOptions(baseRouteId);
      if (options && options.length > 0) {
        const bestOpt = options[0];
        this.applySuggestDetour(baseRouteId, 0, {
          silentToast: true,
          constraintBypassOnly: !hadOtherClosures,
        });
        if (autoFromAI) {
          this._showToast(`AI found the best route for Bus ${B.esc(r.number)} via ${B.esc(bestOpt.viaName || 'bypass')} (avoiding ${B.esc(roadLabel)})`, 'success');
        } else {
          this._showToast(`Rerouted Bus ${B.esc(r.number)} via ${B.esc(bestOpt.viaName || 'bypass')}`, 'success');
        }
        if (typeof refreshFn === 'function') refreshFn();
        return true;
      }

      // Direct bypass router if rankedDetourOptions returned empty (e.g. tight stop/length bounds)
      const rejSet = this.store.rejectedConstraintEdges(r);
      const avoidSet = new Set([...this.store.closedSet, ...rejSet]);
      if (this.store.affected) for (const e of this.store.affected.keys()) avoidSet.add(e);

      const srcAnchors = (r.originalAnchors || r.anchors || []).map((a) => ({ ...a }));
      const model = B.busModel(this.store.doc, r.number);
      const stopPt = (st) => this.net.posPoint(st, 0.78);
      const takes = (st) => !!st && !avoidSet.has(st.edge) && st.active !== false &&
        B.stopBusTypes(this.store.doc, st.id, this.store.stopLines[st.id] || []).includes(model);

      // Replace any stop sitting directly on a rejected constraint edge with the nearest valid stop
      const cleanAnchors = [];
      for (const a of srcAnchors) {
        if (a.t === 'stop') {
          const st = this.store.doc.stops[a.id];
          if (st && avoidSet.has(st.edge)) {
            const at = stopPt(st);
            const near = Object.values(this.store.doc.stops)
              .filter((cand) => cand.id !== st.id && takes(cand))
              .map((cand) => ({ cand, d: Math.hypot(stopPt(cand).x - at.x, stopPt(cand).y - at.y) }))
              .sort((x, y) => x.d - y.d)[0];
            if (near && (!cleanAnchors.length || cleanAnchors[cleanAnchors.length - 1].id !== near.cand.id)) {
              cleanAnchors.push({ t: 'stop', id: near.cand.id });
            }
            continue;
          }
        } else if (avoidSet.has(a.edge)) {
          continue;
        }
        cleanAnchors.push(a);
      }

      if (cleanAnchors.length < 2) {
        this._showToast('No alternative bypass road available around this segment', 'warn');
        return false;
      }

      // Pin waypoints along clear paths for any leg that crosses avoidSet
      let pins = cleanAnchors.slice();
      let bypassed = false;
      let viaRoadName = null;
      for (let tries = 0; tries < 6; tries++) {
        const gTest = this.store.computeRoute({ anchors: pins, kind: 'existing', number: r.number });
        const touchesAvoid = gTest.legs && gTest.legs.some((l) => l.ok && (l.segs || []).some((sg) => avoidSet.has(sg.edge)));
        if (gTest.ok && !touchesAvoid) {
          bypassed = true;
          break;
        }
        const next = [];
        for (let i = 0; i < pins.length; i++) {
          next.push(pins[i]);
          if (i >= pins.length - 1) continue;
          const leg = gTest.legs[i];
          const strays = leg && leg.ok && (leg.segs || []).some((sg) => avoidSet.has(sg.edge));
          if (!strays) continue;
          const A = this.store.resolveAnchor(pins[i]);
          const Bp = this.store.resolveAnchor(pins[i + 1]);
          if (!A || !Bp) continue;
          const clearLeg = this._findRoute(A, Bp, { closed: avoidSet, allowUturn: true });
          if (clearLeg && clearLeg.ok && clearLeg.segs && clearLeg.segs.length) {
            const picks = [...new Set([0.3, 0.7].map((f) => Math.floor(clearLeg.segs.length * f)))];
            for (const idx of picks) {
              const sg = clearLeg.segs[idx];
              if (sg && !avoidSet.has(sg.edge)) {
                const eVia = this.net.edge(sg.edge);
                if (eVia && eVia.name && !viaRoadName) viaRoadName = eVia.name;
                next.push({ t: 'waypoint', edge: sg.edge, s: (sg.s0 + sg.s1) / 2, dir: sg.dir, fixed: true });
              }
            }
          }
        }
        if (next.length === pins.length) break;
        pins = next;
      }

      if (!bypassed) {
        this._showToast('Could not find a complete bypass around this segment', 'warn');
        return false;
      }

      const finalVia = viaRoadName || 'AI bypass';
      this.store.commit(`AI reroute Bus ${r.number} to avoid ${roadLabel}`, (doc) => {
        const route = doc.routes[r.id];
        if (!route) return;
        if (!route.originalAnchors) {
          route.originalAnchors = JSON.parse(JSON.stringify(route.anchors));
        }
        route.anchors = pins;
        route.detourApplied = true;
        route.constraintBypassOnly = !hadOtherClosures;
        route.viaName = finalVia;
        route.detourTitle = `AI bypass via ${finalVia}`;
        const firstStop = doc.stops[route.anchors[0]?.id];
        const lastStop = doc.stops[route.anchors[route.anchors.length - 1]?.id];
        if (firstStop && lastStop) {
          route.name = `Bus ${route.number} (${firstStop.name} ➔ ${lastStop.name})`;
        }
      });

      this.store.save();
      this._saveCurrentProjectDraft(false);
      this.renderer.selected = { type: 'route', id: r.id, obj: this.store.doc.routes[r.id] };
      this._showInspector(this.renderer.selected);
      if (typeof refreshFn === 'function') refreshFn();
      this.renderer.requestRender();
      this._showToast(`AI found the best route for Bus ${B.esc(r.number)} via ${B.esc(finalVia)} (avoiding ${B.esc(roadLabel)})`, 'success');
      return true;
    }

    // ------------------------------------------------------------- Bus types at stops
    _stopTypes(stopId) {
      return B.stopBusTypes(this.store.doc, stopId, this.store.stopLines[stopId] || []);
    }

    _stopTakesBus(stopId, busNumber) {
      const stop = this.store.doc.stops[stopId];
      if (stop && stop.active === false) return false;
      return this._stopTypes(stopId).includes(B.busModel(this.store.doc, busNumber));
    }

    _warnStopBlocked(stopId, busNumber) {
      const stop = this.store.doc.stops[stopId];
      const name = B.esc(stop ? stop.name : 'This stop');
      if (stop && stop.active === false) return this._showToast(`${name} is not active`, 'warn');
      this._showToast(`${name} can't take ${B.esc(B.busModel(this.store.doc, busNumber))} buses`, 'warn');
    }

    // The bus being linked, when it's known: the number picked, the route being extended, or a new bus waiting for its first stop
    _connectingBusNumber() {
      if (this.connectBusNumber) return String(this.connectBusNumber).trim();
      const r = this.activeConnectRouteId && this.store.doc.routes[this.activeConnectRouteId];
      if (r && this.activeConnectStopId) return String(r.number).trim();
      if (this.pendingNewBus) return this.pendingNewBus.number;
      return null;
    }

    // Stops the bus being linked can't use (null when not linking); kept until the bus or the map changes
    _blockedStopIds() {
      const num = (this.activeConnectStopId || this.pendingNewBus) ? this._connectingBusNumber() : null;
      if (!num) return null;
      const key = `${num}|${this.store.rev}`;
      if (this._blockedCache && this._blockedCache.key === key) return this._blockedCache.ids;
      const model = B.busModel(this.store.doc, num);
      const ids = new Set(Object.keys(this.store.doc.stops).filter((id) => this.store.doc.stops[id].active === false || !this._stopTypes(id).includes(model)));
      this._blockedCache = { key, ids };
      return ids;
    }

    // The station logo is about 38 × 15 px on screen, whatever the zoom
    _hitTestMrt(world) {
      if (!this.renderer.layers.mrtStations) return null;
      const zoom = this.renderer.camera.zoom;
      const hw = 22 / zoom, hh = 11 / zoom;
      return (this.city.mrtStations || []).find((m) => Math.abs(world.x - m.x) <= hw && Math.abs(world.y - m.y) <= hh) || null;
    }

    _hitTestStop(world, excludeId = null, extraTol = 0) {
      const zoom = this.renderer.camera.zoom;
      const baseTol = Math.min(Math.max(14 / zoom, 10), 30);
      const tol = baseTol + extraTol;
      let bestStop = null;
      let bestDist = Infinity;
      // Only the stops drawn at this zoom can be picked
      for (const st of this.renderer.visibleStops()) {
        if (excludeId && st.id === excludeId) continue;
        const pt = this.renderer.stopPoint(st);
        const d = Math.hypot(world.x - pt.x, world.y - pt.y);
        if (d <= tol && d < bestDist) {
          bestDist = d;
          bestStop = st;
        }
        // Also hit-test attached label card
        if (this.renderer.layers.stopNames !== false) {
          const h = 18 / zoom;
          const yOffset = 24 / zoom;
          const labelHalfW = ((st.name || '').length * 4.5 + 30) / zoom;
          if (world.y >= pt.y - yOffset - 4 / zoom && world.y <= pt.y - yOffset + h + 4 / zoom && Math.abs(world.x - pt.x) <= labelHalfW) {
            if (d < bestDist) {
              bestDist = d;
              bestStop = st;
            }
          }
        }
        // Also hit-test attached '+' handle dot
        const handleDist = 18 / zoom;
        const hx = pt.x + Math.cos(pt.ang) * handleDist;
        const hy = pt.y + Math.sin(pt.ang) * handleDist;
        if (Math.hypot(world.x - hx, world.y - hy) <= tol) {
          if (d < bestDist) {
            bestDist = d;
            bestStop = st;
          }
        }
      }
      return bestStop;
    }

    // busNumber: link every stop in this chain as that bus without prompting.
    // explicit: the caller already chose the route, so don't fall back to the selected one.
    // True (with a short note) while the Current Map is open, since it can't be edited directly
    // An archived project is looked at, searched and filtered, never changed
    _isArchivedActive() {
      if (this.reviewMode || !this.projects) return false;
      const p = this.projects.find((x) => x.id === this.activeProjectId);
      return !!p && p.status === 'archive';
    }

    // A shared link or an archived project: nothing on the map can be changed
    _isReadOnlyView() {
      return this.reviewMode || this._isArchivedActive();
    }

    _isCurrentMapReadOnly() {
      const archived = this._isArchivedActive();
      if (this.activeProjectId !== 'main' && !archived) return false;
      if (this._showToast && Date.now() - (this._readOnlyNoticeAt || 0) > 2500) {
        this._readOnlyNoticeAt = Date.now();
        this._showToast(archived ? 'Archived project · view only' : 'Current Map is read-only. Edit a draft instead', 'info');
      }
      return true;
    }

    _startConnectingFrom(stopId, routeId = null, { busNumber = null, explicit = false } = {}) {
      const s = this.store.doc.stops[stopId];
      if (!s || this._isCurrentMapReadOnly()) return;
      const sel = this.renderer.selected;
      const startRoute = this.store.doc.routes[routeId || (!explicit && sel && sel.type === 'route' ? sel.id : '')];
      const startNum = busNumber || (startRoute && startRoute.number);
      if (startNum && !this._stopTakesBus(stopId, startNum)) {
        this._warnStopBlocked(stopId, startNum);
        return;
      }
      this._hideFloatingStopActions();
      this._hideFloatingLegActions();
      this.activeConnectStopId = stopId;
      this.connectBusNumber = busNumber;
      this.renderer.connectBusNumber = busNumber;

      // Only assign routeId if user explicitly had a route selected
      if (!routeId && !explicit) {
        if (this.renderer.selected && this.renderer.selected.type === 'route' && this.store.doc.routes[this.renderer.selected.id]) {
          routeId = this.renderer.selected.id;
        } else {
          routeId = null;
        }
      }

      this.activeConnectRouteId = routeId;
      if (routeId) this.lastActiveRouteId = routeId;
      this.activeTool = 'route';
      this.renderer.activeConnectStopId = stopId;
      this._syncToolbar();
      this._updateConnectingBar();
      this.renderer.requestRender();
    }

    _startNewBusLine() {
      this.activeConnectRouteId = null;
      this.lastActiveRouteId = null;
      this.connectBusNumber = null;
      this.renderer.connectBusNumber = null;
      this._updateConnectingBar();
      this.renderer.requestRender();
    }

    _connectStops(fromStopId, toStopId) {
      if (!fromStopId || !toStopId || fromStopId === toStopId) return;
      const fromStop = this.store.doc.stops[fromStopId];
      const toStop = this.store.doc.stops[toStopId];
      if (!fromStop || !toStop) return;

      // A bus picked (or shown) in this stop's pill counts as chosen
      const pill = this._pillBusChoice;
      if (!this.connectBusNumber && pill && pill.stopId === fromStopId && pill.num) {
        this.connectBusNumber = pill.num;
        this.renderer.connectBusNumber = pill.num;
      }

      const knownNum = this._connectingBusNumber();
      if (knownNum && !this._stopTakesBus(toStopId, knownNum)) {
        this._warnStopBlocked(toStopId, knownNum);
        return;
      }

      // The bus is already known (picked in the stop pill, the line being extended, or a new bus): link straight away.
      // Only a first link with no bus picked anywhere asks for a number.
      if (knownNum) {
        this._connectStopsWithNumber(fromStopId, toStopId, knownNum);
        return;
      }
      this._promptLinkLine(fromStopId, toStopId);
    }

    _connectStopsWithNumber(fromStopId, toStopId, busNumber) {
      const fromStop = this.store.doc.stops[fromStopId];
      const toStop = this.store.doc.stops[toStopId];
      if (!fromStop || !toStop) return;

      const num = String(busNumber || '35').trim() || '35';
      const blockedId = [fromStopId, toStopId].find((id) => !this._stopTakesBus(id, num));
      if (blockedId) {
        this._warnStopBlocked(blockedId, num);
        return;
      }
      let targetRouteId = null;

      this.store.commit(`Link Bus ${num} (${fromStop.name} ➔ ${toStop.name})`, (doc) => {
        const routes = Object.values(doc.routes);

        // Find existing routes with this bus number
        const routesWithSameNum = routes.filter((r) => String(r.number).trim() === num);

        // Check if an existing route with this number can be extended at either end
        let appendRoute = routesWithSameNum.find((r) => r.anchors && r.anchors.length && r.anchors[r.anchors.length - 1]?.id === fromStopId);
        let prependRoute = routesWithSameNum.find((r) => r.anchors && r.anchors.length && r.anchors[0]?.id === toStopId && r.id !== appendRoute?.id);

        if (!appendRoute && this.activeConnectRouteId && doc.routes[this.activeConnectRouteId]) {
          const activeR = doc.routes[this.activeConnectRouteId];
          if (String(activeR.number).trim() === num && activeR.anchors && activeR.anchors.length && activeR.anchors[activeR.anchors.length - 1]?.id === fromStopId) {
            appendRoute = activeR;
          }
        }

        // Determine color: reuse this bus number's colour, else a colour no other bus is using
        const existingColorRoute = routesWithSameNum[0];
        const routeColor = existingColorRoute ? existingColorRoute.color : B.pickRouteColor(routes.map((r) => r.color));
        // A bus made from New Bus Number has no stops yet: its first link fills it in
        const planned = routesWithSameNum.find((r) => r.planned && !(r.anchors || []).length);

        if (appendRoute && prependRoute && appendRoute.id !== prependRoute.id) {
          // Connect two existing segments of this bus route together
          appendRoute.kind = 'proposed';
          targetRouteId = appendRoute.id;
          for (const a of prependRoute.anchors) {
            appendRoute.anchors.push(a);
          }
          delete doc.routes[prependRoute.id];

          const firstStop = doc.stops[appendRoute.anchors[0]?.id];
          const lastStop = doc.stops[appendRoute.anchors[appendRoute.anchors.length - 1]?.id];
          appendRoute.name = `Route ${num} (${firstStop ? firstStop.name : ''} ➔ ${lastStop ? lastStop.name : ''})`;
        } else if (appendRoute) {
          // Extend existing route forward
          appendRoute.kind = 'proposed';
          targetRouteId = appendRoute.id;
          if (!appendRoute.anchors.some((a, idx) => idx === appendRoute.anchors.length - 1 && a.id === toStopId)) {
            appendRoute.anchors.push({ t: 'stop', id: toStopId });
          }
          const firstStop = doc.stops[appendRoute.anchors[0]?.id];
          const lastStop = doc.stops[appendRoute.anchors[appendRoute.anchors.length - 1]?.id];
          appendRoute.name = `Route ${num} (${firstStop ? firstStop.name : ''} ➔ ${lastStop ? lastStop.name : ''})`;
        } else if (prependRoute) {
          // Prepend to start of existing route
          prependRoute.kind = 'proposed';
          targetRouteId = prependRoute.id;
          if (!prependRoute.anchors.some((a, idx) => idx === 0 && a.id === fromStopId)) {
            prependRoute.anchors.unshift({ t: 'stop', id: fromStopId });
          }
          const firstStop = doc.stops[prependRoute.anchors[0]?.id];
          const lastStop = doc.stops[prependRoute.anchors[prependRoute.anchors.length - 1]?.id];
          prependRoute.name = `Route ${num} (${firstStop ? firstStop.name : ''} ➔ ${lastStop ? lastStop.name : ''})`;
        } else if (planned) {
          // First link of a bus made from New Bus Number (it already has its colour and hours)
          targetRouteId = planned.id;
          planned.anchors = [
            { t: 'stop', id: fromStopId },
            { t: 'stop', id: toStopId },
          ];
          planned.name = `Route ${num} (${fromStop.name} ➔ ${toStop.name})`;
          delete planned.planned;
        } else {
          // Fragmented bus stop pair or brand new line:
          targetRouteId = this.store.newId('R');
          doc.routes[targetRouteId] = {
            id: targetRouteId,
            number: num,
            name: `Route ${num} (${fromStop.name} ➔ ${toStop.name})`,
            kind: 'proposed',
            color: routeColor,
            baseId: null,
            override: false,
            anchors: [
              { t: 'stop', id: fromStopId },
              { t: 'stop', id: toStopId },
            ],
          };
        }

        // Pieces of this bus that now run end-to-start become one continuous route
        targetRouteId = this._mergeChainedRoutes(doc, num, targetRouteId);
      });
      // The new bus has its first stops now
      if (this.pendingNewBus && this.pendingNewBus.number === num) this.pendingNewBus = null;

      this.activeConnectRouteId = targetRouteId;
      this.lastActiveRouteId = targetRouteId;
      this.activeConnectStopId = toStopId;
      // The next link from here carries on with the same bus
      this.connectBusNumber = num;
      if (this.renderer) {
        this.renderer.connectBusNumber = num;
        this.renderer.activeConnectStopId = toStopId;
        this.renderer.lastActiveRouteId = targetRouteId;
        this.renderer.selected = { type: 'stop', id: toStopId };
        this.renderer.connectingPreview = null;
      }
      this._updateConnectingBar();
      this._showInspector({ type: 'stop', id: toStopId });
      this.store.save();
      this._saveCurrentProjectDraft(false);
      this.renderer.requestRender();

      this._showToast(`Linked Bus ${num}: ${fromStop.name} → ${toStop.name}`, 'success');
    }

    // Join route records of bus `num` wherever one ends at the stop where another starts.
    // Returns the id that now holds `keepId`'s stops.
    _mergeChainedRoutes(doc, num, keepId) {
      const endStop = (r, atStart) => {
        const a = atStart ? r.anchors[0] : r.anchors[r.anchors.length - 1];
        return a && a.t === 'stop' ? a.id : null;
      };
      let merged = true;
      while (merged) {
        merged = false;
        const pieces = Object.values(doc.routes).filter((r) => String(r.number).trim() === num && r.anchors && r.anchors.length);
        for (const head of pieces) {
          const joinStop = endStop(head, false);
          const tail = joinStop && pieces.find((p) => p !== head && endStop(p, true) === joinStop);
          if (!tail) continue;

          head.anchors.push(...tail.anchors.slice(1));
          if (tail.kind === 'proposed') head.kind = 'proposed';
          delete doc.routes[tail.id];
          if (keepId === tail.id) keepId = head.id;

          const firstStop = doc.stops[endStop(head, true)];
          const lastStop = doc.stops[endStop(head, false)];
          head.name = `Route ${num} (${firstStop ? firstStop.name : ''} ➔ ${lastStop ? lastStop.name : ''})`;
          merged = true;
          break;
        }
      }
      return keepId;
    }

    _finishConnectingStops() {
      this._pillBusChoice = null;
      if (this.activeConnectRouteId) {
        const r = this.store.doc.routes[this.activeConnectRouteId];
        if (r && r.anchors.length >= 2) {
          this.lastActiveRouteId = r.id;
          this.renderer.selected = { type: 'route', id: r.id };
          this._showInspector(this.renderer.selected);
        }
      }
      this.store.save();
      this._saveCurrentProjectDraft(false);

      this.activeConnectStopId = null;
      this.activeConnectRouteId = null;
      this.connectBusNumber = null;
      this.renderer.connectBusNumber = null;
      this.renderer.activeConnectStopId = null;
      this.renderer.connectingPreview = null;
      this._lastConnMode = null;
      this._lastConnTargetId = null;
      this.setTool('select');
      this._updateConnectingBar();
      this.renderer.requestRender();
    }

    _cancelConnectingStops(showToast = true) {
      this._pillBusChoice = null;
      if (!this.activeConnectStopId) return;
      this.activeConnectStopId = null;
      this.activeConnectRouteId = null;
      this.connectBusNumber = null;
      this.renderer.connectBusNumber = null;
      this.renderer.activeConnectStopId = null;
      this.renderer.connectingPreview = null;
      this._lastConnMode = null;
      this._lastConnTargetId = null;
      this.setTool('select');
      this._updateConnectingBar();
      this.renderer.requestRender();
    }

    _updateConnectingModeUI(mode, targetStop = null) {
      const toolSelectBtn = document.getElementById('tool-select');
      const statusEl = document.getElementById('conn-status-text');
      const fromStop = this.activeConnectStopId ? this.store.doc.stops[this.activeConnectStopId] : null;
      const fromName = fromStop ? fromStop.name : (this.activeConnectStopId || '');

      if (mode === 'move') {
        if (toolSelectBtn && !toolSelectBtn.classList.contains('active')) {
          this._syncToolbar('select');
        }
        if (statusEl && this._lastConnMode !== 'move') {
          statusEl.innerHTML = `✋ <strong>Move Mode</strong> (from: <strong>${fromName}</strong>) ➔ Click blank space or press <strong>Enter</strong> to confirm route, or drag to pan`;
          this._lastConnMode = 'move';
          this._lastConnTargetId = null;
        }
      } else {
        if (toolSelectBtn && toolSelectBtn.classList.contains('active')) {
          toolSelectBtn.classList.remove('active');
        }
        if (statusEl && (this._lastConnMode !== 'link' || this._lastConnTargetId !== targetStop?.id)) {
          const targetName = targetStop ? targetStop.name : 'bus stop';
          statusEl.innerHTML = `🔗 <strong>Link Bus Stop Route Mode</strong> ➔ Click <strong>${targetName}</strong> to link, or click blank space to confirm route`;
          this._lastConnMode = 'link';
          this._lastConnTargetId = targetStop?.id;
        }
      }
    }

    _updateConnectingBar() {
      const bar = document.getElementById('route-connecting-bar');
      if (bar) bar.classList.add('hidden');
    }

    _initConnectingBarEvents() {
      const btnFinish = document.getElementById('btn-conn-finish');
      if (btnFinish) {
        btnFinish.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const targetStopId = (this.renderer.connectingPreview && this.renderer.connectingPreview.toStop && this.renderer.connectingPreview.toStop.id) ||
            (this.renderer.snapTarget && this.renderer.snapTarget.id) || null;
          if (this.activeConnectStopId && targetStopId && targetStopId !== this.activeConnectStopId) {
            this._connectStops(this.activeConnectStopId, targetStopId);
            return;
          }
          this._finishConnectingStops();
        });
      }

      const btnNewLine = document.getElementById('btn-conn-new-line');
      if (btnNewLine) {
        btnNewLine.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this._startNewBusLine();
        });
      }

      const btnCancel = document.getElementById('btn-conn-cancel');
      if (btnCancel) {
        btnCancel.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this._cancelConnectingStops(false);
        });
      }
    }

    _hitTest(world) {
      const zoom = this.renderer.camera.zoom;
      const tol = 12 / zoom;

      const running = this._runningBusNumbers();
      const visibleRoutes = Object.values(this.store.doc.routes).filter((r) => {
        if (this.renderer.visibleRouteIds && !this.renderer.visibleRouteIds.has(r.id)) return false;
        if (this.renderer.hiddenChunkIds && this.renderer.hiddenChunkIds.has(r.id)) return false;
        if (running && !running.has(String(r.number).trim())) return false;
        return true;
      });

      // 0a. Highest Priority: "!" constraint markers in the middle of the constrained road segment
      const markerTol = Math.max(16 / zoom, tol + 6);
      const isDirectRoute = Boolean(
        this.renderer.selected && (this.renderer.selected.type === 'route' || this.renderer.selected.type === 'route-leg')
      );
      const selRouteId = isDirectRoute ? (this.renderer.selected.routeId || this.renderer.selected.id) : null;
      const selRouteObj = selRouteId ? this.store.doc.routes[selRouteId] : null;
      const selBusNum = selRouteObj ? String(selRouteObj.number).trim() : null;

      for (const r of visibleRoutes) {
        let isRouteSelected = false;
        if (isDirectRoute) {
          isRouteSelected = (r.id === selRouteId) || (selBusNum && String(r.number).trim() === selBusNum);
        } else if (!this.isAllRoutesSelected && this.selectedRouteIds && this.selectedRouteIds.size > 0 && this.selectedRouteIds.size <= 2) {
          isRouteSelected = this.selectedRouteIds.has(r.id);
        } else if (this.renderer.focusedChunkId === r.id || this.renderer.hoveredChunkId === r.id || this.renderer.routePreviewId === r.id) {
          isRouteSelected = true;
        }
        if (!isRouteSelected) continue;
        const g = this.store.geom[r.id];
        const c = g && g.constraint;
        if (!c || c.legIndex < 0 || !g.legs || !g.legs[c.legIndex]) continue;
        const mPt = c.renderPt || c.pt;
        if (mPt && Math.hypot(world.x - mPt.x, world.y - mPt.y) <= markerTol) {
          const legIdx = c.legIndex;
          const leg = g.legs[legIdx];
          const fromAnchor = r.anchors[legIdx];
          const toAnchor = r.anchors[legIdx + 1];
          const fromStop = fromAnchor && fromAnchor.t === 'stop' ? this.store.doc.stops[fromAnchor.id] : null;
          const toStop = toAnchor && toAnchor.t === 'stop' ? this.store.doc.stops[toAnchor.id] : null;
          const clickedEdge = this.net.edge(c.edgeId);
          return {
            type: 'route-leg',
            id: r.id,
            routeId: r.id,
            legIndex: legIdx,
            fromAnchor,
            toAnchor,
            fromStop,
            toStop,
            leg,
            obj: r,
            clickedEdge,
            roadName: c.roadName || (clickedEdge ? clickedEdge.name : 'Main Road'),
            isRedLine: false,
            isConstraintHit: true,
            constraint: c,
            clickWorld: { x: world.x, y: world.y },
          };
        }
      }

      // 0. MRT stations
      const mrt = this._hitTestMrt(world);
      if (mrt) return { type: 'mrt', id: mrt.id, obj: mrt };

      // 0b. Bus Interchanges (major hubs have priority hit testing when layer is active)
      if (this.renderer.layers.busInterchanges !== false) {
        for (const st of Object.values((this.store && this.store.doc && this.store.doc.stops) || {})) {
          if (!B.isInterchange(st)) continue;
          const pt = this.renderer.stopPoint(st);
          const intTol = Math.max(tol + 14, 25 / zoom);
          if (Math.hypot(world.x - pt.x, world.y - pt.y) <= intTol) {
            return { type: 'stop', id: st.id, obj: st };
          }
        }
      }

      // 1. Bus Stops
      const stopsVisible = (this.renderer.layers.stopPoints !== false || this.renderer.layers.stopNames !== false || this.renderer.layers.stops !== false);
      if (stopsVisible) {
        for (const st of this.renderer.visibleStops()) {
          const pt = this.renderer.stopPoint(st);
          if (Math.hypot(world.x - pt.x, world.y - pt.y) <= tol + 6) {
            return { type: 'stop', id: st.id, obj: st };
          }
          if (this.renderer.layers.stopNames !== false) {
            const h = 18 / zoom;
            const yOffset = 24 / zoom;
            const labelHalfW = ((st.name || '').length * 4.5 + 30) / zoom;
            if (world.y >= pt.y - yOffset - 3 / zoom && world.y <= pt.y - yOffset + h + 3 / zoom && Math.abs(world.x - pt.x) <= labelHalfW) {
              return { type: 'stop', id: st.id, obj: st };
            }
          }
        }
      }

      // 2. Affected Areas
      for (const a of Object.values(this.store.doc.areas)) {
        const poly = this.store.areaPoly(a);
        if (B.pointInPoly(world, poly)) {
          return { type: 'area', id: a.id, obj: a };
        }
      }

      // 3. Bus Routes & Segment Legs between Bus Stops

      for (const r of visibleRoutes) {
        const g = this.store.geom[r.id];
        if (!g || !g.legs) continue;
        for (let legIdx = 0; legIdx < g.legs.length; legIdx++) {
          const leg = g.legs[legIdx];
          if (!leg.ok || !leg.pts) continue;
          // A box round each leg (kept with it) rules most of them out before measuring
          if (!leg.bb) leg.bb = B.bbox(leg.pts, 0);
          const pad = tol + 30;
          if (world.x < leg.bb.x0 - pad || world.x > leg.bb.x1 + pad || world.y < leg.bb.y0 - pad || world.y > leg.bb.y1 + pad) continue;
          if (B.distPolyline(world, leg.pts) <= tol + 5) {
            const fromAnchor = r.anchors[legIdx];
            const toAnchor = r.anchors[legIdx + 1];
            const fromStop = fromAnchor && fromAnchor.t === 'stop' ? this.store.doc.stops[fromAnchor.id] : null;
            const toStop = toAnchor && toAnchor.t === 'stop' ? this.store.doc.stops[toAnchor.id] : null;
            const isConstraintLeg = Boolean(g.constraint && g.constraint.legIndex === legIdx);

            let clickedEdge = isConstraintLeg ? this.net.edge(g.constraint.edgeId) : null;
            let minEdgeD = Infinity;
            if (!clickedEdge && leg.segs && leg.segs.length) {
              for (const seg of leg.segs) {
                const e = this.net.edge(seg.edge);
                if (e && e.pts) {
                  const d = B.distPolyline(world, e.pts);
                  if (d < minEdgeD) {
                    minEdgeD = d;
                    clickedEdge = e;
                  }
                }
              }
            }
            if (!clickedEdge) {
              const near = this.net.nearest(world, 35);
              if (near) clickedEdge = this.net.edge(near.edge);
            }
            const roadName = isConstraintLeg
              ? (g.constraint.roadName || (clickedEdge ? clickedEdge.name : 'Main Road'))
              : (clickedEdge ? (clickedEdge.name || ('Road #' + clickedEdge.id)) : 'Main Road');
            const isRedLine = clickedEdge ? (this.store.closedSet.has(clickedEdge.id) || !!(this.store.doc.closures && this.store.doc.closures[clickedEdge.id])) : false;

            return {
              type: 'route-leg',
              id: r.id,
              routeId: r.id,
              legIndex: legIdx,
              fromAnchor,
              toAnchor,
              fromStop,
              toStop,
              leg,
              obj: r,
              clickedEdge,
              roadName,
              isRedLine,
              isConstraintHit: isConstraintLeg,
              constraint: isConstraintLeg ? g.constraint : null,
              clickWorld: { x: world.x, y: world.y },
            };
          }
        }
      }

      // 4. Road Segments
      const near = this.net.nearest(world, 25);
      if (near && near.d <= near.hw + 6) {
        return { type: 'closure', id: near.edge, obj: this.net.edge(near.edge) };
      }

      // 5. Spatial Selected Area Boundary
      if (this.areaFilterPolygon && this.areaFilterPolygon.length >= 3 && !this.areaFilterOutlineHidden) {
        if (B.pointInPoly(world, this.areaFilterPolygon)) {
          return { type: 'area-filter' };
        }
      }

      return null;
    }

    _hitTestAreaHandle(area, world) {
      const tol = 10 / this.renderer.camera.zoom;
      if (area.shape === 'circle') {
        if (Math.hypot(world.x - area.cx, world.y - area.cy) <= tol) return { type: 'center' };
        if (Math.hypot(world.x - (area.cx + area.r), world.y - area.cy) <= tol) return { type: 'radius' };
      } else {
        const c = B.centroid(area.pts);
        if (Math.hypot(world.x - c.x, world.y - c.y) <= tol) {
          return { type: 'center', cx: c.x, cy: c.y, origPts: JSON.parse(JSON.stringify(area.pts)) };
        }
        for (let i = 0; i < area.pts.length; i++) {
          if (Math.hypot(world.x - area.pts[i].x, world.y - area.pts[i].y) <= tol) {
            return { type: 'vertex', index: i };
          }
        }
      }
      return null;
    }


    _deleteSelected() {
      const sel = this.renderer.selected;
      if (!sel) return;

      if (sel.type === 'stop') {
        this._promptDeleteStop(sel.id);
        return;
      } else if (sel.type === 'mrt') {
        return;
      } else if (sel.type === 'area') {
        // Roads the area closed open again with it
        let reopened = 0;
        this.store.commit(`Delete affected area ${sel.id}`, (doc) => {
          reopened = B.ops.deleteArea(doc, sel.id);
        });
        this._showToast(reopened ? `Deleted area ${sel.id} · ${reopened} road${reopened === 1 ? '' : 's'} reopened` : `Deleted area ${sel.id}`, 'info');
      } else if (sel.type === 'route') {
        this.promptDeleteRoute(sel.id);
        return;
      } else if (sel.type === 'route-leg') {
        this.deleteRouteLeg(sel.routeId, sel.legIndex);
        return;
      }

      this.renderer.selected = null;
      this._hideInspector();
      this._hideFloatingLegActions();
      this._hideFloatingStopActions();
    }

    _deleteStop(stopId) {
      const stop = this.store.doc.stops[stopId];
      if (!stop) return;
      let removedBuses = [];
      this.store.commit(`Delete bus stop ${stopId}`, (doc) => {
        removedBuses = B.ops.deleteStop(doc, stopId).removed;
      });
      if (this.renderer.selected && this.renderer.selected.id === stopId) {
        this.renderer.selected = null;
        this._hideInspector();
      }
      this._hideFloatingStopActions();
      const removedText = [...new Set(removedBuses)].map((n) => `Bus ${B.esc(n)}`).join(', ');
      this._showToast(removedText
        ? `Deleted ${B.esc(stop.name)} and empty ${removedText}`
        : `Deleted ${B.esc(stop.name)}`, 'info');
      this.renderer.requestRender();
    }

    // ------------------------------------------------------------- Edit / Delete Bus Stop Pop-ups
    _initStopModals() {
      const editModal = document.getElementById('edit-stop-modal');
      const delModal = document.getElementById('delete-stop-modal');
      if (!editModal || !delModal) return;
      const closeEdit = () => this._closeStopModal(editModal);
      const closeDel = () => this._closeStopModal(delModal);

      ['btn-close-edit-stop-x', 'btn-edit-stop-cancel'].forEach((id) => document.getElementById(id).addEventListener('click', closeEdit));
      ['btn-close-delete-stop-x', 'btn-delete-stop-cancel'].forEach((id) => document.getElementById(id).addEventListener('click', closeDel));
      editModal.addEventListener('click', (e) => { if (e.target === editModal) closeEdit(); });
      delModal.addEventListener('click', (e) => { if (e.target === delModal) closeDel(); });

      document.getElementById('btn-edit-stop-save').addEventListener('click', () => this._saveStopEdit());
      const stopActive = document.getElementById('edit-stop-active');
      stopActive.addEventListener('click', () => this._setStopActive(!stopActive.classList.contains('on')));
      // Type chips toggle; a stop takes at least one type
      editModal.querySelectorAll('#edit-stop-types .day-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          if (chip.classList.contains('on') && editModal.querySelectorAll('#edit-stop-types .day-chip.on').length === 1) return;
          chip.classList.toggle('on');
          chip.setAttribute('aria-pressed', String(chip.classList.contains('on')));
          this._showStopEditError('');
        });
      });
      document.getElementById('btn-edit-stop-delete').addEventListener('click', () => {
        const id = this.editingStopId;
        closeEdit();
        if (id) this._promptDeleteStop(id);
      });

      // Delete unlocks once the stop's name is typed exactly
      const confirmInput = document.getElementById('delete-stop-confirm');
      const btnConfirm = document.getElementById('btn-delete-stop-confirm');
      confirmInput.addEventListener('input', () => { btnConfirm.disabled = !this._deleteStopNameMatches(); });
      btnConfirm.addEventListener('click', () => this._confirmDeleteStop());

      // Enter saves or deletes, Esc closes, even while typing in a field
      editModal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); closeEdit(); }
        else if (e.key === 'Enter' && e.target && e.target.id === 'edit-stop-name') { e.preventDefault(); this._saveStopEdit(); }
      });
      delModal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); closeDel(); }
        else if (e.key === 'Enter' && e.target && e.target.id === 'delete-stop-confirm') { e.preventDefault(); this._confirmDeleteStop(); }
      });
    }

    _promptEditStop(stopId) {
      if (!this._ensureEditableForRoute()) return;
      const stop = this.store.doc.stops[stopId];
      const modal = document.getElementById('edit-stop-modal');
      if (!stop || !modal || this._isReadOnlyView()) return;
      this.editingStopId = stopId;
      const input = document.getElementById('edit-stop-name');
      input.value = stop.name || '';
      this._setStopActive(stop.active !== false);
      const types = this._stopTypes(stopId);
      document.querySelectorAll('#edit-stop-types .day-chip').forEach((chip) => {
        const on = types.includes(chip.dataset.type);
        chip.classList.toggle('on', on);
        chip.setAttribute('aria-pressed', String(on));
      });
      this._renderEditStopConstraints(stopId);
      this._showStopEditError('');
      modal.classList.remove('hidden');
      setTimeout(() => { input.focus(); input.select(); }, 30);
    }

    _renderEditStopConstraints(stopId) {
      const box = document.getElementById('edit-stop-constraints-section');
      if (!box) return;
      const stop = this.store.doc.stops[stopId];
      if (!stop) { box.hidden = true; return; }
      const consts = this.store.legConstraints(null, stop.edge);
      const servedIds = this.store.stopLines[stopId] || [];
      const firstRoute = servedIds.length ? this.store.doc.routes[servedIds[0]] : null;
      box.hidden = false;
      box.innerHTML = `
        <div class="modal-stop-sv-row">
          <span class="modal-stop-sv-label">Street View</span>
          ${this._streetViewLinkHtml(stop, { label: 'Google Street View' })}
        </div>
        ${consts.length ? `
          <div class="modal-constraints-head">
            <span>Constraints</span>
          </div>
          <div class="modal-constraints-list">
            ${consts.map((c) => this._renderConstraintItemHtml(c, firstRoute, { compact: true, hideRoad: true })).join('')}
          </div>
        ` : ''}
      `;
      if (firstRoute && consts.length) {
        this._bindConstraintEvents(box, firstRoute, () => this._renderEditStopConstraints(stopId));
      }
    }

    _saveStopEdit() {
      const stop = this.store.doc.stops[this.editingStopId];
      if (!stop) return this._closeStopModal(document.getElementById('edit-stop-modal'));
      const name = document.getElementById('edit-stop-name').value.trim();
      if (!name) {
        this._showStopEditError('Enter a name');
        return;
      }
      const id = this.editingStopId;
      const types = [...document.querySelectorAll('#edit-stop-types .day-chip.on')].map((chip) => chip.dataset.type);
      // A bus already stopping here keeps its type
      for (const rid of this.store.stopLines[id] || []) {
        const r = this.store.doc.routes[rid];
        const model = r && B.busModel(this.store.doc, r.number);
        if (model && !types.includes(model)) {
          this._showStopEditError(`Bus ${r.number} here is ${model}`);
          return;
        }
      }
      const active = document.getElementById('edit-stop-active').classList.contains('on');
      this._closeStopModal(document.getElementById('edit-stop-modal'));
      const typesChanged = types.join() !== this._stopTypes(id).join();
      const activeChanged = active !== (stop.active !== false);
      if (name === stop.name && !typesChanged && !activeChanged) return;
      this.store.commit(name === stop.name && !typesChanged ? `Stop ${active ? 'active' : 'not active'}` : 'Edit stop', (doc) => {
        const st = doc.stops[id];
        if (!st) return;
        st.name = name;
        if (typesChanged) st.busTypes = types;
        if (active) delete st.active;
        else st.active = false;
      });
      this.renderer.requestRender();
    }

    _setStopActive(on) {
      const btn = document.getElementById('edit-stop-active');
      if (!btn) return;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-checked', String(on));
      btn.querySelector('.bus-active-label').textContent = on ? 'Active' : 'Not active';
    }

    _showStopEditError(msg) {
      const el = document.getElementById('edit-stop-error');
      if (!el) return;
      el.textContent = msg;
      el.hidden = !msg;
    }

    _promptDeleteStop(stopId) {
      const stop = this.store.doc.stops[stopId];
      const modal = document.getElementById('delete-stop-modal');
      if (!stop || !modal) return;
      if (this._isCreatingRoute()) {
        this._showToast('Finish the route before deleting stops', 'warn');
        return;
      }
      this.deletingStopId = stopId;
      document.getElementById('delete-stop-name').textContent = stop.name;
      const input = document.getElementById('delete-stop-confirm');
      input.value = '';
      input.placeholder = stop.name;
      document.getElementById('btn-delete-stop-confirm').disabled = true;
      modal.classList.remove('hidden');
      setTimeout(() => input.focus(), 30);
    }

    _deleteStopNameMatches() {
      const stop = this.store.doc.stops[this.deletingStopId];
      const typed = document.getElementById('delete-stop-confirm').value.trim();
      return !!stop && typed === String(stop.name).trim();
    }

    _confirmDeleteStop() {
      if (!this._deleteStopNameMatches()) return;
      const id = this.deletingStopId;
      this._closeStopModal(document.getElementById('delete-stop-modal'));
      this._deleteStop(id);
    }

    _closeStopModal(modal) {
      if (modal) modal.classList.add('hidden');
      if (modal && modal.id === 'edit-stop-modal') this.editingStopId = null;
      if (modal && modal.id === 'delete-stop-modal') this.deletingStopId = null;
    }

    // ------------------------------------------------------------- Delete Bus Number Confirmation Pop-up
    _initConfirmDeleteModal() {
      const modal = document.getElementById('confirm-delete-modal');
      const btnCloseX = document.getElementById('btn-close-modal-x');
      const btnCancel = document.getElementById('btn-modal-cancel');
      const btnConfirm = document.getElementById('btn-modal-confirm-delete');

      if (btnCloseX) {
        btnCloseX.addEventListener('click', () => this._closeConfirmDeleteModal());
      }
      if (btnCancel) {
        btnCancel.addEventListener('click', () => this._closeConfirmDeleteModal());
      }
      if (modal) {
        modal.addEventListener('click', (e) => {
          if (e.target === modal) {
            this._closeConfirmDeleteModal();
          }
        });
      }
      if (btnConfirm) {
        btnConfirm.addEventListener('click', () => this._confirmDeleteRoute());
      }
    }

    promptDeleteRoute(routeId) {
      const r = this.store.doc.routes[routeId];
      if (!r) return;

      this.pendingDeleteRouteId = routeId;

      const modal = document.getElementById('confirm-delete-modal');
      if (!modal) return;

      const title = document.getElementById('confirm-delete-title');
      const msg = document.getElementById('confirm-delete-msg');
      const preview = document.getElementById('modal-route-preview');
      const btnCancel = document.getElementById('btn-modal-cancel');

      if (title) title.textContent = `Delete Bus ${r.number}`;
      if (msg) msg.textContent = `Are you sure you want to delete Bus ${r.number}? This will remove its route path from the map.`;

      const g = this.store.geom ? this.store.geom[r.id] : null;
      const stopCount = r.anchors ? r.anchors.length : 0;
      const distStr = g && g.length ? B.fmtKm(g.length) : null;
      const timeStr = g && g.time ? B.fmtMin(g.time) : null;
      const isProposed = (r.kind === 'proposed');

      if (preview) {
        preview.innerHTML = `
          <div class="modal-route-header">
            <span class="modal-route-badge" style="background: ${r.color || '#2563eb'};">
              ${B.esc(r.number)}
            </span>
            <span class="modal-route-status ${isProposed ? 'proposed' : 'existing'}">${isProposed ? 'Proposed' : 'Existing'}</span>
          </div>
          <div class="modal-route-desc">${B.esc(r.name || `Bus ${r.number}`)}</div>
          <div class="modal-route-metrics">
            <span class="modal-route-metric-item"><strong>${stopCount}</strong> Stops</span>
            ${distStr ? `<span class="modal-route-metric-item">Distance: <strong>${distStr}</strong></span>` : ''}
            ${timeStr ? `<span class="modal-route-metric-item">Est. Time: <strong>${timeStr}</strong></span>` : ''}
          </div>
        `;
      }

      modal.classList.remove('hidden');
      if (btnCancel && typeof btnCancel.focus === 'function') {
        setTimeout(() => btnCancel.focus(), 50);
      }
    }

    _confirmDeleteRoute() {
      const routeId = this.pendingDeleteRouteId;
      if (!routeId) return;

      const r = this.store.doc.routes[routeId];
      const num = r ? r.number : routeId;

      this.store.commit(`Delete Bus ${num}`, (doc) => {
        delete doc.routes[routeId];
      });
      this.store.save();

      this.renderer.selected = null;
      this._hideInspector();
      this._hideFloatingLegActions();
      this._hideFloatingStopActions();
      this.renderer.requestRender();

      this._showToast(`Deleted Bus ${num}`, 'info');
      this._closeConfirmDeleteModal();
    }

    _closeConfirmDeleteModal() {
      const modal = document.getElementById('confirm-delete-modal');
      if (modal) {
        modal.classList.add('hidden');
      }
      this.pendingDeleteRouteId = null;
    }

    // ------------------------------------------------------------- Link Line & Bus Number Modal
    _initLinkLineModalEvents() {
      const modal = document.getElementById('link-line-modal');
      const btnCloseX = document.getElementById('btn-close-link-line-modal');
      const btnCancel = document.getElementById('btn-link-line-cancel');
      const btnConfirm = document.getElementById('btn-link-line-confirm');
      const inputNum = document.getElementById('link-line-bus-number');
      const badgePreview = document.getElementById('modal-bus-badge-preview');

      if (btnCloseX) {
        btnCloseX.addEventListener('click', () => this._closeLinkLineModal());
      }
      if (btnCancel) {
        btnCancel.addEventListener('click', () => this._closeLinkLineModal());
      }
      if (modal) {
        modal.addEventListener('click', (e) => {
          if (e.target === modal) {
            this._closeLinkLineModal();
          }
        });
      }
      if (btnConfirm) {
        btnConfirm.addEventListener('click', () => this._confirmLinkLine());
      }

      if (inputNum) {
        inputNum.addEventListener('input', () => {
          const val = inputNum.value.trim();
          if (badgePreview) {
            badgePreview.textContent = val ? `Bus ${val}` : 'Bus —';
            const existingRoute = Object.values(this.store.doc.routes).find((r) => String(r.number).trim() === val);
            if (existingRoute && existingRoute.color) {
              badgePreview.style.background = existingRoute.color;
            } else {
              badgePreview.style.background = '#2563eb';
            }
          }
        });
        inputNum.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            this._confirmLinkLine();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            this._closeLinkLineModal();
          }
        });
      }
    }

    _promptLinkLine(fromStopId, toStopId) {
      const fromStop = this.store.doc.stops[fromStopId];
      const toStop = this.store.doc.stops[toStopId];
      if (!fromStop || !toStop) return;

      const modal = document.getElementById('link-line-modal');
      if (!modal) {
        this._connectStopsWithNumber(fromStopId, toStopId, '35');
        return;
      }

      const fromNameEl = document.getElementById('link-line-from-name');
      const fromCodeEl = document.getElementById('link-line-from-code');
      const toNameEl = document.getElementById('link-line-to-name');
      const toCodeEl = document.getElementById('link-line-to-code');
      const inputNum = document.getElementById('link-line-bus-number');
      const badgePreview = document.getElementById('modal-bus-badge-preview');

      const fromServed = (this.store.stopLines && this.store.stopLines[fromStopId] || [])
        .map((rid) => this.store.doc.routes[rid]?.number).filter(Boolean);
      const toServed = (this.store.stopLines && this.store.stopLines[toStopId] || [])
        .map((rid) => this.store.doc.routes[rid]?.number).filter(Boolean);

      const fromBusesStr = fromServed.length ? ` • Buses: ${fromServed.join(', ')}` : '';
      const toBusesStr = toServed.length ? ` • Buses: ${toServed.join(', ')}` : '';

      if (fromNameEl) fromNameEl.textContent = fromStop.name || 'Bus Stop';
      if (fromCodeEl) fromCodeEl.textContent = (fromStop.code ? `[${fromStop.code}]` : `[${fromStop.id}]`) + fromBusesStr;
      if (toNameEl) toNameEl.textContent = toStop.name || 'Bus Stop';
      if (toCodeEl) toCodeEl.textContent = (toStop.code ? `[${toStop.code}]` : `[${toStop.id}]`) + toBusesStr;

      // Smart default number: only use active route if user was already in a chain
      let defaultNum = '';
      if (this.activeConnectRouteId && this.store.doc.routes[this.activeConnectRouteId]) {
        defaultNum = this.store.doc.routes[this.activeConnectRouteId].number;
      } else {
        // Pick a clean, unused bus number so the new line doesn't hijack or combine with existing lines
        const existingNums = new Set(Object.values(this.store.doc.routes).map((r) => String(r.number).trim()));
        let candidate = 35;
        while (existingNums.has(String(candidate))) {
          candidate += 10;
        }
        defaultNum = String(candidate);
      }

      this.pendingLinkLine = {
        fromStopId,
        toStopId,
        defaultNum: defaultNum || '35',
      };

      if (inputNum) {
        inputNum.value = defaultNum || '35';
      }

      if (badgePreview) {
        badgePreview.textContent = defaultNum ? `Bus ${defaultNum}` : 'Bus 35';
        const existingRoute = Object.values(this.store.doc.routes).find((r) => String(r.number).trim() === String(defaultNum).trim());
        if (existingRoute && existingRoute.color) {
          badgePreview.style.background = existingRoute.color;
        } else {
          badgePreview.style.background = '#2563eb';
        }
      }

      modal.classList.remove('hidden');

      if (inputNum) {
        setTimeout(() => {
          inputNum.focus();
          inputNum.select();
        }, 50);
      }
    }

    _confirmLinkLine() {
      if (!this.pendingLinkLine) return;
      const { fromStopId, toStopId, defaultNum } = this.pendingLinkLine;
      const inputNum = document.getElementById('link-line-bus-number');
      const typedVal = inputNum ? inputNum.value.trim() : '';
      const finalBusNum = typedVal || defaultNum || '35';

      this._closeLinkLineModal();
      this._connectStopsWithNumber(fromStopId, toStopId, finalBusNum);
    }

    _closeLinkLineModal() {
      const modal = document.getElementById('link-line-modal');
      if (modal) {
        modal.classList.add('hidden');
      }
      this.pendingLinkLine = null;
      this.renderer.connectingPreview = null;
      this.renderer.requestRender();
    }

    deleteRouteLeg(routeId, legIndex) {
      this._ensureEditableForRoute();
      const r = this.store.doc.routes[routeId];
      if (!r || !r.anchors || legIndex < 0 || legIndex >= r.anchors.length - 1) return;

      const fromAnchor = r.anchors[legIndex];
      const toAnchor = r.anchors[legIndex + 1];
      const fromStop = fromAnchor.t === 'stop' ? this.store.doc.stops[fromAnchor.id] : null;
      const toStop = toAnchor.t === 'stop' ? this.store.doc.stops[toAnchor.id] : null;
      const fromName = fromStop ? fromStop.name : 'Stop ' + (legIndex + 1);
      const toName = toStop ? toStop.name : 'Stop ' + (legIndex + 2);

      let gapInBus = null;
      let newRouteId = null;
      this.store.commit(`Delete line between ${fromName} and ${toName}`, (doc) => {
        const route = doc.routes[routeId];
        if (!route) return;

        // Clean any pre-cut detour properties so anchors are never overwritten
        delete route.originalAnchors;
        delete route.detourApplied;
        delete route.viaName;
        delete route.detourTitle;
        delete route.activeOptionIdx;
        delete route.fromAiSuggest;
        delete route.constraintBypassOnly;

        if (route.anchors.length <= 2) {
          // Only two stops: deleting the connection deletes the route line entirely!
          // Both stops remain on the map!
          delete doc.routes[routeId];
          if (this.selectedRouteIds) this.selectedRouteIds.delete(routeId);
          if (this._qfSaved) this._qfSaved.delete(routeId);
        } else if (legIndex === route.anchors.length - 2) {
          // Last segment: remove the last anchor
          route.anchors.pop();
          const firstStop = doc.stops[route.anchors[0]?.id];
          const lastStop = doc.stops[route.anchors[route.anchors.length - 1]?.id];
          route.name = `Route ${route.number} (${firstStop ? firstStop.name : ''} ➔ ${lastStop ? lastStop.name : ''})`;
        } else if (legIndex === 0) {
          // First segment: remove the first anchor
          route.anchors.shift();
          const firstStop = doc.stops[route.anchors[0]?.id];
          const lastStop = doc.stops[route.anchors[route.anchors.length - 1]?.id];
          route.name = `Bus ${route.number} (${firstStop ? firstStop.name : ''} ➔ ${lastStop ? lastStop.name : ''})`;
        } else {
          // Middle segment: split into fragmented chunks without forcing terminal jointing
          const origConstraint = (this.store.geom[route.id] && this.store.geom[route.id].constraint) ||
            (typeof this.store.routeConstraint === 'function' ? this.store.routeConstraint(route) : null);
          if (origConstraint) {
            doc.canonicalConstraints = doc.canonicalConstraints || {};
            const numKey = String(route.number).trim();
            doc.canonicalConstraints[numKey] = { ...origConstraint };
            route.baseConstraint = { ...origConstraint };
          }

          let firstPart = route.anchors.slice(0, legIndex + 1);
          let secondPart = route.anchors.slice(legIndex + 1);

          // Leave fragmented without jointing to bus terminals so user can draw line themselves
          route.anchors = firstPart;
          route.isChunk = true;
          route.chunkIndex = 1;
          const firstStop = doc.stops[route.anchors[0]?.id];
          const lastStop = doc.stops[route.anchors[route.anchors.length - 1]?.id];
          route.originTerminalId = firstStop ? firstStop.id : null;
          route.destTerminalId = lastStop ? lastStop.id : null;
          route.name = `Bus ${route.number} · Chunk 1 (${firstStop ? firstStop.name : ''} ➔ ${lastStop ? lastStop.name : ''})`;
          route.fleet = Math.max(1, Math.round((route.fleet || 10) / 2));

          if (secondPart.length >= 2) {
            newRouteId = this.store.newId('R');
            const sFirst = doc.stops[secondPart[0]?.id];
            const sLast = doc.stops[secondPart[secondPart.length - 1]?.id];
            doc.routes[newRouteId] = {
              id: newRouteId,
              number: route.number,
              name: `Bus ${route.number} · Chunk 2 (${sFirst ? sFirst.name : ''} ➔ ${sLast ? sLast.name : ''})`,
              kind: route.kind || 'existing',
              color: route.color,
              baseId: route.baseId || null,
              override: false,
              active: route.active !== false,
              isChunk: true,
              chunkIndex: 2,
              baseConstraint: origConstraint ? { ...origConstraint } : null,
              originTerminalId: sFirst ? sFirst.id : null,
              destTerminalId: sLast ? sLast.id : null,
              hours: route.hours ? { ...route.hours } : B.defaultBusHours(route.number),
              days: B.busDays(doc, route.number),
              fleet: Math.max(1, Math.round((route.fleet || 10) / 2)),
              anchors: secondPart,
            };
            gapInBus = route.number;
          }

          // Re-index all chunks for this bus number
          const siblings = Object.values(doc.routes).filter((x) => String(x.number).trim() === String(route.number).trim());
          if (siblings.length > 1) {
            siblings.forEach((s, idx) => {
              s.isChunk = true;
              s.chunkIndex = idx + 1;
            });
          }
        }
      });

      if (newRouteId) {
        if (this.isAllRoutesSelected || this.selectedRouteIds.has(routeId)) {
          this.selectedRouteIds.add(newRouteId);
        }
        if (this._qfSaved && this._qfSaved.has(routeId)) {
          this._qfSaved.add(newRouteId);
        }
      }
      this.isAllRoutesSelected = (this.selectedRouteIds.size === Object.keys(this.store.doc.routes).length);
      this._applyRouteMultiSelection();
      this._renderRoutePills();
      this._renderQuickFilters();
      if (this._updateRouteDropdown) this._updateRouteDropdown();
      this._saveCurrentProjectDraft(false);

      this.renderer.selected = null;
      this._hideInspector();
      this._hideFloatingLegActions();
      this._hideFloatingStopActions();
      this.renderer.requestRender();
      if (gapInBus) {
        this._showToast(`Segment removed · Bus ${B.esc(gapInBus)} fragmented (draw line to reconnect)`, 'info');
        const fromStopId = fromAnchor && fromAnchor.t === 'stop' ? fromAnchor.id : null;
        if (fromStopId) {
          if (this.mode === 'view') this.setMode('edit');
          setTimeout(() => {
            this._startConnectingFrom(fromStopId, routeId);
          }, 120);
        }
      } else {
        this._showToast('Line deleted', 'success');
      }
    }

    // Nearest bus interchange to a given stop (mustBeClear ensures it is outside affected area and closures)
    _nearestInterchange(stop, mustBeClear = true) {
      const ranked = this._rankedInterchangesNear(stop, mustBeClear);
      return ranked.length ? ranked[0].stop : null;
    }

    // Rank all bus interchanges by distance from a given stop
    _rankedInterchangesNear(stop, mustBeClear = true) {
      if (!this.store || !this.store.doc || !this.store.doc.stops) return [];
      const pt = stop ? this.renderer.stopPoint(stop) : { x: 0, y: 0 };
      const allStops = Object.values(this.store.doc.stops);
      const areas = Object.values(this.store.doc.areas || {});
      const isClear = (st) => {
        if (!st || st.active === false) return false;
        if (!mustBeClear) return true;
        if (this.store.closedSet && this.store.closedSet.has(st.edge)) return false;
        if (this.store.affected && this.store.affected.has(st.edge)) return false;
        const p = this.net.posPoint(st, 0.78);
        for (const a of areas) {
          const poly = this.store.areaPoly(a);
          if (poly && B.pointInPoly(p, poly)) return false;
        }
        return true;
      };
      const interchanges = allStops.filter((s) => B.isInterchange(s) && isClear(s));
      const pool = interchanges.length ? interchanges : allStops.filter((s) => B.isInterchange(s) && s.active !== false);
      return pool.map((it) => {
        const p2 = this.renderer.stopPoint(it);
        const dist = Math.hypot(p2.x - pt.x, p2.y - pt.y);
        return { stop: it, dist };
      }).sort((a, b) => a.dist - b.dist);
    }

    // Ensures both ends (origin and destination) of a route chunk are jointed with a bus terminal outside affected area
    _jointChunkWithTerminals(anchors) {
      if (!Array.isArray(anchors) || !anchors.length) return anchors;
      let result = anchors.map((a) => ({ ...a }));
      const areas = Object.values(this.store.doc.areas || {});
      const isClear = (st) => {
        if (!st || st.active === false) return false;
        if (this.store.closedSet && this.store.closedSet.has(st.edge)) return false;
        if (this.store.affected && this.store.affected.has(st.edge)) return false;
        const p = this.net.posPoint(st, 0.78);
        for (const a of areas) {
          const poly = this.store.areaPoly(a);
          if (poly && B.pointInPoly(p, poly)) return false;
        }
        return true;
      };

      // 1. Joint Origin with nearest bus terminal outside affected area
      const s0 = this.store.doc.stops[result[0]?.id];
      if (!s0 || !B.isInterchange(s0) || !isClear(s0)) {
        const near0 = this._nearestInterchange(s0, true);
        if (near0) {
          if (s0 && !isClear(s0)) {
            result[0] = { t: 'stop', id: near0.id };
          } else if (near0.id !== result[0]?.id) {
            result = [{ t: 'stop', id: near0.id }, ...result];
          }
        }
      }

      // 2. Joint Destination with nearest bus terminal outside affected area
      const sLast = this.store.doc.stops[result[result.length - 1]?.id];
      if (!sLast || !B.isInterchange(sLast) || !isClear(sLast)) {
        const nearLast = this._nearestInterchange(sLast, true);
        if (nearLast) {
          if (sLast && !isClear(sLast)) {
            result[result.length - 1] = { t: 'stop', id: nearLast.id };
          } else if (nearLast.id !== result[result.length - 1]?.id) {
            result = [...result, { t: 'stop', id: nearLast.id }];
          }
        }
      }

      // Deduplicate consecutive identical stops
      const deduped = [];
      for (let i = 0; i < result.length; i++) {
        if (i === 0 || result[i].id !== result[i - 1]?.id) {
          deduped.push(result[i]);
        }
      }
      return deduped;
    }

    // Cut a bus route into 2 separate operating chunks with the same bus number, avoiding the affected area
    _cutRouteIntoChunks(routeId, cutIdx = null, options = {}) {
      const isManual = !!(options && options.manualEdit);
      this._ensureEditableForRoute();
      const route = this.store.doc.routes[routeId];
      if (!route || !route.anchors || route.anchors.length < 3) {
        this._showToast('Route must have at least 3 stops to cut into chunks', 'warn');
        return;
      }

      const areas = Object.values(this.store.doc.areas || {});
      const isStopBlocked = (st) => {
        if (!st || st.active === false) return true;
        if (this.store.closedSet && this.store.closedSet.has(st.edge)) return true;
        if (this.store.affected && this.store.affected.has(st.edge)) return true;
        const p = this.net.posPoint(st, 0.78);
        for (const a of areas) {
          const poly = this.store.areaPoly(a);
          if (poly && B.pointInPoly(p, poly)) return true;
        }
        return false;
      };

      const g = this.store.geom[route.id];
      const blockedAnchorIndices = [];
      route.anchors.forEach((a, i) => {
        if (a.t === 'stop') {
          const st = this.store.doc.stops[a.id];
          if (isStopBlocked(st)) blockedAnchorIndices.push(i);
        } else if (this.store.closedSet.has(a.edge) || (this.store.affected && this.store.affected.has(a.edge))) {
          blockedAnchorIndices.push(i);
        }
      });

      let cutStart = -1;
      let cutEnd = -1;
      if (blockedAnchorIndices.length > 0) {
        cutStart = blockedAnchorIndices[0];
        cutEnd = blockedAnchorIndices[blockedAnchorIndices.length - 1];
      } else if (g && Array.isArray(g.legs)) {
        const disruptedLegs = [];
        g.legs.forEach((l, i) => {
          if (!l.ok || (l.segs && l.segs.some((s) => this.store.closedSet.has(s.edge) || (this.store.affected && this.store.affected.has(s.edge))))) {
            disruptedLegs.push(i);
          }
        });
        if (disruptedLegs.length > 0) {
          cutStart = disruptedLegs[0];
          cutEnd = disruptedLegs[disruptedLegs.length - 1] + 1;
        }
      }

      let chunk1Anchors, chunk2Anchors;
      if (cutStart >= 0) {
        chunk1Anchors = route.anchors.slice(0, cutStart).filter((a) => !isStopBlocked(this.store.doc.stops[a.id]));
        chunk2Anchors = route.anchors.slice(cutEnd + 1).filter((a) => !isStopBlocked(this.store.doc.stops[a.id]));
      } else {
        if (cutIdx == null) {
          cutIdx = Math.floor((route.anchors.length - 1) / 2);
        }
        cutIdx = Math.max(0, Math.min(route.anchors.length - 2, cutIdx));
        chunk1Anchors = route.anchors.slice(0, cutIdx + 1);
        chunk2Anchors = route.anchors.slice(cutIdx + 1);
      }

      if (!isManual) {
        // Origin and destination must joint with bus terminal only (outside affected area)
        chunk1Anchors = this._jointChunkWithTerminals(chunk1Anchors);
        chunk2Anchors = this._jointChunkWithTerminals(chunk2Anchors);

        // Pin both chunks so their paths keep off closed roads and affected areas
        if (this.store.pinRoute) {
          chunk1Anchors = this.store.pinRoute(chunk1Anchors);
          chunk2Anchors = this.store.pinRoute(chunk2Anchors);
        }
      }

      // Capture the original route's constraint before cutting into chunks
      const origConstraint = (this.store.geom[route.id] && this.store.geom[route.id].constraint) ||
        (typeof this.store.routeConstraint === 'function' ? this.store.routeConstraint(route) : null);

      let newRouteId = null;
      this.store.commit(`Cut Bus ${route.number} into 2 chunks`, (doc) => {
        const r1 = doc.routes[route.id];
        if (!r1) return;

        if (origConstraint) {
          doc.canonicalConstraints = doc.canonicalConstraints || {};
          const numKey = String(r1.number).trim();
          doc.canonicalConstraints[numKey] = { ...origConstraint };
          r1.baseConstraint = { ...origConstraint };
        }

        // Clean any pre-cut detour properties so anchors are never overwritten
        delete r1.originalAnchors;
        delete r1.detourApplied;
        delete r1.viaName;
        delete r1.detourTitle;
        delete r1.activeOptionIdx;
        delete r1.fromAiSuggest;
        delete r1.constraintBypassOnly;

        const s0 = doc.stops[chunk1Anchors[0]?.id];
        const s1 = doc.stops[chunk1Anchors[chunk1Anchors.length - 1]?.id];
        r1.anchors = chunk1Anchors;
        r1.name = `Bus ${r1.number} · Chunk 1 (${s0 ? s0.name : 'Start'} ➔ ${s1 ? s1.name : 'End'})`;
        // the buses are shared out between the two chunks
        const half = Math.max(1, Math.round((r1.fleet || 10) / 2));
        r1.fleet = half;
        r1.isChunk = true;
        r1.chunkIndex = 1;
        r1.severedEnd = 'end';
        r1.originTerminalId = s0 ? s0.id : null;
        r1.destTerminalId = s1 ? s1.id : null;

        newRouteId = this.store.newId('R');
        const s2 = doc.stops[chunk2Anchors[0]?.id];
        const s3 = doc.stops[chunk2Anchors[chunk2Anchors.length - 1]?.id];
        doc.routes[newRouteId] = {
          id: newRouteId,
          number: r1.number,

          name: `Bus ${r1.number} · Chunk 2 (${s2 ? s2.name : 'Start'} ➔ ${s3 ? s3.name : 'End'})`,
          kind: r1.kind || 'existing',
          color: r1.color,
          baseId: r1.baseId || null,
          override: false,
          active: r1.active !== false,
          isChunk: true,
          chunkIndex: 2,
          baseConstraint: origConstraint ? { ...origConstraint } : null,
          severedEnd: 'start',
          originTerminalId: s2 ? s2.id : null,
          destTerminalId: s3 ? s3.id : null,
          hours: r1.hours ? { ...r1.hours } : B.defaultBusHours(r1.number),
          days: B.busDays(doc, r1.number),
          fleet: half,
          anchors: chunk2Anchors,
        };

        // Re-index all chunks for this bus number
        const siblings = Object.values(doc.routes).filter((x) => String(x.number).trim() === String(r1.number).trim());
        if (siblings.length > 1) {
          siblings.forEach((s, idx) => {
            s.isChunk = true;
            s.chunkIndex = idx + 1;
          });
        }
      });

      if (newRouteId) {
        if (this.isAllRoutesSelected || this.selectedRouteIds.has(route.id)) {
          this.selectedRouteIds.add(newRouteId);
        }
        if (this._qfSaved && this._qfSaved.has(route.id)) {
          this._qfSaved.add(newRouteId);
        }
      }
      this.isAllRoutesSelected = (this.selectedRouteIds.size === Object.keys(this.store.doc.routes).length);
      this._applyRouteMultiSelection();
      this._renderRoutePills();
      this._renderQuickFilters();
      if (this._updateRouteDropdown) this._updateRouteDropdown();
      this._saveCurrentProjectDraft(false);

      const r1Obj = this.store.doc.routes[route.id];
      if (isManual) {
        this._showToast(`Bus ${route.number} fragmented at cut point · Draw line to reconnect`, 'info');
      } else {
        const startTerm = this.store.doc.stops[chunk1Anchors[0]?.id]?.name || 'Origin';
        const endTerm = this.store.doc.stops[chunk2Anchors[chunk2Anchors.length - 1]?.id]?.name || 'Destination';
        this._showToast(`Bus ${route.number} cut into 2 chunks · Terminals jointed (${startTerm} ➔ ${endTerm})`, 'success');
      }
      this.renderer.selected = { type: 'route', id: route.id, obj: r1Obj };
      this.renderer.focusedChunkId = route.id;
      this._focusOnRoute(r1Obj);
      this.renderer.requestRender();
      if (this._updateFilterCounts) this._updateFilterCounts();
      if (this._updateRouteDropdown) this._updateRouteDropdown();
      this._showInspector(this.renderer.selected);

      if (isManual) {
        const cutStopId = chunk1Anchors[chunk1Anchors.length - 1]?.id;
        if (cutStopId) {
          if (this.mode === 'view') this.setMode('edit');
          setTimeout(() => {
            this._startConnectingFrom(cutStopId, route.id);
          }, 120);
        }
      }
    }

    // Assign / update which bus interchange/terminal an end of a chunk connects to (terminalEnd: 'origin' | 'dest')
    _setChunkTerminal(chunkRouteId, terminalEnd, newInterchangeStopId) {
      this._ensureEditableForRoute();
      const r = this.store.doc.routes[chunkRouteId];
      const newIntStop = this.store.doc.stops[newInterchangeStopId];
      if (!r || !newIntStop || !Array.isArray(r.anchors) || !r.anchors.length) return;

      const isOrigin = (terminalEnd === 'origin');
      this.store.commit(`Set Bus ${r.number} ${isOrigin ? 'Origin' : 'Destination'} to ${newIntStop.name}`, (doc) => {
        const routeObj = doc.routes[chunkRouteId];
        if (!routeObj || !Array.isArray(routeObj.anchors) || !routeObj.anchors.length) return;

        // Clean detour properties so anchors stay authoritative
        delete routeObj.originalAnchors;
        delete routeObj.detourApplied;
        delete routeObj.viaName;
        delete routeObj.detourTitle;
        delete routeObj.activeOptionIdx;
        delete routeObj.fromAiSuggest;
        delete routeObj.constraintBypassOnly;

        if (isOrigin) {
          const s0 = doc.stops[routeObj.anchors[0]?.id];
          if (B.isInterchange(s0)) {
            routeObj.anchors = [{ t: 'stop', id: newIntStop.id }, ...routeObj.anchors.slice(1)];
          } else {
            routeObj.anchors = [{ t: 'stop', id: newIntStop.id }, ...routeObj.anchors];
          }
          routeObj.originTerminalId = newIntStop.id;
        } else {
          const sLast = doc.stops[routeObj.anchors[routeObj.anchors.length - 1]?.id];
          if (B.isInterchange(sLast)) {
            routeObj.anchors = [...routeObj.anchors.slice(0, -1), { t: 'stop', id: newIntStop.id }];
          } else {
            routeObj.anchors = [...routeObj.anchors, { t: 'stop', id: newIntStop.id }];
          }
          routeObj.destTerminalId = newIntStop.id;
        }

        // Deduplicate adjacent anchors
        const deduped = [];
        for (let i = 0; i < routeObj.anchors.length; i++) {
          if (i === 0 || routeObj.anchors[i].id !== routeObj.anchors[i - 1]?.id) {
            deduped.push(routeObj.anchors[i]);
          }
        }
        routeObj.anchors = deduped;

        const sFirst = doc.stops[routeObj.anchors[0]?.id];
        const sLast = doc.stops[routeObj.anchors[routeObj.anchors.length - 1]?.id];
        const chunkNum = routeObj.chunkIndex || 1;
        routeObj.name = `Bus ${routeObj.number} · Chunk ${chunkNum} (${sFirst ? sFirst.name : 'Start'} ➔ ${sLast ? sLast.name : 'End'})`;
      });

      this._saveCurrentProjectDraft(false);
      this._showToast(`Bus ${r.number} ${isOrigin ? 'Origin' : 'Destination'} adjusted to ${newIntStop.name}`, 'success');

      const updated = this.store.doc.routes[chunkRouteId];
      this.renderer.selected = { type: 'route', id: chunkRouteId, obj: updated };
      this.renderer.focusedChunkId = chunkRouteId;
      this._focusOnRoute(updated);
      this.renderer.requestRender();

      if (this._updateFilterCounts) this._updateFilterCounts();
      if (this._updateRouteDropdown) this._updateRouteDropdown();
      this._showInspector(this.renderer.selected);
    }

    // Restore separate chunks of a bus number back into a single continuous route
    _mergeBusChunks(busNumber) {
      this._ensureEditableForRoute();
      const chunks = Object.values(this.store.doc.routes).filter((r) => String(r.number).trim() === String(busNumber).trim());
      if (chunks.length < 2) {
        this._showToast(`Bus ${busNumber} is already a single route`, 'info');
        return;
      }

      const primary = chunks[0];
      const mergedAnchors = [...(primary.anchors || [])];
      for (let i = 1; i < chunks.length; i++) {
        const otherAnchors = chunks[i].anchors || [];
        for (const a of otherAnchors) {
          const last = mergedAnchors[mergedAnchors.length - 1];
          if (!last || last.id !== a.id) mergedAnchors.push(a);
        }
      }

      this.store.commit(`Restore chunks of Bus ${busNumber}`, (doc) => {
        const p = doc.routes[primary.id];
        if (!p) return;
        p.anchors = mergedAnchors;
        const s0 = doc.stops[mergedAnchors[0]?.id];
        const s1 = doc.stops[mergedAnchors[mergedAnchors.length - 1]?.id];
        p.name = `Bus ${busNumber} (${s0 ? s0.name : 'Start'} ➔ ${s1 ? s1.name : 'End'})`;
        p.fleet = chunks.reduce((acc, c) => acc + (c.fleet || 5), 0);
        delete p.isChunk;
        delete p.chunkIndex;
        delete p.severedEnd;
        delete p.chunkInterchangeId;
        delete p.originTerminalId;
        delete p.destTerminalId;
        delete p.originalAnchors;
        delete p.detourApplied;
        delete p.viaName;
        delete p.detourTitle;
        delete p.activeOptionIdx;
        delete p.fromAiSuggest;
        delete p.constraintBypassOnly;

        for (let i = 1; i < chunks.length; i++) {
          delete doc.routes[chunks[i].id];
          if (this.selectedRouteIds) this.selectedRouteIds.delete(chunks[i].id);
          if (this._qfSaved) this._qfSaved.delete(chunks[i].id);
        }
      });

      if (this.hiddenChunkIds) {
        chunks.forEach((c) => this.hiddenChunkIds.delete(c.id));
        this.renderer.hiddenChunkIds = this.hiddenChunkIds;
      }

      this.selectedRouteIds.add(primary.id);
      this.isAllRoutesSelected = (this.selectedRouteIds.size === Object.keys(this.store.doc.routes).length);
      this._applyRouteMultiSelection();
      this._renderRoutePills();
      this._renderQuickFilters();
      if (this._updateRouteDropdown) this._updateRouteDropdown();
      this._saveCurrentProjectDraft(false);

      this._showToast(`Bus ${busNumber} restored into 1 continuous route`, 'success');
      this.renderer.selected = { type: 'route', id: primary.id, obj: this.store.doc.routes[primary.id] };
      this.renderer.requestRender();
      if (this._updateFilterCounts) this._updateFilterCounts();
      if (this._updateRouteDropdown) this._updateRouteDropdown();
      this._showInspector(this.renderer.selected);
    }

    // Remove one chunk of a bus; the chunks left are renumbered
    _deleteBusChunk(chunkId) {
      this._ensureEditableForRoute();
      const route = this.store.doc.routes[chunkId];
      if (!route) return;
      const num = String(route.number).trim();
      const sameBus = (x) => String(x.number).trim() === num;
      if (Object.values(this.store.doc.routes).filter(sameBus).length < 2) return;
      const sel = this.renderer.selected;
      const selId = sel ? (sel.routeId || sel.id) : null;

      this.store.commit(`Delete chunk of Bus ${num}`, (doc) => {
        delete doc.routes[chunkId];
        Object.values(doc.routes).filter(sameBus).forEach((s, i) => {
          s.chunkIndex = i + 1;
          if (s.name) s.name = s.name.replace(/Chunk \d+/, `Chunk ${i + 1}`);
        });
      });

      if (this.hiddenChunkIds) this.hiddenChunkIds.delete(chunkId);
      if (this.selectedRouteIds) this.selectedRouteIds.delete(chunkId);
      if (this._qfSaved) this._qfSaved.delete(chunkId);
      if (this.renderer.hoveredChunkId === chunkId) this.renderer.hoveredChunkId = null;
      if (this.renderer.focusedChunkId === chunkId) this.renderer.focusedChunkId = null;
      this.isAllRoutesSelected = (this.selectedRouteIds.size === Object.keys(this.store.doc.routes).length);
      this._applyRouteMultiSelection();
      this._renderRoutePills();
      this._renderQuickFilters();
      if (this._updateRouteDropdown) this._updateRouteDropdown();
      this._saveCurrentProjectDraft(false);
      this._showToast('Chunk deleted', 'info');

      const next = selId === chunkId ? Object.values(this.store.doc.routes).find(sameBus) : this.store.doc.routes[selId];
      if (next) {
        this.renderer.selected = { type: 'route', id: next.id, obj: next };
        this._showInspector(this.renderer.selected);
      }
      this.renderer.requestRender();
    }

    _showFloatingLegActions(hit, screenPt) {
      if (this.mode === 'view') return;
      const pill = document.getElementById('floating-leg-actions');
      if (!pill) return;
      this._hideFloatingStopActions();

      const fromName = hit.fromStop ? hit.fromStop.name : 'Stop ' + (hit.legIndex + 1);
      const toName = hit.toStop ? hit.toStop.name : 'Stop ' + (hit.legIndex + 2);

      let timeText = '';
      let distText = '';
      if (hit.leg && hit.leg.ok) {
        const timeSec = hit.leg.time || (hit.leg.length / 5.3);
        timeText = B.fmtMin(timeSec);
        distText = B.fmtKm(hit.leg.length);
      }

      const namesEl = document.getElementById('floating-leg-names');
      if (namesEl) namesEl.textContent = `${fromName} ➔ ${toName}`;

      const timeEl = document.getElementById('floating-leg-time');
      if (timeEl) {
        const roadSnippet = hit.roadName ? ` • ${hit.roadName}` : '';
        const redLineBadge = hit.isRedLine ? ' 🔴' : '';
        const statsStr = [distText, timeText].filter(Boolean).join(' • ');
        timeEl.textContent = statsStr ? `(${statsStr}${roadSnippet}${redLineBadge})` : (roadSnippet ? `(${roadSnippet}${redLineBadge})` : '');
        timeEl.style.display = 'inline-flex';
      }

      pill.style.left = `${screenPt.x}px`;
      pill.style.top = `${screenPt.y}px`;
      pill.classList.remove('hidden');
      this._activeFloatingLegHit = hit;
      this._renderFloatingLegConstraints(hit);

      const btnConnect = document.getElementById('btn-floating-connect-stop');
      if (btnConnect) {
        btnConnect.onclick = (e) => {
          e.stopPropagation();
          this._hideFloatingLegActions();
          const targetStopId = hit.toStop ? hit.toStop.id : (hit.fromStop ? hit.fromStop.id : null);
          if (!targetStopId) return;

          if (this.mode === 'view') {
            this.setMode('edit');
          }

          this._startConnectingFrom(targetStopId, hit.routeId);
        };
      }

      const btnCut = document.getElementById('btn-floating-cut-leg');
      if (btnCut) {
        btnCut.onclick = (e) => {
          e.stopPropagation();
          this._hideFloatingLegActions();
          this._cutRouteIntoChunks(hit.routeId, hit.legIndex, { manualEdit: false });
        };
      }

      const btnDel = document.getElementById('btn-floating-del-leg');
      if (btnDel) {
        btnDel.onclick = (e) => {
          e.stopPropagation();
          this.deleteRouteLeg(hit.routeId, hit.legIndex);
        };
      }

      const btnClose = document.getElementById('btn-floating-close-leg');
      if (btnClose) {
        btnClose.onclick = (e) => {
          e.stopPropagation();
          this._hideFloatingLegActions();
        };
      }
    }

    _hideFloatingLegActions() {
      this._activeFloatingLegHit = null;
      const pill = document.getElementById('floating-leg-actions');
      if (pill) pill.classList.add('hidden');
    }

    _renderFloatingLegConstraints() {
      const box = document.getElementById('floating-leg-constraints');
      if (!box) return;
      box.classList.add('hidden');
      box.innerHTML = '';
    }

    // ------------------------------------------------------------- Floating Bus Stop Action Pill
    // The single bus number the user has picked (in search or by clicking its line), or null
    _pickedBusNumber() {
      if (this.isAllRoutesSelected || !this.selectedRouteIds || !this.selectedRouteIds.size) return null;
      const nums = new Set();
      for (const id of this.selectedRouteIds) {
        const r = this.store.doc.routes[id];
        if (r) nums.add(String(r.number).trim());
      }
      return nums.size === 1 ? [...nums][0] : null;
    }

    _showFloatingStopActions(stopId) {
      if (this.mode === 'view') return;
      const pill = document.getElementById('floating-stop-actions');
      if (!pill) return;
      const s = this.store.doc.stops[stopId];
      if (!s) return;

      this._hideFloatingLegActions();
      this.activeStopPillId = stopId;

      const nameEl = document.getElementById('floating-stop-name');
      if (nameEl) nameEl.textContent = s.name || `Stop ${s.id}`;

      const codeEl = document.getElementById('floating-stop-code');
      if (codeEl) {
        codeEl.textContent = s.code ? `[${s.code}]` : `[${s.id}]`;
      }

      // Bus number box: type any number, or pick from the list (buses serving this stop first)
      const servedIds = (this.store.stopRoutes && this.store.stopRoutes[stopId]) || [];
      const routeByNum = new Map();
      for (const r of Object.values(this.store.doc.routes)) {
        const n = String(r.number).trim();
        if (!routeByNum.has(n)) routeByNum.set(n, r);
      }
      const servedNums = [...new Set(servedIds
        .map((rid) => this.store.doc.routes[rid])
        .filter(Boolean)
        .map((r) => String(r.number).trim()))];
      const otherNums = [...routeByNum.keys()]
        .filter((n) => !servedNums.includes(n))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

      // Default to the bus being linked, else the route the user has selected (if it serves this stop),
      // else the one bus picked in search or on the map, else the first bus here
      let defaultBus = servedNums[0] || '';
      const sel = this.renderer.selected;
      const picked = this._pickedBusNumber();
      if (sel && (sel.type === 'route' || sel.type === 'route-leg')) {
        const selRoute = this.store.doc.routes[sel.routeId || sel.id];
        if (selRoute && servedIds.includes(selRoute.id)) defaultBus = String(selRoute.number).trim();
      } else if (picked) defaultBus = picked;
      if (this.connectBusNumber) defaultBus = String(this.connectBusNumber).trim();

      const busInput = document.getElementById('floating-stop-bus');
      const busList = document.getElementById('floating-stop-bus-list');
      const busToggle = document.getElementById('floating-stop-bus-toggle');
      if (busInput && busList) {
        let activeIdx = -1;
        const typed = () => busInput.value.trim();
        const paint = () => {
          const r = routeByNum.get(typed());
          busInput.style.backgroundColor = r ? (r.color || '#2563eb') : '';
          busInput.title = !typed()
            ? 'Type a bus number or pick one'
            : (r ? `Connect as Bus ${typed()}` : `Connect as new Bus ${typed()}`);
        };
        const isOpen = () => !busList.classList.contains('hidden');
        const closeList = () => {
          busList.classList.add('hidden');
          busInput.setAttribute('aria-expanded', 'false');
        };
        // The bus in the pill is the bus chosen: links from this stop use it without asking
        const applyChoice = () => {
          const num = typed();
          this._pillBusChoice = num ? { stopId, num } : null;
          if (num && this.activeConnectStopId === stopId) {
            this.connectBusNumber = num;
            this.renderer.connectBusNumber = num;
            this.renderer.requestRender();
          }
        };
        const choose = (num) => {
          busInput.value = num;
          paint();
          closeList();
          applyChoice();
        };
        // `filter` narrows the list while typing; opening it shows every bus
        const openList = (filter) => {
          const q = (filter || '').trim().toLowerCase();
          const match = (n) => !q || n.toLowerCase().includes(q);
          const row = (n) => {
            const r = routeByNum.get(n);
            return `<li role="option" class="bus-combo-option ${n === typed() ? 'current' : ''}" data-value="${B.esc(n)}">`
              + `<span class="bus-combo-chip" style="background: ${r ? r.color : '#475569'};"></span>${B.esc(n)}</li>`;
          };
          const here = servedNums.filter(match);
          const other = otherNums.filter(match);
          let html = '';
          if (here.length) html += `<li class="bus-combo-group" role="presentation">Stops here</li>${here.map(row).join('')}`;
          if (other.length) html += `<li class="bus-combo-group" role="presentation">Other buses</li>${other.map(row).join('')}`;
          if (q && !routeByNum.has(typed())) html += `<li class="bus-combo-note" role="presentation">New bus ${B.esc(typed())}</li>`;
          if (!html) html = '<li class="bus-combo-note" role="presentation">Type a bus number</li>';
          busList.innerHTML = html;
          activeIdx = -1;
          busList.querySelectorAll('.bus-combo-option').forEach((li) => {
            // mousedown (not click) so the box keeps focus while choosing
            li.onmousedown = (e) => {
              e.preventDefault();
              choose(li.dataset.value);
            };
          });
          busList.classList.remove('hidden');
          busInput.setAttribute('aria-expanded', 'true');
        };
        const highlight = (idx) => {
          const opts = [...busList.querySelectorAll('.bus-combo-option')];
          if (!opts.length) return;
          activeIdx = (idx + opts.length) % opts.length;
          opts.forEach((li, i) => li.classList.toggle('active', i === activeIdx));
          opts[activeIdx].scrollIntoView({ block: 'nearest' });
        };

        busInput.value = defaultBus;
        paint();
        closeList();
        applyChoice();

        busInput.onfocus = () => {
          busInput.select();
          openList('');
        };
        busInput.oninput = () => {
          paint();
          openList(busInput.value);
          applyChoice();
        };
        busInput.onblur = closeList;
        busInput.onclick = (e) => {
          e.stopPropagation();
          if (!isOpen()) openList('');
        };
        // Keep map shortcuts from firing while typing; arrows move, Enter picks or connects, Esc closes the list
        busInput.onkeydown = (e) => {
          e.stopPropagation();
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!isOpen()) openList('');
            highlight(activeIdx + (e.key === 'ArrowDown' ? 1 : -1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const opts = [...busList.querySelectorAll('.bus-combo-option')];
            if (isOpen() && activeIdx >= 0 && opts[activeIdx]) {
              choose(opts[activeIdx].dataset.value);
            } else {
              closeList();
              const btn = document.getElementById('btn-floating-stop-connect');
              if (btn) btn.click();
            }
          } else if (e.key === 'Escape' && isOpen()) {
            e.preventDefault();
            closeList();
          }
        };
        if (busToggle) {
          busToggle.onmousedown = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (isOpen()) {
              closeList();
            } else if (document.activeElement === busInput) {
              openList('');
            } else {
              busInput.focus();
            }
          };
          busToggle.onclick = (e) => e.stopPropagation();
        }
      }

      // Compute screen position of stop dot
      const pt = this.net.posPoint(s, 0.78);
      const screenPt = this.renderer.worldToScreen(pt.x, pt.y);
      this._positionFloatingStopPill(pill, screenPt);

      pill.classList.remove('hidden');

      const btnConnect = document.getElementById('btn-floating-stop-connect');
      if (btnConnect) {
        btnConnect.onclick = (e) => {
          e.stopPropagation();

          // A bus number is needed first: typed, or picked from the list
          const choice = busInput ? busInput.value.trim() : '';
          if (!choice) {
            if (busInput) busInput.focus();
            this._showToast('Pick a bus number first', 'warn');
            return;
          }
          this._hideFloatingStopActions();

          if (this.mode === 'view') {
            this.setMode('edit');
          }

          // Continue that bus's route here if it already serves this stop; a new number starts a new bus
          const servingRid = servedIds.find((rid) => String(this.store.doc.routes[rid]?.number).trim() === choice) || null;
          this._startConnectingFrom(stopId, servingRid, { busNumber: choice, explicit: true });
        };
      }

      const btnClose = document.getElementById('btn-floating-close-stop');
      if (btnClose) {
        btnClose.onclick = (e) => {
          e.stopPropagation();
          this._hideFloatingStopActions();
        };
      }
    }

    _hideFloatingStopActions() {
      const pill = document.getElementById('floating-stop-actions');
      if (pill) pill.classList.add('hidden');
      this.activeStopPillId = null;
    }

    _positionFloatingStopPill(pill, screenPt) {
      pill.style.left = `${screenPt.x}px`;
      if (screenPt.y < 110) {
        pill.style.top = `${screenPt.y + 12}px`;
        pill.classList.add('pill-bottom');
      } else {
        pill.style.top = `${screenPt.y - 24}px`;
        pill.classList.remove('pill-bottom');
      }
    }

    _updateFloatingPositions() {
      if (this.activeStopPillId) {
        const pill = document.getElementById('floating-stop-actions');
        if (pill && !pill.classList.contains('hidden')) {
          const s = this.store.doc.stops[this.activeStopPillId];
          if (s) {
            const pt = this.net.posPoint(s, 0.78);
            const sp = this.renderer.worldToScreen(pt.x, pt.y);
            this._positionFloatingStopPill(pill, sp);
          } else {
            this._hideFloatingStopActions();
          }
        }
      }
    }

    _clearDetourPreview() {
      if (!this.renderer) return;
      this.renderer.previewDetourOption = null;
      this.renderer.detourOptions = null;
      this.renderer.requestRender();
    }

    _selectDetourOption(route, idx, detourOptions) {
      if (!detourOptions || !detourOptions[idx]) return;
      const opt = detourOptions[idx];

      // Update map live active preview
      this.renderer.detourOptions = detourOptions;
      this.renderer.previewDetourOption = { opt, routeNumber: route.number };

      this.renderer.requestRender();
    }

    applySuggestDetour(routeId, specificOptIdx = 0, { silentToast = false, constraintBypassOnly = false, skipCenter = false, fromAiSuggest = false } = {}) {
      let r = this.store.doc.routes[routeId];
      if (!r) return null;

      const baseRouteId = (r.kind === 'proposed' && r.baseId) ? r.baseId : routeId;
      const options = this._rankedDetourOptions(baseRouteId);
      if (!options || !options.length) {
        if (!silentToast) this._showToast('No detour around this closure', 'warn');
        return null;
      }

      const optIdx = specificOptIdx % options.length;
      const chosenOpt = options[optIdx];

      this.showingDetourOptionsRouteId = null;
      this.pinnedDetourIdx = -1;
      this._clearDetourPreview();

      this.store.commit(`Apply suggested detour to Route ${r.number}: ${chosenOpt.title}`, (doc) => {
        const route = doc.routes[baseRouteId] || doc.routes[routeId];
        if (!route) return;

        // Preserve original anchors before applying detour
        if (!route.originalAnchors) {
          route.originalAnchors = JSON.parse(JSON.stringify(route.anchors));
        }

        // Apply suggested detour anchors directly to the current route!
        route.anchors = JSON.parse(JSON.stringify(chosenOpt.anchors));
        route.activeOptionIdx = optIdx;
        route.viaName = chosenOpt.viaName;
        route.detourApplied = true;
        route.detourTitle = chosenOpt.title;
        if (constraintBypassOnly) route.constraintBypassOnly = true;
        if (fromAiSuggest) route.fromAiSuggest = true;

        // Clean up any draft proposed routes attached to this baseId
        const drafts = Object.values(doc.routes).filter((x) => x.baseId === route.id || x.baseId === baseRouteId);
        for (const draft of drafts) {
          delete doc.routes[draft.id];
        }

        // Confirm any proposed stops as existing
        for (const a of route.anchors) {
          if (a.t === 'stop' && doc.stops[a.id] && doc.stops[a.id].kind === 'proposed') {
            doc.stops[a.id].kind = 'existing';
          }
        }

        // Update route name
        const firstStop = doc.stops[route.anchors[0]?.id];
        const lastStop = doc.stops[route.anchors[route.anchors.length - 1]?.id];
        route.name = `Bus ${route.number} (${firstStop ? firstStop.name : ''} ➔ ${lastStop ? lastStop.name : ''})`;
      });

      this.store.save();
      if (!skipCenter) {
        this.renderer.selected = { type: 'route', id: baseRouteId };
        this._showInspector(this.renderer.selected);
        this.centerOnRoute(baseRouteId);
      }
      this.renderer.requestRender();
      if (!silentToast) {
        this._showToast(`Detour applied to Bus ${r.number} via ${chosenOpt.viaName}`, 'success');
      }
      return chosenOpt;
    }

    // ------------------------------------------------------------- Detour scorecard
    // One row per route: the bus now, then each detour option, with its change from now under every number.
    // A row shows that option on the map; Apply uses it; Back returns to the bus info.
    _renderDetourScorecard(content, target, r, g, isDisrupted, options, appliedIdx) {
      const panel = document.getElementById('inspector-panel');
      panel.classList.add('expanded-detour');
      this._hideSegmentPanel();
      const titleEl = document.getElementById('inspector-header-title');
      if (titleEl) titleEl.textContent = 'Compare detours';

      const doc = this.store.doc;
      const mrt = this.city.mrtStations || [];
      const blocked = (geom) => !!geom && (geom.legs || []).some((l) => l.ok && (l.segs || []).some((sg) =>
        this.store.closedSet.has(sg.edge) || (this.store.affected && this.store.affected.has(sg.edge))));
      const runCost = this._runCost(r.number, g && g.time);
      const stats = (anchors, geom) => {
        const stops = [...new Set((anchors || []).filter((a) => a.t === 'stop').map((a) => a.id))].map((id) => doc.stops[id]).filter(Boolean);
        const pts = stops.map((st) => this.net.posPoint(st, 0.78));
        return {
          time: geom ? geom.time : null,
          length: geom ? geom.length : null,
          cost: geom ? runCost(geom.length, geom.time) : null,
          stops: stops.length,
          riders: stops.reduce((t, st) => t + this._stopCommuters(st.id), 0),
          mrt: mrt.filter((m) => pts.some((p) => Math.hypot(p.x - m.x, p.y - m.y) <= 350)).length,
          interchange: stops.filter((st) => window.B && window.B.isInterchange(st)).length,
        };
      };
      const now = stats(r.anchors, g);
      const rows = options.map((o) => ({ ...stats(o.anchors, o.geom), blocked: blocked(o.geom) }));

      // Each number, then its change from now: green when better, red when worse
      const cols = [
        { key: 'time', label: 'Time', fmt: B.fmtMin, lowWins: true, same: 30, title: 'Travel time, end to end' },
        { key: 'length', label: 'Distance', fmt: B.fmtKm, lowWins: true, same: 5, title: 'Route length' },
        { key: 'cost', label: 'Cost', fmt: (n) => (n >= 1000 ? `S$${(n / 1000).toFixed(1)}k` : `S$${Math.round(n)}`), lowWins: true, same: 50, title: "Running cost a day, keeping today's trips (estimate: S$1.80 a bus-km + S$75 a bus-hour)" },
        { key: 'stops', label: 'Stops', fmt: String, same: 0.5, title: 'Bus stops served' },
        { key: 'riders', label: 'Riders', fmt: (n) => this._formatCommuters(n), dfmt: (n) => this._formatCommuters(n).replace('~', ''), same: 0.5, title: 'Riders a day at its stops (estimate)' },
        { key: 'mrt', label: 'MRT', fmt: String, same: 0.5, title: 'MRT stations within 350 m of its stops' },
        { key: 'interchange', label: 'INT', fmt: String, same: 0.5, title: 'Bus interchanges connected' },
      ];
      const cell = (row, c, withDelta) => {
        const v = row[c.key];
        if (v == null) return '<td>—</td>';
        let delta = '';
        if (withDelta && now[c.key] != null) {
          const d = v - now[c.key];
          if (Math.abs(d) < c.same) {
            delta = '<span class="sc-delta">—</span>';
          } else {
            const good = c.lowWins ? d < 0 : d > 0;
            delta = `<span class="sc-delta ${good ? 'good' : 'bad'}">${d > 0 ? '+' : '−'}${B.esc((c.dfmt || c.fmt)(Math.abs(d)))}</span>`;
          }
        }
        return `<td><span class="sc-val">${B.esc(c.fmt(v))}</span>${delta}</td>`;
      };

      // The pick stays while the page re-renders; it opens on the one applied, else the best one
      const pinned = this.showingDetourOptionsRouteId === r.id && this.pinnedDetourIdx >= 0 && this.pinnedDetourIdx < options.length;
      let pick = pinned ? this.pinnedDetourIdx : (appliedIdx >= 0 ? appliedIdx : 0);

      content.innerHTML = `
        <div class="scorecard-top">
          <button type="button" class="scorecard-back" aria-label="Back to Bus ${B.esc(r.number)} info">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
            Back
          </button>
          <span class="modal-route-badge" style="background: ${r.color || '#2563eb'};">${B.esc(r.number)}</span>
        </div>
        <div class="scorecard-wrap">
          <table class="scorecard">
            <thead>
              <tr><th>Route</th>${cols.map((c) => `<th title="${B.esc(c.title)}">${c.label}</th>`).join('')}</tr>
            </thead>
            <tbody>
              <tr class="sc-now" title="The route as it runs now">
                <td class="sc-name">Now${isDisrupted ? '<span class="sc-tag bad">Disrupted</span>' : ''}</td>
                ${cols.map((c) => cell(now, c, false)).join('')}
              </tr>
              ${options.map((o, idx) => `
                <tr class="sc-opt" data-idx="${idx}" title="Show ${B.esc(o.label || o.viaName)} on the map">
                  <td class="sc-name">
                    ${B.esc(o.label || o.viaName)}
                    ${o.isInterchangeOption || o.interchange ? '<span class="sc-tag int-tag" style="background: #1e3a8a; color: #fff; font-weight: 800; font-size: 9.5px; padding: 2px 6px; border-radius: 4px; margin-left: 5px; letter-spacing: 0.3px;">INT</span>' : ''}
                    ${idx === 0 ? '<span class="detour-best">Best option</span>' : ''}
                    ${idx === appliedIdx ? '<span class="sc-tag good">Applied</span>' : ''}
                    ${rows[idx].blocked ? '<span class="sc-tag bad">Disrupted</span>' : ''}
                  </td>
                  ${cols.map((c) => cell(rows[idx], c, true)).join('')}
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <button type="button" class="btn-scorecard-apply"></button>
      `;

      const table = content.querySelector('.scorecard');
      const btnApply = content.querySelector('.btn-scorecard-apply');
      // Detour option live map preview with big dots
      const show = (idx) => {
        if (idx >= 0) this._selectDetourOption(r, idx, options);
        else this._clearDetourPreview();
      };
      const paint = () => {
        table.querySelectorAll('.sc-opt').forEach((tr) => tr.classList.toggle('is-picked', Number(tr.dataset.idx) === pick));
        table.querySelector('.sc-now').classList.toggle('is-picked', pick < 0);
        const o = options[pick];
        const applied = pick >= 0 && pick === appliedIdx;
        btnApply.disabled = !o || applied;
        btnApply.textContent = !o ? 'Pick a detour' : (applied ? 'Applied' : `Apply ${o.label || o.viaName}`);
      };
      const choose = (idx) => {
        pick = idx;
        this.showingDetourOptionsRouteId = idx >= 0 ? r.id : null;
        this.pinnedDetourIdx = idx;
        show(idx);
        paint();
      };

      table.querySelectorAll('.sc-opt').forEach((tr) => {
        const idx = Number(tr.dataset.idx);
        tr.addEventListener('mouseenter', () => show(idx));
        tr.addEventListener('click', () => choose(idx));
      });
      table.querySelector('.sc-now').addEventListener('click', () => choose(-1));
      table.querySelector('tbody').addEventListener('mouseleave', () => show(pick));
      btnApply.addEventListener('click', () => {
        if (options[pick] && pick !== appliedIdx) this.applySuggestDetour(r.id, pick);
      });
      content.querySelector('.scorecard-back').addEventListener('click', () => {
        this.detourScorecardRouteId = null;
        this.showingDetourOptionsRouteId = null;
        this.pinnedDetourIdx = -1;
        this._clearDetourPreview();
        this._showInspector(target);
      });

      choose(pick);
    }

    // ------------------------------------------------------------- Inspector Panel UI
    // Pieces shared by the inspector's place panels
    _backToListBtn(target) {
      return target.fromAreaFilter ? `<button type="button" class="btn-back-area-filter" style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; margin-bottom: 10px; border-radius: 6px; border: 1px solid #bfdbfe; background: #eff6ff; color: #1e40af; font-size: 11.5px; font-weight: 700; cursor: pointer;"> <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg> <span>Back to Selection List</span> </button>` : '';
    }

    _routeChipsHtml(ids) {
      const chips = ids.map((rid) => {
        const r = this.store.doc.routes[rid];
        const bg = r ? (r.color || '#2563eb') : '#2563eb';
        const num = r ? r.number : rid;
        return `<span class="route-badge" data-rid="${rid}" style="background: ${bg}; color: #ffffff; cursor: pointer; border-radius: 4px; font-weight: 800; padding: 2px 7px; font-size: 11px;" title="Bus ${B.esc(num)}">${B.esc(num)}</span>`;
      }).join('') || '<span class="text-muted" style="font-size: 11.5px; font-style: italic;">None</span>';
      return `<div class="route-chips" style="display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; max-width: 180px;">${chips}</div>`;
    }

    _nearestMrtRow(list) {
      if (!list.length) return '';
      const m = list[0];
      return `<div class="prop-row">
        <span class="prop-label">Nearest MRT</span>
        <span class="prop-val bold mrt-chip-link" data-mrt-id="${m.id}" style="color: #0369a1; cursor: pointer;" title="View ${B.esc(m.name)} MRT">${B.esc(m.name)} MRT${m.code ? ` [${B.esc(m.code)}]` : ''}</span>
      </div>`;
    }

    _zoneStatusRow(pt, title) {
      const aff = this._checkEntityAffected({ x: pt.x, y: pt.y, title });
      if (!aff.isAffected) return '';
      return `<div class="prop-row">
        <span class="prop-label">Zone Status</span>
        <span class="prop-val bold" style="color: ${aff.isAiFocus ? '#2563eb' : '#dc2626'};">${aff.isAiFocus ? 'AI Focus' : 'Affected Area'} (${B.esc(aff.areaName)})</span>
      </div>`;
    }

    _stopsNear(pt, walk) {
      return Object.values(this.store.doc.stops).filter((st) => {
        const p = this.net.posPoint(st, 0.78);
        return Math.hypot(p.x - pt.x, p.y - pt.y) <= walk;
      });
    }

    _wireBackToList(content) {
      const btnBack = content.querySelector('.btn-back-area-filter');
      if (btnBack) {
        btnBack.addEventListener('click', () => {
          this.renderer.selected = { type: 'area-filter' };
          this._showInspector(this.renderer.selected);
          this.renderer.requestRender();
        });
      }
    }

    _wireMrtLinks(content, target) {
      content.querySelectorAll('.mrt-chip-link').forEach((chip) => {
        const mid = chip.dataset.mrtId;
        chip.addEventListener('click', () => {
          const m = (this.city.mrtStations || []).find((x) => x.id === mid);
          if (m) {
            this.renderer.selected = { type: 'mrt', id: mid, obj: m, fromAreaFilter: target.fromAreaFilter };
            this._showInspector(this.renderer.selected);
            this._focusSelectedTarget(this.renderer.selected);
            this.renderer.requestRender();
          }
        });
      });
    }

    _wirePlaceLinks(content, target) {
      this._wireBackToList(content);
      this._wireMrtLinks(content, target);
      content.querySelectorAll('.route-badge').forEach((badge) => {
        const rid = badge.dataset.rid;
        badge.addEventListener('mouseenter', () => { this.renderer.routePreviewId = rid; this.renderer.requestRender(); });
        badge.addEventListener('mouseleave', () => { if (this.renderer.routePreviewId === rid) { this.renderer.routePreviewId = null; } this.renderer.requestRender(); });
        badge.addEventListener('click', () => {
          this.renderer.selected = { type: 'route', id: rid, obj: this.store.doc.routes[rid], fromAreaFilter: target.fromAreaFilter };
          this._showInspector(this.renderer.selected);
          this.renderer.requestRender();
        });
      });
    }

    _showInspector(target) {
      const panel = document.getElementById('inspector-panel');
      if (!panel) return;
      // Affected areas get no panel: they stay selected (drag the handles to reshape), and Delete removes them
      if (target && target.type === 'area') {
        this._hideInspector();
        return;
      }
      if (this.historyOpen) {
        this.historyOpen = false;
        this._syncHistoryButton();
      }

      const scorecardFor = target && (target.type === 'route' || target.type === 'route-leg') ? (target.routeId || target.id) : null;
      if (scorecardFor !== this.detourScorecardRouteId) this.detourScorecardRouteId = null;

      panel.classList.remove('hidden', 'expanded-detour');
      document.body.classList.add('has-inspector');
      this._hideSegmentPanel();
      const btnEditPanel = document.getElementById('btn-edit-inspector');
      if (btnEditPanel) { btnEditPanel.hidden = true; btnEditPanel.onclick = null; }
      const content = panel.querySelector('.inspector-body');
      if (!content) return;

      const titleEl = document.getElementById('inspector-header-title') || panel.querySelector('.inspector-header-title');
      if (titleEl) {
        if (target.type === 'foreign-project') {
          titleEl.textContent = 'Project Details';
        } else if (target.type === 'stop') {
          const st = target.obj || (this.store && this.store.doc.stops[target.id]);
          titleEl.textContent = (st && B.isInterchange(st)) ? 'Bus Terminal / Interchange' : 'Bus Stop';
        } else if (target.type === 'terminal') {
          titleEl.textContent = 'Bus Terminal / Interchange';
        } else if (target.type === 'route' || target.type === 'route-leg') {
          const route = this.store.doc.routes[target.routeId || target.id];
          titleEl.textContent = route ? `Bus Route: ${route.number}` : 'Bus Route';
        } else if (target.type === 'closure') {
          titleEl.textContent = 'Road Closure';
        } else if (target.type === 'area') {
          titleEl.textContent = 'Affected Area';
        } else if (target.type === 'area-filter') {
          titleEl.textContent = 'Selected Area Entities';
        } else if (target.type === 'mrt') {
          titleEl.textContent = 'MRT Station';
        } else if (target.type === 'road') {
          titleEl.textContent = 'Road Segment';
        } else if (target.type === 'postal') {
          titleEl.textContent = 'Postal Code';
        } else if (target.type === 'address') {
          titleEl.textContent = 'Address & Landmark';
        } else {
          titleEl.textContent = 'Details';
        }
      }

      const isRouteTarget = (target.type === 'route' || target.type === 'route-leg');
      const targetRouteId = target.routeId || target.id;
      if (this.showingDetourOptionsRouteId && (!isRouteTarget || targetRouteId !== this.showingDetourOptionsRouteId)) {
        this.showingDetourOptionsRouteId = null;
        this.pinnedDetourIdx = -1;
        this._clearDetourPreview();
      }

      if (target.type === 'foreign-project') {
        const projId = target.id || target.projectId;
        const p = target.project || (this.projects || []).find((x) => x.id === projId) || { id: projId, name: target.projectName || 'Project' };
        const period = this._readProjectPeriod(p);
        const pDoc = (projId === this.activeProjectId)
          ? this.store.doc
          : (this._storedAreasClosures(projId) || this._loadProjectDraft(projId));

        const areas = Object.values((pDoc && pDoc.areas) || {});
        const closures = Object.keys((pDoc && pDoc.closures) || {});
        const areasCount = areas.length;
        const closuresCount = closures.length;

        // Calculate period string
        let periodStr = 'Permanent (Forever)';
        if (period.mode === 'scheduled' && !period.error) {
          const sDate = new Date(period.start).toLocaleDateString('en-GB');
          const sTime = new Date(period.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const eDate = new Date(period.end).toLocaleDateString('en-GB');
          const eTime = new Date(period.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          periodStr = `${sDate} ${sTime} – ${eDate} ${eTime}`;
        }

        const statusMap = {
          not_started: 'Not Started',
          progress: 'In Progress',
          review: 'Ready to Review',
          approved: 'Approved',
          schedule: 'Schedule',
          go_live: 'Go-Live',
          archive: 'Archive',
        };
        const status = statusMap[p.status] || p.status || (p.approved ? 'Approved' : 'In Progress');
        const statusBadgeStyle = p.status === 'go_live'
          ? 'background: #d1fae5; color: #065f46; border: 1px solid #34d399;'
          : p.status === 'schedule'
            ? 'background: #f5f3ff; color: #6d28d9; border: 1px solid #c4b5fd;'
            : 'background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1;';
        const owner = p.owner || { name: 'John Doe', initials: 'JD' };
        const collaborators = p.collaborators || [];

        content.innerHTML = `
          <div class="panel-section">
            <div class="prop-row" style="align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px;">
              <span class="bold" style="font-size: 14.5px; font-weight: 800; color: #0f172a; margin-left: 0; text-align: left; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${B.esc(p.name)}</span>
              <span class="status-badge" style="font-size: 11px; padding: 2.5px 8px; border-radius: 9999px; font-weight: 700; ${statusBadgeStyle} flex-shrink: 0;">${B.esc(status)}</span>
            </div>

            ${p.id ? `
              <div class="prop-row">
                <span class="prop-label">Project ID</span>
                <span class="prop-val mono" style="font-size: 11px; color: #64748b; font-weight: 600;">${B.esc(p.id)}</span>
              </div>
            ` : ''}

            <div class="prop-row" style="flex-direction: column; align-items: flex-start; gap: 3px;">
              <span class="prop-label">Time Period</span>
              <span class="prop-val mono" style="font-size: 11px; text-align: left; word-break: break-word;">${B.esc(periodStr)}</span>
            </div>

            <div class="prop-row">
              <span class="prop-label">Affected Areas</span>
              <span class="prop-val bold" style="color: #64748b; display: inline-flex; align-items: center; gap: 5px;">
                <span style="display: inline-block; width: 10px; height: 10px; border-radius: 2px; background: rgba(148, 163, 184, 0.4); border: 1.5px dashed #64748b;"></span>
                <span>${areasCount} area${areasCount === 1 ? '' : 's'} (Grey)</span>
              </span>
            </div>

            <div class="prop-row">
              <span class="prop-label">Road Closures</span>
              <span class="prop-val bold" style="color: #64748b; display: inline-flex; align-items: center; gap: 5px;">
                <span style="display: inline-block; width: 10px; height: 4px; border-radius: 1px; background: #94a3b8;"></span>
                <span>${closuresCount} road segment${closuresCount === 1 ? '' : 's'} (Grey)</span>
              </span>
            </div>

            <div class="prop-row">
              <span class="prop-label">Owner</span>
              <span class="prop-val bold" style="display: inline-flex; align-items: center; gap: 6px;">
                <span class="user-avatar" style="width: 20px; height: 20px; font-size: 9.5px; font-weight: 800; border-radius: 50%; background: #2563eb; color: #fff; display: inline-flex; align-items: center; justify-content: center;">${B.esc(owner.initials || 'JD')}</span>
                <span>${B.esc(owner.name || 'Owner')}</span>
              </span>
            </div>

            ${collaborators.length ? `
              <div class="prop-row">
                <span class="prop-label">Collaborators</span>
                <span class="prop-val" style="display: inline-flex; align-items: center; gap: 4px;">
                  ${collaborators.map((c) => `
                    <span class="user-avatar" title="${B.esc(c.name)}" style="width: 20px; height: 20px; font-size: 9px; font-weight: 700; border-radius: 50%; background: #475569; color: #fff; display: inline-flex; align-items: center; justify-content: center;">${B.esc(c.initials)}</span>
                  `).join('')}
                </span>
              </div>
            ` : ''}

            <div style="margin-top: 14px; padding-top: 12px; border-top: 1px solid #e2e8f0; display: flex; gap: 8px;">
              <button type="button" class="btn-open-foreign-project" data-project-id="${B.esc(p.id)}" style="flex: 1; padding: 9px 14px; background: #2563eb; color: #ffffff; font-weight: 700; font-size: 12px; border: none; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px; box-shadow: 0 1px 2px rgba(0,0,0,0.1);">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                View Project
              </button>
            </div>
          </div>
        `;

        const btnOpen = content.querySelector('.btn-open-foreign-project');
        if (btnOpen) {
          btnOpen.addEventListener('click', (e) => {
            e.stopPropagation();
            this._switchProject(p.id);
          });
        }
        return;
      }

      if (target.type === 'mrt') {
        const m = target.obj || target.mrtObj || (this.city.mrtStations || []).find((x) => x.id === target.id);
        if (!m) return;
        const WALK = 400;
        const nearStops = Object.values(this.store.doc.stops).filter((st) => {
          const pt = (this.renderer && this.renderer.stopPoint(st)) || (st.pos && this.net && this.net.posPoint(st.pos, 0.78)) || { x: st.x || 0, y: st.y || 0 };
          return Math.hypot(pt.x - m.x, pt.y - m.y) <= WALK;
        });
        const routeIds = new Set(nearStops.flatMap((st) => this.store.stopLines[st.id] || []));
        const groups = this._busGroups([...routeIds].map((rid) => this.store.doc.routes[rid]).filter(Boolean))
          .sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
        const road = this.net.edge(m.edge);

        content.innerHTML = `
          ${this._backToListBtn(target)}
          <div class="panel-section">
            <div class="prop-row">
              <span class="prop-label">Name</span>
              <span class="prop-val bold" style="color: #0369a1;">${B.esc(m.name)} MRT</span>
            </div>
            <div class="prop-row">
              <span class="prop-label">Code</span>
              <span class="prop-val mono bold">${B.esc(m.code || m.id)}</span>
            </div>
            <div class="prop-row">
              <span class="prop-label">Road</span>
              <span class="prop-val">${B.esc(road ? road.name : '—')}</span>
            </div>
            <div class="prop-row">
              <span class="prop-label">Bus stops within ${WALK} m</span>
              <span class="prop-val">${nearStops.length}</span>
            </div>
            <div class="prop-row" style="align-items: flex-start;">
              <span class="prop-label" style="padding-top: 2px;">Buses</span>
              <div class="route-chips" style="display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; max-width: 180px;">
                ${groups.map((g) => `<span class="route-badge" data-rid="${g.ids[0]}" style="background: ${g.color}; color: #ffffff; cursor: ${this.reviewMode ? 'default' : 'pointer'}; border-radius: 4px; font-weight: 800; padding: 2px 7px; font-size: 11px;" title="Bus ${B.esc(g.number)}">${B.esc(g.number)}</span>`).join('') || '<span class="text-muted" style="font-size: 11.5px; font-style: italic;">None</span>'}
              </div>
            </div>
          </div>
        `;

        this._wireBackToList(content);

        content.querySelectorAll('.route-badge').forEach((badge) => {
          const rid = badge.dataset.rid;
          badge.style.cursor = 'pointer';
          badge.addEventListener('mouseenter', () => { this.renderer.routePreviewId = rid; this.renderer.requestRender(); });
          badge.addEventListener('mouseleave', () => {
            if (this.renderer.routePreviewId === rid) this.renderer.routePreviewId = null;
            this.renderer.requestRender();
          });
          badge.addEventListener('click', () => {
            this.renderer.selected = { type: 'route', id: rid, obj: this.store.doc.routes[rid], fromAreaFilter: target.fromAreaFilter };
            this._showInspector(this.renderer.selected);
            this.renderer.requestRender();
          });
        });
        return;
      }

      if (target.type === 'road') {
        const e = target.edge || this.net.edge(target.id);
        if (!e) return;
        const eId = e.id;
        const routeIds = this._busesOnEdges(new Set([eId]));
        const stopsOnRoad = Object.values(this.store.doc.stops).filter((st) => st.edge === eId);
        const mrtNear = (this.city.mrtStations || []).filter((m) => m.edge === eId);
        const isClosed = Boolean(this.store.doc.closures && this.store.doc.closures[eId]);

        content.innerHTML = `
          ${this._backToListBtn(target)}
          <div class="panel-section">
            <div class="prop-row">
              <span class="prop-label">Road Name</span>
              <span class="prop-val bold">${B.esc(e.name || 'Road Segment')}</span>
            </div>

            <div class="prop-row">
              <span class="prop-label">Road Classification</span>
              <span class="prop-val bold">${e.cls === 'major' ? 'Major Arterial Road' : 'Local Road'}</span>
            </div>
            <div class="prop-row">
              <span class="prop-label">Length</span>
              <span class="prop-val">${Math.round(e.len)} m</span>
            </div>
            <div class="prop-row">
              <span class="prop-label">Lanes & Width</span>
              <span class="prop-val">${e.lanes || 2} Lanes · ${(e.hw * 2).toFixed(1)} m</span>
            </div>
            <div class="prop-row">
              <span class="prop-label">Traffic Status</span>
              <span class="prop-val">
                ${isClosed ? '<span class="tag tag-disrupted">⛔ Road Closure Active</span>' : '<span class="tag tag-existing">✓ Open to Traffic</span>'}
              </span>
            </div>
            <div class="prop-row" style="align-items: flex-start;">
              <span class="prop-label" style="padding-top: 2px;">Operating Buses (${routeIds.length})</span>
              ${this._routeChipsHtml(routeIds)}
            </div>
            <div class="prop-row" style="align-items: flex-start;">
              <span class="prop-label" style="padding-top: 2px;">Bus Stops (${stopsOnRoad.length})</span>
              <div style="display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; max-width: 180px;">
                ${stopsOnRoad.map((s) => `<span class="stop-chip-link" data-stop-id="${s.id}" style="background: #f1f5f9; border: 1px solid #cbd5e1; color: #1e293b; border-radius: 4px; font-weight: 700; padding: 2px 6px; font-size: 11px; cursor: pointer;">${B.esc(s.name)}</span>`).join('') || '<span class="text-muted" style="font-size: 11.5px; font-style: italic;">None</span>'}
              </div>
            </div>
            ${this._nearestMrtRow(mrtNear)}
          </div>
        `;

        this._wirePlaceLinks(content, target);

        content.querySelectorAll('.stop-chip-link').forEach((chip) => {
          const sid = chip.dataset.stopId;
          chip.addEventListener('click', () => {
            this.renderer.selected = { type: 'stop', id: sid, obj: this.store.doc.stops[sid], fromAreaFilter: target.fromAreaFilter };
            this._showInspector(this.renderer.selected);
            this._focusSelectedTarget(this.renderer.selected);
            this.renderer.requestRender();
          });
        });

        return;
      }

      if (target.type === 'postal') {
        const code = target.code || '';
        const sector = code.slice(0, 2);
        const district = target.district || 'Singapore';
        const pt = { x: target.x, y: target.y };
        const WALK = 450;
        const nearStops = this._stopsNear(pt, WALK);
        const nearMrt = (this.city.mrtStations || []).filter((m) => Math.hypot(m.x - pt.x, m.y - pt.y) <= 800);
        const busesNear = [...new Set(nearStops.flatMap((st) => this.store.stopLines[st.id] || []))];

        content.innerHTML = `
          ${this._backToListBtn(target)}
          <div class="panel-section">
            <div class="prop-row">
              <span class="prop-label">Postal Code</span>
              <span class="prop-val mono bold">${B.esc(code)}</span>
            </div>

            <div class="prop-row">
              <span class="prop-label">Postal Sector</span>
              <span class="prop-val bold">Sector ${B.esc(sector)}</span>
            </div>
            <div class="prop-row">
              <span class="prop-label">Planning Area</span>
              <span class="prop-val bold">${B.esc(district)}</span>
            </div>
            ${this._zoneStatusRow(pt, name)}
            ${target.roadName ? `
              <div class="prop-row">
                <span class="prop-label">Nearest Street</span>
                <span class="prop-val">${B.esc(target.roadName)}</span>
              </div>
            ` : ''}
            <div class="prop-row">
              <span class="prop-label">Stops within ${WALK} m</span>
              <span class="prop-val">${nearStops.length} bus stops</span>
            </div>
            <div class="prop-row" style="align-items: flex-start;">
              <span class="prop-label" style="padding-top: 2px;">Accessible Buses</span>
              ${this._routeChipsHtml(busesNear)}
            </div>
            ${this._nearestMrtRow(nearMrt)}
          </div>
        `;

        this._wirePlaceLinks(content, target);

        return;
      }

      if (target.type === 'address') {
        const name = target.name || (target.obj && target.obj.name) || (target.entity && (target.entity.title || target.entity.name)) || 'Singapore';
        const district = target.district || (target.obj && target.obj.district) || (target.entity && target.entity.district) || 'Central';
        const postalCode = target.postalCode || (target.obj && target.obj.postalCode) || (target.entity && target.entity.postalCode) || '';
        const road = target.road || (target.obj && target.obj.roadName) || (target.entity && target.entity.road) || '';
        const pt = { x: target.x, y: target.y };
        const WALK = 500;
        const nearStops = this._stopsNear(pt, WALK);
        const nearMrt = (this.city.mrtStations || []).filter((m) => Math.hypot(m.x - pt.x, m.y - pt.y) <= 850);
        const busesNear = [...new Set(nearStops.flatMap((st) => this.store.stopLines[st.id] || []))];

        content.innerHTML = `
          ${this._backToListBtn(target)}
          <div class="panel-section">
            <div class="prop-row">
              <span class="prop-label">Location</span>
              <span class="prop-val bold">${B.esc(name)}</span>
            </div>

            <div class="prop-row">
              <span class="prop-label">Planning Area</span>
              <span class="prop-val">${B.esc(district)}</span>
            </div>
            ${postalCode ? `
              <div class="prop-row">
                <span class="prop-label">Postal Code</span>
                <span class="prop-val mono">${B.esc(postalCode)}</span>
              </div>
            ` : ''}
            ${road ? `
              <div class="prop-row">
                <span class="prop-label">Nearest Street</span>
                <span class="prop-val">${B.esc(road)}</span>
              </div>
            ` : ''}
            ${this._zoneStatusRow(pt, name)}
            ${target.sector ? `
              <div class="prop-row">
                <span class="prop-label">Postal Sector</span>
                <span class="prop-val mono bold">Sector ${B.esc(target.sector)}</span>
              </div>
            ` : ''}
            <div class="prop-row">
              <span class="prop-label">Nearby Stops</span>
              <span class="prop-val">${nearStops.length} bus stops</span>
            </div>
            <div class="prop-row" style="align-items: flex-start;">
              <span class="prop-label" style="padding-top: 2px;">Nearby Buses</span>
              ${this._routeChipsHtml(busesNear)}
            </div>
            ${this._nearestMrtRow(nearMrt)}
          </div>
        `;

        this._wirePlaceLinks(content, target);

        return;
      }

      if (target.type === 'stop') {
        const s = this.store.doc.stops[target.id];
        if (!s) return;
        const e = this.net.edge(s.edge);
        const routes = this.store.stopLines[s.id] || [];

        const stopPt = this.net.posPoint(s, 0.78);
        const fmtDist = (d) => (d >= 1000 ? (d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m');
        const nearest5Mrts = (this.city.mrtStations || [])
          .map((m) => ({ ...m, dist: Math.hypot(m.x - stopPt.x, m.y - stopPt.y) }))
          .sort((a, b) => a.dist - b.dist)
          .slice(0, 5);

        content.innerHTML = `
          ${this._backToListBtn(target)}
          <div class="panel-section">
            <div class="prop-row">
              <span class="prop-label">Name</span>
              <span class="prop-val bold">${B.esc(s.name)}</span>
            </div>

            <div class="prop-row">
              <span class="prop-label">Code</span>
              <span class="prop-val mono bold">${s.code || s.id}</span>
            </div>
            <div class="prop-row">
              <span class="prop-label">Road</span>
              <span class="prop-val">${e ? e.name : 'Unknown'}</span>
            </div>
            <div class="prop-row">
              <span class="prop-label">Status</span>
              <span class="stop-status">
                <span class="bold bus-status ${s.active === false ? 'is-off' : ''}">${s.active === false ? 'Not active' : 'Active'}</span>
                <span class="tag tag-${s.kind}">${s.kind === 'existing' ? 'EXISTING' : 'PROPOSED'}</span>
              </span>
            </div>
            <div class="prop-row" style="align-items: flex-start;">
              <span class="prop-label" style="padding-top: 2px;">Buses</span>
              <div class="route-chips" style="display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; max-width: 180px;">
                ${routes.map((rid) => {
                  const r = this.store.doc.routes[rid];
                  const bg = r?.color || '#2563eb';
                  return `<span class="route-badge" data-rid="${rid}" style="background: ${bg}; color: #ffffff; cursor: pointer; border-radius: 4px; font-weight: 800; padding: 2px 7px; font-size: 11px;" title="Route ${r ? r.number : rid}">${r ? r.number : rid}</span>`;
                }).join('') || '<span class="text-muted" style="font-size: 11.5px; font-style: italic;">None</span>'}
              </div>
            </div>
            <div class="prop-row" style="align-items: flex-start;">
              <span class="prop-label" style="padding-top: 2px;">Bus types</span>
              ${this._busTypesHtml(this._stopTypes(s.id))}
            </div>
            ${routes.length ? `
              <div class="prop-row" title="Days at least one of its buses runs">
                <span class="prop-label">Operating days</span>
                ${this._dayDotsHtml([...new Set(routes.flatMap((rid) => {
                  const rr = this.store.doc.routes[rid];
                  return rr ? B.busDays(this.store.doc, rr.number) : [];
                }))])}
              </div>
            ` : ''}
            <div class="prop-row" title="Estimated from the area and the buses that stop here">
              <span class="prop-label">Commuters</span>
              <span class="prop-val">${this._formatCommuters(this._stopCommuters(s.id))} / day</span>
            </div>
            <div class="prop-row">
              <span class="prop-label">Street View</span>
              <span class="prop-val">
                ${this._streetViewLinkHtml(s, { label: 'Google Street View' })}
              </span>
            </div>
            <div class="prop-row" style="align-items: flex-start; gap: 8px;">
              <span class="prop-label" style="padding-top: 2px; flex-shrink: 0;">Nearest MRT</span>
              <div class="prop-val" style="display: flex; flex-direction: column; gap: 4px; align-items: flex-end; text-align: right; min-width: 0;">
                ${nearest5Mrts.length > 0 ? nearest5Mrts.map((m) => {
                  const mName = m.name.toLowerCase().includes('mrt') ? m.name : m.name + ' MRT';
                  const mCode = m.code ? ` [${m.code}]` : '';
                  return `
                    <span class="mrt-chip-link" data-mrt-id="${m.id}" style="cursor: pointer; color: var(--text-main); font-weight: 600; font-size: 11.5px; line-height: 1.35; transition: color 0.15s ease;" title="View ${B.esc(mName)}${B.esc(mCode)}">
                      ${B.esc(mName)}${B.esc(mCode)} <span style="white-space: nowrap;">· ${fmtDist(m.dist)}</span>
                    </span>
                  `;
                }).join('') : `<span class="text-muted" style="font-size: 12px; font-style: italic;">None</span>`}
              </div>
            </div>
          </div>
          ${(() => {
            const firstServingRoute = routes.length ? this.store.doc.routes[routes[0]] : null;
            const stopConsts = this.store.legConstraints(null, s.edge, firstServingRoute).slice(0, 1);
            if (!stopConsts.length) return '';
            return `
              <div class="panel-section">
                <div class="segment-panel-constraints-head">Segment Constraints (${stopConsts.length})</div>
                <div class="route-seg-constraints-list">
                  ${stopConsts.map((c) => this._renderConstraintItemHtml(c, firstServingRoute, { compact: true, hideRoad: false })).join('')}
                </div>
              </div>
            `;
          })()}
        `;

        const firstServing = routes.length ? this.store.doc.routes[routes[0]] : null;
        if (firstServing) {
          this._bindConstraintEvents(content, firstServing);
        }

        // Pencil in the header: on a draft in edit mode it opens Edit bus stop; otherwise it's locked
        const btnEdit = document.getElementById('btn-edit-inspector');
        if (btnEdit && !this._isReadOnlyView() && !this._isCreatingRoute()) {
          const lock = this._pencilLock();
          btnEdit.hidden = false;
          btnEdit.classList.toggle('is-disabled', !!lock);
          btnEdit.title = lock ? lock.title : 'Edit bus stop';
          btnEdit.setAttribute('aria-label', 'Edit bus stop');
          btnEdit.onclick = () => (lock ? lock.note() : this._promptEditStop(s.id));
        }

        this._wireBackToList(content);

        this._wireMrtLinks(content, target);

        content.querySelectorAll('.route-badge').forEach((badge) => {
          const rid = badge.dataset.rid;
          badge.style.cursor = 'pointer';
          badge.addEventListener('mouseenter', () => {
            this.renderer.routePreviewId = rid;
            this.renderer.requestRender();
          });
          badge.addEventListener('mouseleave', () => {
            if (this.renderer.routePreviewId === rid) {
              this.renderer.routePreviewId = null;
            }
            this.renderer.requestRender();
          });
          badge.addEventListener('click', () => {
            this.renderer.selected = { type: 'route', id: rid, obj: this.store.doc.routes[rid] };
            this._showInspector(this.renderer.selected);
            this.renderer.requestRender();
          });
        });

      } else if (target.type === 'route' || target.type === 'route-leg') {
        const routeId = target.routeId || target.id;
        const r = this.store.doc.routes[routeId];
        if (!r) return;
        this.lastActiveRouteId = r.id;

        // Sync operation card to selected route
        this._updateRouteOperationCard(r.id);

        const g = this.store.geom[r.id];
        const isDisrupted = this.isRouteAffected(r.id);
        const hasDetour = this.hasActiveDetour(r);
        const hours = B.busHours(this.store.doc, r.number);
        const days = B.busDays(this.store.doc, r.number);
        const active = B.busActive(this.store.doc, r.number);
        const draft = typeof this.store.draftOf === 'function' ? this.store.draftOf(r.id) : null;

        const before = this._routeNumbersBefore(r);
        const fleetNow = this._busFleet(r.number);
        // The summary and the stop list are for the whole bus line: every piece of this bus number
        const line = this._busLine(this.store.doc, this.store.geom, r.number);
        const drawn = line.time != null;
        const wholeTime = drawn ? B.fmtMin(line.time) : '—';
        const wholeDist = drawn ? B.fmtKm(line.length) : '—';
        const wholeStops = drawn ? `${line.stops.length} stop${line.stops.length === 1 ? '' : 's'}` : '—';
        const routeStops = line.stops;

        const isLegSelected = (target.type === 'route-leg' && target.legIndex !== undefined);
        let selLegIdx = isLegSelected ? target.legIndex : -1;
        let selLeg = (isLegSelected && g && g.legs) ? g.legs[selLegIdx] : null;
        let fromStop = isLegSelected ? target.fromStop : null;
        let toStop = isLegSelected ? target.toStop : null;

        // Fallback: If no specific leg was clicked, default to the route's constrained segment, else first disrupted leg, else first leg
        if (!selLeg && g && g.legs && g.legs.length > 0) {
          if (g.constraint && g.constraint.legIndex >= 0 && g.legs[g.constraint.legIndex]) {
            selLegIdx = g.constraint.legIndex;
            selLeg = g.legs[selLegIdx];
            const a1 = r.anchors[selLegIdx];
            const a2 = r.anchors[selLegIdx + 1];
            fromStop = a1 && a1.t === 'stop' ? this.store.doc.stops[a1.id] : null;
            toStop = a2 && a2.t === 'stop' ? this.store.doc.stops[a2.id] : null;
          }
          const firstConfEdge = (!selLeg && isDisrupted && g.conflicts && g.conflicts.length > 0)
            ? g.conflicts[0]
            : ((!selLeg && g.rejectedConflicts && g.rejectedConflicts.length > 0) ? g.rejectedConflicts[0] : null);
          if (firstConfEdge != null) {
            for (let li = 0; li < g.legs.length; li++) {
              const l = g.legs[li];
              if (l.segs && l.segs.some(sg => sg.edge === firstConfEdge)) {
                selLegIdx = li;
                selLeg = l;
                const a1 = r.anchors[li];
                const a2 = r.anchors[li + 1];
                fromStop = a1 && a1.t === 'stop' ? this.store.doc.stops[a1.id] : null;
                toStop = a2 && a2.t === 'stop' ? this.store.doc.stops[a2.id] : null;
                break;
              }
            }
          }
          if (!selLeg) {
            selLegIdx = 0;
            selLeg = g.legs[0];
            const a1 = r.anchors[0];
            const a2 = r.anchors[1];
            fromStop = a1 && a1.t === 'stop' ? this.store.doc.stops[a1.id] : null;
            toStop = a2 && a2.t === 'stop' ? this.store.doc.stops[a2.id] : null;
          }
        }

        // Road Name and Red Line status
        let roadName = target.roadName;
        let isRedLine = target.isRedLine;
        let clickedEdge = target.clickedEdge;
        if (!clickedEdge && g && g.constraint && selLegIdx === g.constraint.legIndex) {
          clickedEdge = this.net.edge(g.constraint.edgeId);
          if (!roadName && g.constraint.roadName) roadName = g.constraint.roadName;
        }

        if (!roadName) {
          if (clickedEdge) {
            roadName = clickedEdge.name || ('Road #' + clickedEdge.id);
            isRedLine = this.store.closedSet.has(clickedEdge.id) || !!(this.store.doc.closures && this.store.doc.closures[clickedEdge.id]);
          } else if (selLeg && selLeg.segs && selLeg.segs.length > 0) {
            const closedSeg = selLeg.segs.find(s => this.store.closedSet.has(s.edge) || !!(this.store.doc.closures && this.store.doc.closures[s.edge]));
            const repSeg = closedSeg || selLeg.segs[0];
            const e = this.net.edge(repSeg.edge);
            if (e) {
              roadName = e.name || ('Road #' + e.id);
              isRedLine = !!closedSeg;
              clickedEdge = e;
            }
          } else if (isDisrupted && g && g.conflicts && g.conflicts.length > 0) {
            const e = this.net.edge(g.conflicts[0]);
            if (e) {
              roadName = e.name || ('Road #' + e.id);
              isRedLine = true;
              clickedEdge = e;
            }
          }
        }
        if (!roadName) roadName = 'Main Corridor';
        if (isRedLine === undefined) isRedLine = false;

        const fromStopName = fromStop ? fromStop.name : (selLegIdx >= 0 ? `Stop ${selLegIdx + 1}` : 'Start');
        const toStopName = toStop ? toStop.name : (selLegIdx >= 0 ? `Stop ${selLegIdx + 2}` : 'Next');
        const segDistKm = selLeg && selLeg.ok ? B.fmtKm(selLeg.length) : '—';
        const segTimeMin = selLeg && selLeg.ok ? B.fmtMin(selLeg.time || (selLeg.length / 5.3)) : '—';
        // Only for a real road: a clicked stretch, or the closed road the bus runs on
        if (clickedEdge || target.roadName || selLeg) {
          this._showSegmentPanel(target, roadName, selLeg ? { time: segTimeMin, km: segDistKm, rawLeg: selLeg, fromStopName, toStopName, legIdx: selLegIdx, route: r, clickedEdge } : null);
        }

        // Detour options sit inside the panel: hover previews one on the map, a click keeps it there
        // Review links and archived projects can't be changed, so they show the warning but no detour options
        const detourReadOnly = this._isReadOnlyView();
        const disruptedFraction = this._routeDisruptedFraction(r);
        const rejConflictsCount = (g && g.rejectedConflicts) ? g.rejectedConflicts.length : 0;
        const hasProblem = isDisrupted || hasDetour || (rejConflictsCount > 0) || (disruptedFraction > 0);
        const detourOptions = (!detourReadOnly && (isDisrupted || hasDetour || rejConflictsCount > 0 || hasProblem)) ? this._rankedDetourOptions(r.id) : [];
        const appliedKey = JSON.stringify(r.anchors || []);
        const appliedIdx = hasDetour ? detourOptions.findIndex((opt) => JSON.stringify(opt.anchors) === appliedKey) : -1;
        panel.classList.remove('expanded-detour');

        // The scorecard page: this bus now against every detour option, in the same panel
        if (this.detourScorecardRouteId === r.id && detourOptions.length) {
          this._renderDetourScorecard(content, target, r, g, isDisrupted, detourOptions, appliedIdx);
          return;
        }
        this.detourScorecardRouteId = null;

        const siblingRoutes = Object.values(this.store.doc.routes).filter((x) => String(x.number).trim() === String(r.number).trim());
        const isChunked = siblingRoutes.length > 1;
        const currentChunkIdx = siblingRoutes.findIndex((x) => x.id === r.id);

        const canDivert = active && ((detourOptions.length > 0) || hasDetour);
        const divertReason = !active
          ? 'Route suspended'
          : (disruptedFraction >= 0.99
            ? '100% affected'
            : (rejConflictsCount > 0 ? 'Road constraints' : 'No bypass path'));

        let canCurtail = false;
        let curtailReason = '';
        if (!active) {
          canCurtail = false;
          curtailReason = 'Route suspended';
        } else if (isChunked) {
          canCurtail = true;
        } else if (!r.anchors || r.anchors.length < 3) {
          canCurtail = false;
          curtailReason = 'Fewer than 3 stops';
        } else if (disruptedFraction >= 0.99) {
          canCurtail = false;
          curtailReason = '100% affected';
        } else {
          const areas = Object.values(this.store.doc.areas || {});
          const isStopBlocked = (st) => {
            if (!st || st.active === false) return true;
            if (this.store.closedSet && this.store.closedSet.has(st.edge)) return true;
            if (this.store.affected && this.store.affected.has(st.edge)) return true;
            const p = this.net.posPoint(st, 0.78);
            for (const a of areas) {
              const poly = this.store.areaPoly(a);
              if (poly && B.pointInPoly(p, poly)) return true;
            }
            return false;
          };

          const blockedIdxs = [];
          r.anchors.forEach((a, i) => {
            if (a.t === 'stop') {
              const st = this.store.doc.stops[a.id];
              if (isStopBlocked(st)) blockedIdxs.push(i);
            } else if ((this.store.closedSet && this.store.closedSet.has(a.edge)) || (this.store.affected && this.store.affected.has(a.edge))) {
              blockedIdxs.push(i);
            }
          });

          if (blockedIdxs.length > 0) {
            const cutStart = blockedIdxs[0];
            const cutEnd = blockedIdxs[blockedIdxs.length - 1];
            const s1 = r.anchors.slice(0, cutStart).filter((a) => a.t === 'stop' ? !isStopBlocked(this.store.doc.stops[a.id]) : true);
            const s2 = r.anchors.slice(cutEnd + 1).filter((a) => a.t === 'stop' ? !isStopBlocked(this.store.doc.stops[a.id]) : true);
            if (s1.length >= 1 && s2.length >= 1) {
              canCurtail = true;
            } else {
              canCurtail = false;
              curtailReason = (s1.length === 0 && s2.length === 0) ? 'No clear segment' : 'Single segment only';
            }
          } else {
            canCurtail = (r.anchors.length >= 3);
            if (!canCurtail) curtailReason = 'No cut point';
          }
        }

        const fmtDist = (d) => (d >= 1000 ? (d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m');
        const mrtStopAnchors = (isChunked ? (r.anchors || []).filter((a) => a.t === 'stop') : routeStops);
        const routeStopObjs = (mrtStopAnchors.length ? mrtStopAnchors : (r.anchors || []).filter((a) => a.t === 'stop'))
          .map((a) => this.store.doc.stops[a.id])
          .filter(Boolean);
        const routeRefPts = routeStopObjs.map((st) => ({ pt: this.net.posPoint(st, 0.78), stop: st }));
        if (!routeRefPts.length && g && g.legs) {
          for (const leg of g.legs) {
            for (const pt of (leg.pts || [])) routeRefPts.push({ pt, stop: null });
          }
        }
        const MRT_WALK_DIST = 400;
        const rankedRouteMrts = routeRefPts.length
          ? (this.city.mrtStations || [])
              .map((m) => {
                let bestDist = Infinity;
                let nearStop = null;
                for (const ref of routeRefPts) {
                  const d = Math.hypot(m.x - ref.pt.x, m.y - ref.pt.y);
                  if (d < bestDist) {
                    bestDist = d;
                    nearStop = ref.stop;
                  }
                }
                return { ...m, dist: bestDist, nearStop };
              })
              .sort((a, b) => a.dist - b.dist)
          : [];
        const withinWalkMrts = rankedRouteMrts.filter((m) => m.dist <= MRT_WALK_DIST);
        const displayRouteMrts = withinWalkMrts.length > 0
          ? withinWalkMrts
          : (rankedRouteMrts.length > 0 ? [rankedRouteMrts[0]] : []);

        content.innerHTML = `
          <!-- WHOLE LINE METRICS -->
          <div class="metrics-grid">
            <div class="metric-card">
              <span class="m-val">${wholeTime}${before && drawn ? this._deltaArrow(line.time, before.time, B.fmtMin) : ''}</span>
              <span class="m-lbl">Time Travel</span>
            </div>
            <div class="metric-card">
              <span class="m-val">${wholeDist}${before && drawn ? this._deltaArrow(line.length, before.length, B.fmtKm) : ''}</span>
              <span class="m-lbl">Km (Distance)</span>
            </div>
            <div class="metric-card">
              <span class="m-val">${wholeStops}${before && drawn ? this._deltaArrow(line.stops.length, before.stops) : ''}</span>
              <span class="m-lbl">Stops</span>
            </div>
          </div>

          ${isChunked ? `
            <div class="route-chunks-bar">
              <div class="route-chunks-header">
                <span class="route-chunks-title">Route chunks</span>
                ${!detourReadOnly ? `
                  <button type="button" class="btn-merge-chunks" title="Restore chunks back into 1 continuous route">Restore</button>
                ` : ''}
              </div>

              <!-- Unified Chunk Boxes: each chunk has its own card with origin & destination terminals -->
              <div class="chunk-boxes-list">
                ${siblingRoutes.map((sr, idx) => {
                  const isCurrent = (sr.id === r.id);
                  const isHidden = Boolean(this.hiddenChunkIds && this.hiddenChunkIds.has(sr.id));
                  const anchors = sr.anchors || [];
                  const sLen = anchors.length;
                  const sGeom = this.store.geom[sr.id];
                  const sDist = sGeom && sGeom.length ? B.fmtKm(sGeom.length) : '—';
                  const sName = (sr.name || '').replace(/^Bus\s+\w+\s*·?\s*/i, '');

                  const startStop = anchors.length ? this.store.doc.stops[anchors[0]?.id] : null;
                  const endStop = anchors.length ? this.store.doc.stops[anchors[anchors.length - 1]?.id] : null;

                  // Use nearest operational stop as reference point to compute accurate distances to terminals
                  const refStartStop = (anchors.length > 1 && B.isInterchange(startStop))
                    ? this.store.doc.stops[anchors[1]?.id] || startStop
                    : startStop;
                  const refEndStop = (anchors.length > 1 && B.isInterchange(endStop))
                    ? this.store.doc.stops[anchors[anchors.length - 2]?.id] || endStop
                    : endStop;

                  const rankedOrigin = this._rankedInterchangesNear(refStartStop);
                  const rankedDest = this._rankedInterchangesNear(refEndStop);

                  const currentOriginId = (startStop && B.isInterchange(startStop) ? startStop.id : null) || sr.originTerminalId || (rankedOrigin[0] && rankedOrigin[0].stop.id);
                  const currentDestId = (endStop && B.isInterchange(endStop) ? endStop.id : null) || sr.destTerminalId || (rankedDest[0] && rankedDest[0].stop.id);

                  return `
                    <div class="chunk-box ${isCurrent ? 'active' : ''} ${isHidden ? 'is-chunk-hidden' : ''}" data-route-id="${B.esc(sr.id)}">
                      <div class="chunk-box-header" title="Select Chunk ${idx + 1} on map">
                        <div class="chunk-box-info">
                          <span class="chunk-badge">Chunk ${idx + 1}</span>
                          <span class="chunk-name">${B.esc(sName || `Chunk ${idx + 1}`)}</span>
                        </div>
                        <div class="chunk-box-right">
                          <span class="chunk-stat">${sLen} stops · ${sDist}</span>
                          <button type="button" class="btn-chunk-toggle-vis ${isHidden ? 'is-hidden' : ''}" data-route-id="${B.esc(sr.id)}" title="${isHidden ? 'Show chunk on map' : 'Hide chunk on map'}" aria-label="${isHidden ? 'Show chunk on map' : 'Hide chunk on map'}">
                            ${isHidden ? `
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                            ` : `
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                            `}
                          </button>
                          ${!detourReadOnly ? `
                            <button type="button" class="btn-chunk-delete" data-route-id="${B.esc(sr.id)}" data-chunk-label="Chunk ${idx + 1}" title="Delete chunk" aria-label="Delete Chunk ${idx + 1}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
                          ` : ''}
                        </div>
                      </div>

                      <div class="chunk-box-body">
                        <!-- Origin Terminal Selection -->
                        <div class="chunk-term-row">
                          <span class="chunk-term-label">Origin:</span>
                          ${!detourReadOnly ? `
                            <select class="chunk-terminal-select" data-route-id="${B.esc(sr.id)}" data-terminal-end="origin" title="Select origin bus terminal">
                              ${rankedOrigin.map((item, i) => {
                                const isNearest = (i === 0);
                                const distStr = B.fmtKm(item.dist);
                                const cleanName = B.esc(item.stop.name.replace(/\s+Int$/i, ' Interchange').replace(/\s+Ter$/i, ' Terminal'));
                                const isSel = (item.stop.id === currentOriginId);
                                return `<option value="${item.stop.id}" ${isSel ? 'selected' : ''}>${cleanName} (${distStr}${isNearest ? ' · Nearest' : ''})</option>`;
                              }).join('')}
                            </select>
                          ` : `
                            <span class="chunk-term-val">${B.esc((this.store.doc.stops[currentOriginId] || {}).name || 'Interchange')}</span>
                          `}
                        </div>

                        <!-- Destination Terminal Selection -->
                        <div class="chunk-term-row">
                          <span class="chunk-term-label">Destination:</span>
                          ${!detourReadOnly ? `
                            <select class="chunk-terminal-select" data-route-id="${B.esc(sr.id)}" data-terminal-end="dest" title="Select destination bus terminal">
                              ${rankedDest.map((item, i) => {
                                const isNearest = (i === 0);
                                const distStr = B.fmtKm(item.dist);
                                const cleanName = B.esc(item.stop.name.replace(/\s+Int$/i, ' Interchange').replace(/\s+Ter$/i, ' Terminal'));
                                const isSel = (item.stop.id === currentDestId);
                                return `<option value="${item.stop.id}" ${isSel ? 'selected' : ''}>${cleanName} (${distStr}${isNearest ? ' · Nearest' : ''})</option>`;
                              }).join('')}
                            </select>
                          ` : `
                            <span class="chunk-term-val">${B.esc((this.store.doc.stops[currentDestId] || {}).name || 'Interchange')}</span>
                          `}
                        </div>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>
          ` : ''}

          <!-- SECTION 1: WHOLE LINE BASIC INFO -->
          <div class="panel-section">
            <div class="prop-row">
              <span class="prop-label">Bus Number</span>
              <span class="prop-val bold" style="display: inline-flex; align-items: center; justify-content: flex-end;">
                <span class="modal-route-badge" style="background: ${r.color || '#2563eb'}; font-size: 13px; font-weight: 800; padding: 4px 11px; border-radius: 6px; box-shadow: 0 1px 2px rgba(0,0,0,0.2);">
                  ${r.number}
                </span>
                ${isChunked ? `<span class="prop-chunk-tag">Chunk ${currentChunkIdx + 1} of ${siblingRoutes.length}</span>` : ''}
              </span>
            </div>
            <div class="prop-row">
              <span class="prop-label">Bus model</span>
              <span class="prop-val bold">${B.esc(B.busModel(this.store.doc, r.number))}</span>
            </div>
            <div class="prop-row ${active ? '' : 'is-inactive'}">
              <span class="prop-label">Number of buses</span>
              <span class="prop-val bold">${fleetNow}${before ? this._deltaArrow(fleetNow, before.fleet) : ''}</span>
            </div>
            <div class="prop-col">
              <span class="prop-label">Route</span>
              <span class="prop-val bold" style="font-size: 12px; line-height: 1.35; color: #1e293b; text-align: left; margin-left: 0;">${B.esc(r.name)}</span>
            </div>
            <div class="prop-row">
              <span class="prop-label">Interchanges</span>
              <span class="prop-val bold">
                ${(() => {
                  const ri = B.getRouteInterchanges ? B.getRouteInterchanges(this.store.doc, r) : null;
                  if (!ri || !ri.origin) return '<span class="text-muted">—</span>';
                  if (ri.isRoundTrip) return `Round Trip (${B.esc(ri.origin.name)})`;
                  if (ri.isInterTown) return `${B.esc(ri.origin.name)} ➔ ${B.esc(ri.dest.name)}`;
                  if (ri.isOriginInt) return `From ${B.esc(ri.origin.name)}`;
                  return 'Non-interchange terminal';
                })()}
              </span>
            </div>
            <div class="prop-row">
              <span class="prop-label">Status</span>
              <span class="prop-val bold bus-status ${active ? '' : 'is-off'}">${active ? 'Active' : 'Suspended'}</span>
            </div>
            <div class="prop-row ${active ? '' : 'is-inactive'}">
              <span class="prop-label">Operating hours</span>
              <span class="prop-val bold">${B.esc(hours.start)} – ${B.esc(hours.end)}</span>
            </div>
            <div class="prop-row ${active ? '' : 'is-inactive'}">
              <span class="prop-label">Operating days</span>
              ${this._dayDotsHtml(days)}
            </div>

            <div class="prop-row ${active ? '' : 'is-inactive'}" style="align-items: flex-start;">
              <span class="prop-label" style="padding-top: 2px;">Nearest MRT</span>
              <div class="prop-val" style="display: flex; flex-direction: column; gap: 3px; align-items: flex-end; text-align: right; max-width: 205px; max-height: 78px; overflow-y: auto;">
                ${displayRouteMrts.length > 0 ? displayRouteMrts.map((m) => {
                  const mName = m.name.toLowerCase().includes('mrt') ? m.name : m.name + ' MRT';
                  const mCode = m.code ? ` [${m.code}]` : '';
                  const nearHint = m.nearStop ? ` (near ${m.nearStop.name})` : '';
                  return `
                    <span class="mrt-chip-link" data-mrt-id="${m.id}" style="cursor: pointer; color: var(--text-main); font-weight: 600; font-size: 12px; transition: color 0.15s ease;" title="View ${B.esc(mName)}${B.esc(mCode)}${B.esc(nearHint)}">
                      ${B.esc(mName)}${B.esc(mCode)} · ${fmtDist(m.dist)}
                    </span>
                  `;
                }).join('') : `<span class="text-muted" style="font-size: 12px; font-style: italic;">None</span>`}
              </div>
            </div>
          </div>

          <!-- SECTION 2B: DISRUPTION RESOLUTION (3 CASES: 1. DIVERT, 2. CURTAILED, 3. SUSPEND) -->
          ${(hasProblem || !active) && !detourReadOnly ? `
            <div class="panel-section route-problem-box">
              <div class="problem-box-header">
                <div class="problem-box-title">
                  ${B.AI_ICON || ''}
                  <span>Disruption Resolution</span>
                </div>
                ${!active ? '<span class="problem-pct-badge is-suspended">Suspended</span>' : (disruptedFraction > 0 ? `<span class="problem-pct-badge">${Math.round(disruptedFraction * 100)}% affected</span>` : '')}
              </div>
              <div class="problem-actions-list">
                <button type="button" class="btn-problem-action btn-proceed-divert ${!canDivert ? 'is-disabled' : ''}" ${!canDivert ? 'disabled' : ''} data-route-id="${B.esc(r.id)}" title="${!canDivert ? `Disabled: ${divertReason}` : 'View divert bypass options'}">
                  Divert
                </button>
                <button type="button" class="btn-problem-action btn-proceed-curtail ${!canCurtail ? 'is-disabled' : ''}" ${!canCurtail ? 'disabled' : ''} data-route-id="${B.esc(r.id)}" title="${!canCurtail ? `Disabled: ${curtailReason}` : 'Cut into operational chunks jointed with bus terminals'}">
                  Curtail
                </button>
                ${!active ? `
                  <button type="button" class="btn-problem-action is-disabled" disabled title="Disabled: Already suspended">
                    Suspend
                  </button>
                  <button type="button" class="btn-problem-action btn-proceed-suspend btn-reactivate-red" data-bus-number="${B.esc(r.number)}" data-action="reactivate" title="Reactivate bus service">
                    Reactivate Route
                  </button>
                ` : `
                  <button type="button" class="btn-problem-action btn-proceed-suspend" data-bus-number="${B.esc(r.number)}" data-action="suspend" title="Suspend bus service">
                    Suspend
                  </button>
                `}
              </div>
            </div>
          ` : ''}

          <!-- What the documents suggest for this bus -->
          ${this._docNotesHtml(r)}

          <!-- SECTION 3B: ROUTE SEGMENTS & ROAD CONSTRAINTS -->
          ${this._renderRouteSegmentsConstraintsHtml(r, g, selLegIdx)}

          <!-- SECTION 4: ALL STOPS (CONCISE COLLAPSIBLE) -->
          <div class="panel-section" style="margin-top: 2px;">
            <details class="route-stops-details">
              <summary class="route-section-summary">
                <span>All stops (${routeStops.length})</span>
                <svg class="route-stops-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
              </summary>
              <div class="route-stops-flow" style="margin-top: 8px; display: flex; flex-direction: column; gap: 4px; max-height: 160px; overflow-y: auto; padding-right: 4px;">
                ${routeStops.map((a, idx) => {
                  const st = this.store.doc.stops[a.id] || null;
                  const name = st ? st.name : `Stop ${idx + 1}`;
                  const code = st && st.code ? `[${st.code}]` : '';
                  const { isStart, isEnd } = a;
                  const dotColor = isStart ? '#10b981' : (isEnd ? '#ef4444' : (r.color || '#2563eb'));
                  return `
                    <div class="route-stop-item-row" style="display: flex; align-items: center; gap: 6px; font-size: 11px; color: #1e293b; padding: 3px 0; flex-wrap: wrap;">
                      <span style="display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: ${dotColor}; flex-shrink: 0;"></span>
                      <span style="font-weight: ${isStart || isEnd ? '700' : '500'};">${idx + 1}. ${B.esc(name)} <span style="font-family: monospace; font-size: 9.5px; color: #64748b;">${code}</span></span>
                      <span class="stop-commuters" title="About ${st ? this._stopCommuters(st.id) : 0} commuters a day (estimate)">${st ? this._formatCommuters(this._stopCommuters(st.id)) : ''}</span>
                      ${isStart ? '<span class="tag" style="font-size: 8.5px; padding: 1px 4px; background: #dcfce7; color: #15803d;">Origin</span>' : ''}
                      ${isEnd ? '<span class="tag" style="font-size: 8.5px; padding: 1px 4px; background: #fee2e2; color: #b91c1c;">Terminal</span>' : ''}
                    </div>
                  `;
                }).join('') || '<span class="text-muted">No stops defined</span>'}
              </div>
            </details>
          </div>

        `;

        // Pencil in the header: on a draft in edit mode it opens Edit bus (number, active, hours, days, model,
        // delete); on the Current Map or in view mode it's locked
        const btnEdit = document.getElementById('btn-edit-inspector');
        if (btnEdit && !this._isReadOnlyView() && !this._isCreatingRoute()) {
          const lock = this._pencilLock();
          btnEdit.hidden = false;
          btnEdit.classList.toggle('is-disabled', !!lock);
          btnEdit.title = lock ? lock.title : `Edit Bus ${r.number}`;
          btnEdit.setAttribute('aria-label', `Edit Bus ${r.number}`);
          btnEdit.onclick = () => (lock ? lock.note() : this._promptNewBus(r.number));
        }

        const btnCompare = content.querySelector('.btn-detour-compare');
        if (btnCompare) {
          btnCompare.addEventListener('click', (e) => {
            e.stopPropagation();
            this._ensureEditableForRoute();
            this.detourScorecardRouteId = r.id;
            const updatedObj = this.store.doc.routes[r.id] || target.obj;
            target.obj = updatedObj;
            if (this.renderer.selected && this.renderer.selected.id === r.id) {
              this.renderer.selected.obj = updatedObj;
            }
            this._showInspector(target);
          });
        }

        // Case 1: Divert
        const btnDivert = content.querySelector('.btn-proceed-divert');
        if (btnDivert) {
          btnDivert.addEventListener('click', (e) => {
            e.stopPropagation();
            if (btnDivert.disabled || !canDivert) return;
            this._ensureEditableForRoute();
            const opts = detourOptions.length ? detourOptions : this._rankedDetourOptions(r.id);
            if (opts.length) {
              this.detourScorecardRouteId = r.id;
              const updatedObj = this.store.doc.routes[r.id] || target.obj;
            target.obj = updatedObj;
            if (this.renderer.selected && this.renderer.selected.id === r.id) {
              this.renderer.selected.obj = updatedObj;
            }
            this._showInspector(target);
            } else if (rejConflictsCount > 0) {
              const btnReroute = content.querySelector('.btn-constraint-reroute');
              if (btnReroute) btnReroute.click();
              else this._rerouteRejectedConflicts(r.id);
            } else {
              this._showToast('No alternative bypass found for detour', 'warn');
            }
          });
        }

        // Case 2: Curtailed / Cut into chunks
        const btnCurtail = content.querySelector('.btn-proceed-curtail');
        if (btnCurtail) {
          btnCurtail.addEventListener('click', (e) => {
            e.stopPropagation();
            if (btnCurtail.disabled || !canCurtail) return;
            if (isChunked) {
              const firstChunk = siblingRoutes[0];
              if (firstChunk) {
                this.renderer.selected = { type: 'route', id: firstChunk.id, obj: firstChunk };
                this.renderer.requestRender();
                this._showInspector(this.renderer.selected);
              }
            } else {
              this._cutRouteIntoChunks(r.id, null, { manualEdit: false });
            }
          });
        }

        // Case 2B: Manually Edit (Fragmented cut without terminal jointing)
        const btnManualCut = content.querySelector('.btn-proceed-manual-cut');
        if (btnManualCut) {
          btnManualCut.addEventListener('click', (e) => {
            e.stopPropagation();
            if (btnManualCut.disabled || !canCurtail) return;
            this._cutRouteIntoChunks(r.id, null, { manualEdit: true });
          });
        }

        // Case 3: Suspend
        const btnSuspend = content.querySelector('.btn-proceed-suspend');
        if (btnSuspend) {
          btnSuspend.addEventListener('click', (e) => {
            e.stopPropagation();
            this._ensureEditableForRoute();
            const busNum = btnSuspend.dataset.busNumber;
            const shouldSuspend = btnSuspend.dataset.action === 'suspend';
            this.store.commit(`${shouldSuspend ? 'Suspend' : 'Reactivate'} Bus ${busNum}`, (doc) => {
              for (const rObj of Object.values(doc.routes || {})) {
                if (String(rObj.number).trim() === String(busNum).trim()) {
                  rObj.active = !shouldSuspend;
                }
              }
            });
            this._showToast(`Bus ${busNum} ${shouldSuspend ? 'suspended' : 'reactivated'}`, 'success');
            this.renderer.requestRender();
            if (this._updateFilterCounts) this._updateFilterCounts();
            if (this._updateRouteDropdown) this._updateRouteDropdown();
            const updatedObj = this.store.doc.routes[r.id] || target.obj;
            target.obj = updatedObj;
            if (this.renderer.selected && this.renderer.selected.id === r.id) {
              this.renderer.selected.obj = updatedObj;
            }
            this._showInspector(target);
          });
        }

        const btnSuspendToggle = content.querySelector('.btn-ai-toggle-suspend');
        if (btnSuspendToggle) {
          btnSuspendToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            this._ensureEditableForRoute();
            const busNum = btnSuspendToggle.dataset.busNumber;
            const shouldSuspend = btnSuspendToggle.dataset.action === 'suspend';
            this.store.commit(`${shouldSuspend ? 'Suspend' : 'Reactivate'} Bus ${busNum}`, (doc) => {
              for (const rObj of Object.values(doc.routes || {})) {
                if (String(rObj.number).trim() === String(busNum).trim()) {
                  rObj.active = !shouldSuspend;
                }
              }
            });
            this._showToast(`Bus ${busNum} ${shouldSuspend ? 'suspended' : 'reactivated'}`, 'success');
            this.renderer.requestRender();
            if (this._updateFilterCounts) this._updateFilterCounts();
            if (this._updateRouteDropdown) this._updateRouteDropdown();
            const updatedObj = this.store.doc.routes[r.id] || target.obj;
            target.obj = updatedObj;
            if (this.renderer.selected && this.renderer.selected.id === r.id) {
              this.renderer.selected.obj = updatedObj;
            }
            this._showInspector(target);
          });
        }

        // Chunk box selection: hover or focus to highlight on map, click to select & fit
        content.querySelectorAll('.chunk-box').forEach((box) => {
          const rid = box.dataset.routeId;
          box.addEventListener('mouseenter', () => {
            this.renderer.hoveredChunkId = rid;
            this.renderer.requestRender();
          });
          box.addEventListener('mouseleave', () => {
            if (this.renderer.hoveredChunkId === rid) {
              this.renderer.hoveredChunkId = null;
              this.renderer.requestRender();
            }
          });
          box.addEventListener('focusin', () => {
            this.renderer.focusedChunkId = rid;
            this.renderer.requestRender();
          });
          box.addEventListener('focusout', () => {
            if (this.renderer.focusedChunkId === rid) {
              this.renderer.focusedChunkId = null;
              this.renderer.requestRender();
            }
          });
          box.addEventListener('click', (e) => {
            if (e.target.closest('select') || e.target.closest('.btn-chunk-toggle-vis')) return;
            e.stopPropagation();
            if (this.hiddenChunkIds && this.hiddenChunkIds.has(rid)) {
              this.hiddenChunkIds.delete(rid);
              this.renderer.hiddenChunkIds = this.hiddenChunkIds;
            }
            const targetRoute = this.store.doc.routes[rid];
            if (targetRoute) {
              this.renderer.selected = { type: 'route', id: rid, obj: targetRoute };
              this.renderer.hoveredChunkId = null;
              this.renderer.focusedChunkId = rid;
              this._focusOnRoute(targetRoute);
              this.renderer.requestRender();
              this._showInspector(this.renderer.selected);
            }
          });
        });

        // Toggle chunk visibility on map
        content.querySelectorAll('.btn-chunk-toggle-vis').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const chunkId = btn.dataset.routeId;
            if (!chunkId) return;
            if (!this.hiddenChunkIds) this.hiddenChunkIds = new Set();
            if (this.hiddenChunkIds.has(chunkId)) {
              this.hiddenChunkIds.delete(chunkId);
            } else {
              this.hiddenChunkIds.add(chunkId);
            }
            this.renderer.hiddenChunkIds = this.hiddenChunkIds;
            this.renderer.requestRender();
            this._showInspector(target);
          });
        });

        // Delete one chunk, after asking
        content.querySelectorAll('.btn-chunk-delete').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const remove = () => this._deleteBusChunk(btn.dataset.routeId);
            if (B.askConfirm) B.askConfirm(`Delete ${btn.dataset.chunkLabel}?`, `Bus ${r.number} keeps its other chunks.`, remove);
            else remove();
          });
        });

        // Restore chunks back into 1 route
        const btnMerge = content.querySelector('.btn-merge-chunks');
        if (btnMerge) {
          btnMerge.addEventListener('click', (e) => {
            e.stopPropagation();
            this._mergeBusChunks(r.number);
          });
        }

        // Change chunk origin or destination terminal
        content.querySelectorAll('.chunk-terminal-select').forEach((sel) => {
          sel.addEventListener('change', (e) => {
            e.stopPropagation();
            this._setChunkTerminal(sel.dataset.routeId, sel.dataset.terminalEnd, sel.value);
          });
        });

        // Cut route at closure into 2 operating chunks
        const btnCutClosure = content.querySelector('.btn-cut-at-closure');
        if (btnCutClosure) {
          btnCutClosure.addEventListener('click', (e) => {
            e.stopPropagation();
            this._cutRouteIntoChunks(btnCutClosure.dataset.routeId);
          });
        }

        content.querySelectorAll('.mrt-chip-link').forEach((chip) => {
          const mid = chip.dataset.mrtId;
          chip.addEventListener('click', (e) => {
            e.stopPropagation();
            const m = (this.city.mrtStations || []).find((x) => x.id === mid);
            if (m) {
              this.renderer.selected = { type: 'mrt', id: mid, obj: m, fromAreaFilter: target.fromAreaFilter };
              this._showInspector(this.renderer.selected);
              this._focusSelectedTarget(this.renderer.selected);
              this.renderer.requestRender();
            }
          });
        });

        this._bindConstraintEvents(content, r);

      } else if (target.type === 'area') {
        const a = this.store.doc.areas[target.id];
        if (!a) return;
        const edgeIds = this.store.areaEdges[a.id] || [];

        content.innerHTML = `
          <div class="panel-section">
            <div class="section-title">AFFECTED AREA INSPECTOR</div>
            <div class="prop-row">
              <span class="prop-label">Area ID</span>
              <span class="prop-val mono">${a.id}</span>
            </div>
            <div class="prop-row">
              <span class="prop-label">Intersecting Roads</span>
              <span class="prop-val bold">${edgeIds.length} segments</span>
            </div>
          </div>

          ${this.mode !== 'view' ? `
            <div class="panel-section">
              <p class="text-subtle" style="margin-top: 0;">You can drag the circular handles to resize, reshape, create angles, or move the area.</p>
              <button id="btn-close-intersecting" class="btn-danger-action">
                🚫 Close All Intersecting Roads (${edgeIds.length})
              </button>
            </div>

            <div class="panel-actions">
              <button id="btn-del-area" class="btn-danger">Delete Affected Area</button>
            </div>
          ` : ''}
        `;

        const btnCloseIntersecting = document.getElementById('btn-close-intersecting');
        if (btnCloseIntersecting) {
          btnCloseIntersecting.addEventListener('click', () => {
            this.store.commit('Close intersecting roads', (doc) => {
              B.ops.setClosed(doc, edgeIds, true, { reason: `Closed by ${a.name}`, areaId: a.id });
            });
            this._showToast(`${edgeIds.length} roads closed`, 'warn');
            this._updateUIState();
          });
        }

        const btnDelArea = document.getElementById('btn-del-area');
        if (btnDelArea) {
          btnDelArea.addEventListener('click', () => {
            this._deleteSelected();
          });
        }
      } else if (target.type === 'closure') {
        const e = this.net.edge(target.id);
        if (!e) return;
        const isClosed = !!this.store.doc.closures[target.id];
        const routesUsing = typeof this.store.routesUsingEdge === 'function' ? this.store.routesUsingEdge(target.id) : [];

        content.innerHTML = `
          <div class="panel-section">
            <div class="section-title">ROAD SEGMENT INSPECTOR</div>
            <div class="prop-row">
              <span class="prop-label">Road Name</span>
              <span class="prop-val bold">${e.name}</span>
            </div>
            <div class="prop-row">
              <span class="prop-label">Classification</span>
              <span class="prop-val">${e.cls === 'major' ? 'Major Arterial (Dual 2-Lane)' : 'Collector Street'}</span>
            </div>
            <div class="prop-row">
              <span class="prop-label">Length</span>
              <span class="prop-val">${Math.round(e.len)} m</span>
            </div>
            <div class="prop-row">
              <span class="prop-label">Status</span>
              <span class="tag ${isClosed ? 'tag-disrupted' : 'tag-ok'}">
                ${isClosed ? 'CLOSED' : 'OPEN & CLEAR'}
              </span>
            </div>
          </div>

          <div class="panel-section">
            <div class="section-title">BUS NUMBERS USING THIS ROAD</div>
            <div class="route-chips">
              ${routesUsing.map((r) => `<span class="route-badge" data-rid="${r.id}" style="background: ${r.color || '#2563eb'}; color: #ffffff; border-radius: 6px; font-weight: 800; padding: 3px 9px; cursor: pointer;" title="View Bus ${B.esc(r.number)}">${r.number}</span>`).join('') || '<span class="text-muted">None</span>'}
            </div>
          </div>

          ${(() => {
            const roadConsts = this.store.legConstraints(null, target.id);
            const firstUsingRoute = routesUsing.length ? routesUsing[0] : null;
            if (!roadConsts.length) return '';
            return `
              <div class="panel-section">
                <div class="prop-label" style="margin-bottom: 4px;">Constraints</div>
                <div class="route-seg-constraints-list">
                  ${roadConsts.map((c) => this._renderConstraintItemHtml(c, firstUsingRoute, { hideRoad: true })).join('')}
                </div>
              </div>
            `;
          })()}

          ${this.mode !== 'view' ? `
            <div class="panel-actions">
              <button id="btn-toggle-closure" class="${isClosed ? 'btn-success' : 'btn-danger'}">
                ${isClosed ? 'Reopen Road Segment' : 'Mark Road as Closed'}
              </button>
            </div>
          ` : ''}
        `;

        const btnToggleClosure = document.getElementById('btn-toggle-closure');
        if (btnToggleClosure) {
          btnToggleClosure.addEventListener('click', () => {
            this.store.commit('Toggle road closure', (doc) => {
              B.ops.setClosed(doc, [target.id], !isClosed, { reason: 'Planner override' });
            });
            this._showToast(`${e.name} ${!isClosed ? 'closed' : 'reopened'}`, !isClosed ? 'warn' : 'info');
            this._showInspector(target);
            this.renderer.requestRender();
          });
        }
        if (routesUsing.length) {
          this._bindConstraintEvents(content, routesUsing[0]);
          content.querySelectorAll('.route-badge[data-rid]').forEach((badge) => {
            const rid = badge.dataset.rid;
            badge.addEventListener('click', () => {
              this.renderer.selected = { type: 'route', id: rid, obj: this.store.doc.routes[rid] };
              this._showInspector(this.renderer.selected);
              this.renderer.requestRender();
            });
          });
        }
      } else if (target.type === 'area-filter') {
        const polygon = this.areaFilterPolygon;
        const passing = this.areaFilterPassingRoutes || [];

        // 1. Bus stops & terminals inside the polygon
        const stopsInside = [];
        const terminalsInside = [];
        for (const st of Object.values(this.store.doc.stops || {})) {
          const pt = this.net.posPoint(st, 0.78);
          if (polygon && B.pointInPoly(pt, polygon)) {
            const served = (this.store.stopLines && this.store.stopLines[st.id]) || [];
            const stItem = { ...st, servedRouteIds: served, pt };
            if (B.isInterchange(st)) {
              terminalsInside.push(stItem);
            } else {
              stopsInside.push(stItem);
            }
          }
        }

        // 2. MRT stations inside polygon
        const mrtInside = (this.city.mrtStations || []).filter((m) => polygon && B.pointInPoly({ x: m.x, y: m.y }, polygon));

        // 3. Roads intersecting polygon
        const edgeIds = (polygon && this.net.edgesInPolygon(polygon)) || [];
        const seenRoadNames = new Set();
        const roadsInside = [];
        for (const eid of edgeIds) {
          const e = this.net.edge(eid);
          if (e && e.name && !seenRoadNames.has(e.name)) {
            seenRoadNames.add(e.name);
            const rCount = this._busesOnEdges(new Set([e.id])).length;
            roadsInside.push({ ...e, busesCount: rCount });
          }
        }

        // 4. Affected areas & road closures inside / overlapping polygon
        const affectedInside = [];
        for (const a of Object.values(this.store.doc.areas || {})) {
          if (this._doesAreaOverlapPoly(a, polygon)) {
            affectedInside.push({ type: 'area', id: a.id, name: a.name || 'Affected Area', obj: a });
          }
        }
        for (const [eid, cl] of Object.entries(this.store.doc.closures || {})) {
          if (edgeIds.includes(Number(eid))) {
            const e = this.net.edge(Number(eid));
            affectedInside.push({ type: 'closure', id: Number(eid), name: (e && e.name) ? `Closure: ${e.name}` : `Closure on road #${eid}`, obj: cl });
          }
        }
        for (const fo of (this._foreignObstacles || [])) {
          if (fo.poly && fo.poly.some((p) => B.pointInPoly(p, polygon))) {
            affectedInside.push({ type: 'foreign-project', id: fo.projectId, name: `${fo.projectName || 'Project'} Disruption`, project: fo.project });
          }
        }

        const totalCount = passing.length + stopsInside.length + terminalsInside.length + mrtInside.length + roadsInside.length + affectedInside.length;

        content.innerHTML = `
          <div class="panel-section area-selection-head-section">
            <div class="section-title" style="display: flex; align-items: center; justify-content: space-between; text-transform: none; font-size: 13px; font-weight: 800; color: #0284c7;">
              <span style="display: inline-flex; align-items: center; gap: 5px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 3 20 7.5 20 16.5 12 21 4 16.5 4 7.5 12 3"></polygon></svg>
                <span>Selected Area Entities</span>
              </span>
              <span class="tag" style="background: #e0f2fe; color: #0284c7; font-weight: 800; font-size: 11px; padding: 2px 7px; border-radius: 999px;">${totalCount} Found</span>
            </div>

            <!-- Category Filter Tabs -->
            <div class="area-selection-tabs" role="tablist" style="display: flex; gap: 4px; flex-wrap: wrap; margin-top: 10px;">
              <button type="button" class="as-tab active" data-tab="all">All (${totalCount})</button>
              ${passing.length ? `<button type="button" class="as-tab" data-tab="bus">Bus (${passing.length})</button>` : ''}
              ${stopsInside.length ? `<button type="button" class="as-tab" data-tab="stop">Stops (${stopsInside.length})</button>` : ''}
              ${terminalsInside.length ? `<button type="button" class="as-tab" data-tab="terminal">Terminals (${terminalsInside.length})</button>` : ''}
              ${mrtInside.length ? `<button type="button" class="as-tab" data-tab="mrt">MRT (${mrtInside.length})</button>` : ''}
              ${roadsInside.length ? `<button type="button" class="as-tab" data-tab="road">Roads (${roadsInside.length})</button>` : ''}
              ${affectedInside.length ? `<button type="button" class="as-tab" data-tab="area">Areas (${affectedInside.length})</button>` : ''}
            </div>
          </div>

          <!-- Master Selection List Container -->
          <div class="area-selection-cards-list" style="max-height: 420px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; padding: 4px 1px 8px;">
            ${totalCount === 0 ? `
              <div style="padding: 24px 12px; text-align: center; color: #94a3b8; font-size: 12.5px; font-style: italic;">
                No entities found inside this area polygon.
              </div>
            ` : ''}

            <!-- 1. Bus Routes -->
            ${passing.map((item) => {
              const r = item.route;
              const isAffected = this.isRouteAffected(r);
              const bg = r.color || '#2563eb';
              return `
                <div class="as-card" data-cat="bus" data-sel-type="route" data-sel-id="${r.id}" style="display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; background: #ffffff; border: 1.5px solid #e2e8f0; border-radius: 8px; cursor: pointer; transition: all 0.15s ease;">
                  <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
                    <span style="background: ${bg}; color: #ffffff; font-weight: 800; font-size: 12px; padding: 3px 8px; border-radius: 5px; flex-shrink: 0;">
                      ${r.number}
                    </span>
                    <div style="min-width: 0;">
                      <div style="font-weight: 700; font-size: 12px; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${B.esc(r.name || `Bus ${r.number}`)}</div>
                      <div style="font-size: 11px; color: #64748b;">${item.stopsInside} stops inside area</div>
                    </div>
                  </div>
                  <div style="display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0;">
                    ${isAffected ? '<span class="tag tag-disrupted" style="font-size: 10px; padding: 2px 6px;">Closure</span>' : '<span style="font-size: 11px; color: #10b981; font-weight: 700;">✓ Active</span>'}
                    <span style="color: #94a3b8; font-size: 13px;">➔</span>
                  </div>
                </div>
              `;
            }).join('')}

            <!-- 2. Bus Terminals / Interchanges -->
            ${terminalsInside.map((t) => `
              <div class="as-card" data-cat="terminal" data-sel-type="stop" data-sel-id="${t.id}" style="display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; background: #eff6ff; border: 1.5px solid #bfdbfe; border-radius: 8px; cursor: pointer; transition: all 0.15s ease;">
                <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
                  <span style="background: #1e40af; color: #ffffff; font-weight: 800; font-size: 11px; padding: 3px 6px; border-radius: 5px; flex-shrink: 0;">INT</span>
                  <div style="min-width: 0;">
                    <div style="font-weight: 800; font-size: 12.5px; color: #1e3a8a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${B.esc(t.name)}</div>
                    <div style="font-size: 11px; color: #2563eb;">Bus Interchange · ${t.servedRouteIds ? t.servedRouteIds.length : 0} lines</div>
                  </div>
                </div>
                <span style="color: #1e40af; font-size: 13px; flex-shrink: 0;">➔</span>
              </div>
            `).join('')}

            <!-- 3. Bus Stops -->
            ${stopsInside.map((s) => `
              <div class="as-card" data-cat="stop" data-sel-type="stop" data-sel-id="${s.id}" style="display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 10px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 7px; cursor: pointer; transition: all 0.15s ease;">
                <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
                  <span style="background: #e0f2fe; color: #0369a1; font-weight: 800; font-size: 10px; padding: 2px 5px; border-radius: 4px; flex-shrink: 0;">Stop</span>
                  <div style="min-width: 0;">
                    <div style="font-weight: 600; font-size: 12px; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${B.esc(s.name)}</div>
                    <div style="font-size: 10.5px; color: #64748b;">Stop [${s.code || s.id}] · ${s.servedRouteIds ? s.servedRouteIds.length : 0} buses</div>
                  </div>
                </div>
                <span style="color: #94a3b8; font-size: 13px; flex-shrink: 0;">➔</span>
              </div>
            `).join('')}

            <!-- 4. MRT Stations -->
            ${mrtInside.map((m) => `
              <div class="as-card" data-cat="mrt" data-sel-type="mrt" data-sel-id="${m.id}" style="display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; background: #f0fdf4; border: 1.5px solid #bbf7d0; border-radius: 8px; cursor: pointer; transition: all 0.15s ease;">
                <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
                  <span style="background: #15803d; color: #ffffff; font-weight: 800; font-size: 11px; padding: 3px 6px; border-radius: 5px; flex-shrink: 0;">${B.esc(m.code || 'MRT')}</span>
                  <div style="min-width: 0;">
                    <div style="font-weight: 800; font-size: 12.5px; color: #14532d; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${B.esc(m.name)} MRT</div>
                    <div style="font-size: 11px; color: #166534;">MRT Station [${B.esc(m.code || m.id)}]</div>
                  </div>
                </div>
                <span style="color: #15803d; font-size: 13px; flex-shrink: 0;">➔</span>
              </div>
            `).join('')}

            <!-- 5. Road Segments -->
            ${roadsInside.map((rd) => `
              <div class="as-card" data-cat="road" data-sel-type="road" data-sel-id="${rd.id}" style="display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 10px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 7px; cursor: pointer; transition: all 0.15s ease;">
                <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
                  <span style="background: #f1f5f9; color: #475569; font-weight: 800; font-size: 10px; padding: 2px 5px; border-radius: 4px; flex-shrink: 0;">Road</span>
                  <div style="min-width: 0;">
                    <div style="font-weight: 700; font-size: 12px; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${B.esc(rd.name)}</div>
                    <div style="font-size: 10.5px; color: #64748b;">${Math.round(rd.len)} m · ${rd.busesCount || 0} buses operating</div>
                  </div>
                </div>
                <span style="color: #94a3b8; font-size: 13px; flex-shrink: 0;">➔</span>
              </div>
            `).join('')}

            <!-- 6. Affected Areas & Closures -->
            ${affectedInside.map((af) => `
              <div class="as-card" data-cat="area" data-sel-type="${af.type}" data-sel-id="${af.id}" style="display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; background: #fef2f2; border: 1.5px solid #fecaca; border-radius: 8px; cursor: pointer; transition: all 0.15s ease;">
                <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
                  <span style="background: #dc2626; color: #ffffff; font-weight: 800; font-size: 11px; padding: 2px 6px; border-radius: 5px; flex-shrink: 0;">!</span>
                  <div style="min-width: 0;">
                    <div style="font-weight: 800; font-size: 12px; color: #991b1b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${B.esc(af.name)}</div>
                    <div style="font-size: 10.5px; color: #b91c1c;">${af.type === 'closure' ? 'Road Closure' : 'Disruption Area'}</div>
                  </div>
                </div>
                <span style="color: #dc2626; font-size: 13px; flex-shrink: 0;">➔</span>
              </div>
            `).join('')}
          </div>

          <div class="panel-actions" style="margin-top: 10px; display: flex; gap: 8px;">
            <button id="btn-insp-clear-filter" class="btn-secondary" style="flex: 1; padding: 8px; font-size: 11.5px; font-weight: 700;">
              ✕ Clear Area
            </button>
            <button id="btn-insp-redraw-filter" class="btn-primary-action" style="flex: 1; padding: 8px; font-size: 11.5px; font-weight: 700;">
              ✏️ Redraw Polygon
            </button>
          </div>
        `;

        // Category Tab switching
        const tabs = content.querySelectorAll('.as-tab');
        const cards = content.querySelectorAll('.as-card');
        tabs.forEach((tab) => {
          tab.addEventListener('click', (e) => {
            e.stopPropagation();
            tabs.forEach((t) => t.classList.remove('active'));
            tab.classList.add('active');
            const cat = tab.dataset.tab;
            cards.forEach((c) => {
              c.style.display = (cat === 'all' || c.dataset.cat === cat) ? 'flex' : 'none';
            });
          });
        });

        // Event listeners for selection cards
        cards.forEach((card) => {
          const selType = card.dataset.selType;
          const selId = card.dataset.selId;

          card.addEventListener('mouseenter', () => {
            if (selType === 'route') {
              this.renderer.routePreviewId = selId;
              this.renderer.requestRender();
            }
          });
          card.addEventListener('mouseleave', () => {
            if (selType === 'route' && this.renderer.routePreviewId === selId) {
              this.renderer.routePreviewId = null;
              this.renderer.requestRender();
            }
          });

          card.addEventListener('click', () => {
            let nextTarget = null;
            if (selType === 'route') {
              const rObj = this.store.doc.routes[selId];
              if (rObj) nextTarget = { type: 'route', id: selId, obj: rObj, fromAreaFilter: true };
            } else if (selType === 'stop') {
              const sObj = this.store.doc.stops[selId];
              if (sObj) nextTarget = { type: 'stop', id: selId, obj: sObj, fromAreaFilter: true };
            } else if (selType === 'mrt') {
              const mObj = (this.city.mrtStations || []).find((x) => x.id === selId);
              if (mObj) nextTarget = { type: 'mrt', id: selId, obj: mObj, fromAreaFilter: true };
            } else if (selType === 'road') {
              const eObj = this.net.edge(Number(selId) || selId);
              if (eObj) nextTarget = { type: 'road', id: selId, edge: eObj, name: eObj.name, fromAreaFilter: true };
            } else if (selType === 'area') {
              const aObj = this.store.doc.areas[selId];
              if (aObj) nextTarget = { type: 'area', id: selId, obj: aObj, fromAreaFilter: true };
            } else if (selType === 'closure') {
              nextTarget = { type: 'closure', id: Number(selId), fromAreaFilter: true };
            } else if (selType === 'foreign-project') {
              const fo = (this._foreignObstacles || []).find((x) => x.projectId === selId);
              if (fo) nextTarget = { type: 'foreign-project', id: fo.projectId, project: fo.project, fromAreaFilter: true };
            }

            if (nextTarget) {
              this.renderer.selected = nextTarget;
              this._showInspector(nextTarget);
              this._focusSelectedTarget(nextTarget);
              this.renderer.requestRender();
            }
          });
        });

        const btnClear = document.getElementById('btn-insp-clear-filter');
        if (btnClear) {
          btnClear.addEventListener('click', () => {
            this._clearAreaFilter();
          });
        }

        const btnRedraw = document.getElementById('btn-insp-redraw-filter');
        if (btnRedraw) {
          btnRedraw.addEventListener('click', () => {
            this._startAreaFilterDrawing();
          });
        }
      }
    }

    _hideInspector() {
      const panel = document.getElementById('inspector-panel');
      if (panel) {
        panel.classList.add('hidden');
        panel.classList.remove('expanded-detour');
      }
      if (this.historyOpen) {
        this.historyOpen = false;
        this._syncHistoryButton();
      }
      document.body.classList.remove('has-inspector');
      this._hideSegmentPanel();
      this.showingDetourOptionsRouteId = null;
      this.detourScorecardRouteId = null;
      if (this.renderer) {
        this.renderer.previewDetourOption = null;
        this.renderer.requestRender();
      }
    }

    // Road Segment panel (below the Bus Route panel): the road under the click, the clicked leg's time/distance, and road segment constraints
    _showSegmentPanel(target, roadName, leg) {
      const panel = document.getElementById('segment-panel');
      const body = document.getElementById('segment-body');
      if (!panel || !body) return;
      // Closed with ✕: stays closed while the same click is selected; the next click on the line opens it again
      this._segmentTarget = target;
      if (target && target === this._segmentDismissedFor) return;

      const r = (leg && leg.route) || (target && this.store.doc.routes[target.routeId || target.id]) || null;
      const rawLeg = (leg && leg.rawLeg) || (target && target.leg) || null;
      const fallbackEdgeId = (leg && leg.clickedEdge && leg.clickedEdge.id) || (target && target.clickedEdge && target.clickedEdge.id) || null;
      let consts = typeof this.store.legConstraints === 'function' ? this.store.legConstraints(rawLeg, fallbackEdgeId, r) : [];
      if (!consts.length && r) {
        const rc = (this.store.geom[r.id] && this.store.geom[r.id].constraint) || (typeof this.store.routeConstraint === 'function' ? this.store.routeConstraint(r) : null);
        if (rc && rc.bypassed) consts = [rc];
      }
      const stretchLabel = (leg && leg.fromStopName && leg.toStopName) ? `${leg.fromStopName} ➔ ${leg.toStopName}` : null;

      body.innerHTML = `
        ${stretchLabel ? `
          <div class="prop-row">
            <span class="prop-label">Stretch</span>
            <span class="prop-val bold" style="font-size: 11.5px;">${B.esc(stretchLabel)}</span>
          </div>
        ` : ''}
        <div class="prop-row">
          <span class="prop-label">Road</span>
          <span class="prop-val bold">${B.esc(roadName)}</span>
        </div>
        ${leg ? `
          <div class="prop-row">
            <span class="prop-label">Segment time</span>
            <span class="prop-val">${leg.time}</span>
          </div>
          <div class="prop-row">
            <span class="prop-label">Segment km</span>
            <span class="prop-val">${leg.km}</span>
          </div>
        ` : ''}
        ${consts.length ? `
          <div class="segment-panel-constraints">
            <div class="segment-panel-constraints-head">
              <span>Segment Constraints (${consts.length})</span>
            </div>
            <div class="route-seg-constraints-list">
              ${consts.map((c) => this._renderConstraintItemHtml(c, r, { compact: false, hideRoad: false })).join('')}
            </div>
          </div>
        ` : ''}
      `;
      if (r) {
        this._bindConstraintEvents(body, r);
      }
      panel.classList.remove('hidden');
    }

    _hideSegmentPanel() {
      const panel = document.getElementById('segment-panel');
      if (panel) panel.classList.add('hidden');
    }

    _dismissSegmentPanel() {
      this._segmentDismissedFor = this._segmentTarget || null;
      this._hideSegmentPanel();
    }

    // ------------------------------------------------------------- Helper UI updates
    // Stops, bus numbers and disrupted buses on the Current Map. While a draft is open, a throwaway
    // calculator works them out from the saved Current Map, reused until that map changes.
    _currentMapStats() {
      const countBuses = (doc) => this._busGroups(Object.values(doc.routes || {})).length;
      if (this.activeProjectId === 'main' || this.reviewMode) {
        return { stops: Object.keys(this.store.doc.stops).length, buses: countBuses(this.store.doc), disrupted: this.store.disruptedRoutes().length };
      }
      let raw = null;
      try { raw = localStorage.getItem('brass_proj_doc_main'); } catch (e) {}
      if (this._mainStatsCache && raw && this._mainStatsCache.raw === raw) return this._mainStatsCache.stats;
      const doc = this._loadProjectDraft('main');
      const calc = Object.create(B.Store.prototype);
      Object.assign(calc, { city: this.store.city, net: this.store.net, doc, legCache: this.store.legCache });
      calc.derive();
      const stats = { stops: Object.keys(doc.stops || {}).length, buses: countBuses(doc), disrupted: calc.disruptedRoutes().length };
      this._mainStatsCache = { raw, stats };
      return stats;
    }

    // The Current Map section's counts (always the Current Map, even while a draft is open; the shared map in a review link)
    _renderCurrentMapStats() {
      const { stops: stopCount, buses: busCount, disrupted } = this._currentMapStats();

      const badgeStops = document.getElementById('stat-stops');
      if (badgeStops) badgeStops.textContent = String(stopCount);

      const badgeRoutes = document.getElementById('stat-routes');
      if (badgeRoutes) badgeRoutes.textContent = String(busCount);

      const badgeDisrupted = document.getElementById('stat-disrupted');
      if (badgeDisrupted) {
        badgeDisrupted.textContent = String(disrupted);
        badgeDisrupted.classList.toggle('alert', disrupted > 0);
      }
    }

    // Where a project's sign goes: its first area's middle, else its first closed road's middle
    _signSpot(areas, closures) {
      const a = Object.values(areas || {})[0];
      if (a) {
        const poly = this.store.areaPoly(a);
        return { x: poly.reduce((t, p) => t + p.x, 0) / poly.length, y: poly.reduce((t, p) => t + p.y, 0) / poly.length };
      }
      const edge = Object.keys(closures || {})[0];
      const e = edge !== undefined && this.net.edge(Number(edge));
      if (e) return e.pts[Math.floor(e.pts.length / 2)];
      return null;
    }

    // Checks whether two projects have overlapping effective periods
    _periodsOverlap(p1, p2) {
      if (!p1 || !p2) return true;
      const per1 = this._readProjectPeriod(p1);
      const per2 = this._readProjectPeriod(p2);

      // If either project has no period or is permanent (forever), they overlap
      if (per1.mode === 'permanent' || per2.mode === 'permanent') return true;

      // If either period has an error (e.g. missing dates in draft), default to overlapping
      if (per1.error || per2.error) return true;


      const s1 = per1.start, e1 = per1.end;
      const s2 = per2.start, e2 = per2.end;
      if (isNaN(s1) || isNaN(e1) || isNaN(s2) || isNaN(e2)) return true;

      // Overlap condition: start1 < end2 && start2 < end1
      return (s1 < e2 && s2 < e1);
    }

    // ------------------------------------------------------------- Other projects at the same time
    // Gathers affected areas and road closures from other projects that overlap with the current project's time period.
    // Displayed in grey on the map; hovering shows the project name and clicking opens the right sidebar details.
    _foreignObstacles(currentDoc = this.store && this.store.doc) {
      if (this.reviewMode) return null;
      const currentProj = (this.projects || []).find((x) => x.id === this.activeProjectId) || { id: this.activeProjectId || 'main', name: 'Current Map' };
      if (!currentDoc) return null;

      const areas = [];
      const closures = [];
      const signs = [];

      for (const other of this.projects || []) {
        if (other.id === currentProj.id) continue;
        if (!this._periodsOverlap(currentProj, other)) continue;

        const od = (other.id === this.activeProjectId)
          ? currentDoc
          : (this._storedAreasClosures(other.id) || this._loadProjectDraft(other.id));
        if (!od) continue;

        const otherAreas = {};
        const otherClosures = {};
        const otherKind = other.status === 'go_live' ? 'live' : 'draft';

        // Foreign affected areas (rendered in grey)
        if (od.areas) {
          for (const [id, a] of Object.entries(od.areas)) {
            if (currentDoc.areas && currentDoc.areas[id]) continue;
            const poly = this.store.areaPoly(a);
            if (poly && poly.length >= 3) {
              areas.push({
                id,
                poly,
                projectId: other.id,
                projectName: other.name,
                project: other,
                kind: otherKind,
                area: a
              });
              otherAreas[id] = a;
            }
          }
        }

        // Foreign road closures (rendered in grey)
        if (od.closures) {
          for (const [edge, c] of Object.entries(od.closures)) {
            if (currentDoc.closures && currentDoc.closures[edge]) continue;
            closures.push({
              edge: Number(edge),
              projectId: other.id,
              projectName: other.name,
              project: other,
              kind: otherKind,
              closure: c
            });
            otherClosures[edge] = c;
          }
        }

        const spot = this._signSpot(otherAreas, otherClosures);
        if (spot) {
          signs.push({ ...spot, name: other.name, kind: otherKind, projectId: other.id });
        }
      }

      return { areas, closures, signs };
    }

    // A saved document, parsed once and reused until its saved text changes (read-only: never change what it returns)
    // A saved project map's areas and closures, without rebuilding the whole map (for reading only)
    _storedAreasClosures(id) {
      const key = 'brass_proj_doc_' + id;
      const areas = B.storedPart(key, 'areas'), closures = B.storedPart(key, 'closures');
      return areas === null && closures === null ? null : { areas: areas || {}, closures: closures || {} };
    }

    _storedDoc(key) {
      let raw = null;
      try { raw = localStorage.getItem(key); } catch (e) {}
      if (!raw) return null;
      const cache = this._storedDocs || (this._storedDocs = new Map());
      const hit = cache.get(key);
      if (hit && hit.raw === raw) return hit.doc;
      let doc = null;
      try { doc = JSON.parse(raw); } catch (e) {}
      cache.set(key, { raw, doc });
      return doc;
    }

    // Current Map: a tag on each affected area with the project that put it there (a live temporary
    // project, else the permanent change that first had it), or the area's own name when that's not known
    _syncMapAreaTags() {
      const onMain = this.activeProjectId === 'main' && !this.reviewMode;
      const areas = onMain ? Object.values(this.store.doc.areas || {}) : [];
      const key = onMain ? JSON.stringify([areas.map((a) => [a.id, a.name, this.store.areaPoly(a)]), (this.scheduledChanges || []).map((sc) => sc.id), (this.mapVersions || []).length]) : '';
      if (key === this._mapTagsKey) return;
      this._mapTagsKey = key;
      if (!areas.length) {
        this.renderer.mapAreaTags = null;
        return;
      }
      const owner = {};
      for (const sc of this._liveScheduledChanges()) {
        for (const id of Object.keys((sc.patch && sc.patch.areas && sc.patch.areas.set) || {})) owner[id] = sc.projectName;
      }
      const missing = areas.filter((a) => !owner[a.id]);
      if (missing.length) {
        const perm = (this.mapVersions || []).filter((v) => v.type === 'permanent' && v.hasSnapshot).sort((a, b) => a.appliedAt - b.appliedAt);
        for (const v of perm) {
          const snap = this._loadMapSnapshot(v);
          if (!snap) continue;
          for (const a of missing) if (!owner[a.id] && snap.areas && snap.areas[a.id]) owner[a.id] = v.projectName;
          if (missing.every((a) => owner[a.id])) break;
        }
      }
      this.renderer.mapAreaTags = areas.map((a) => {
        const poly = this.store.areaPoly(a);
        return {
          x: poly.reduce((t, p) => t + p.x, 0) / poly.length,
          y: poly.reduce((t, p) => t + p.y, 0) / poly.length,
          name: owner[a.id] || a.name || a.id,
          kind: 'live',
        };
      });
      this.renderer.requestRender();
    }

    _syncForeignObstacles() {
      this._syncMapAreaTags();
      const fo = this._foreignObstacles();
      const has = !!fo && (fo.areas.length > 0 || fo.closures.length > 0);
      const key = has ? JSON.stringify([fo.areas.map((a) => [a.id, a.projectName, a.kind, a.poly]), fo.closures.map((c) => [c.edge, c.projectName, c.kind])]) : '';
      if (key === this._foreignKey) return;
      this._foreignKey = key;
      this.renderer.foreignObstacles = has ? fo : null;
      if (this._setForeignBlocked(fo)) this.store.changed('Other projects changed');
      this.renderer.requestRender();
    }

    // Hands the store the roads other projects block at the same time; true when they changed.
    // In a project buses avoid them and count as affected. The Current Map only keeps its detours around them.
    _setForeignBlocked(fo) {
      const blocked = new Set();
      if (fo) {
        for (const a of fo.areas) for (const e of this.net.edgesInPolygon(a.poly)) blocked.add(e);
        for (const c of fo.closures) blocked.add(c.edge);
      }
      const key = blocked.size ? [...blocked].sort((x, y) => x - y).join(',') : '';
      const changed = key !== (this.store.extraBlockedKey || '');
      this.store.extraBlocked = blocked.size ? blocked : null;
      this.store.extraBlockedKey = key;
      this.store.extraAffected = blocked.size && this.activeProjectId !== 'main' ? blocked : null;
      return changed;
    }

    // Set before a map loads, so a detour around another project isn't taken for one no longer needed
    _prepareForeignBlocked(doc) {
      let parsed = doc;
      if (typeof doc === 'string') {
        try { parsed = JSON.parse(doc); } catch (e) { parsed = {}; }
      }
      this._setForeignBlocked(this._foreignObstacles(parsed || {}));
    }

    // The grey area or closure under the cursor (from another project), or null
    _foreignAt(world) {
      const fo = this.renderer.foreignObstacles;
      if (!fo) return null;
      for (const a of fo.areas) if (B.pointInPoly(world, a.poly)) return a;
      if (fo.closures.length) {
        const near = this.net.nearest(world, 10 / this.renderer.camera.zoom + 6);
        const c = near && fo.closures.find((x) => x.edge === near.edge);
        if (c) return c;
      }
      return null;
    }

    // Opens the right sidebar with project details when clicking another project's grey area or closure
    _showForeignDetails(foreignHit) {
      if (!foreignHit) return;
      this.renderer.selected = {
        type: 'foreign-project',
        id: foreignHit.projectId,
        projectId: foreignHit.projectId,
        projectName: foreignHit.projectName,
        foreignHit: foreignHit,
        project: foreignHit.project || (this.projects && this.projects.find((p) => p.id === foreignHit.projectId))
      };
      this.renderer.hoveredForeign = foreignHit;
      const tip = document.getElementById('map-tooltip');
      if (tip) tip.hidden = true;
      this._showInspector(this.renderer.selected);
      this.renderer.requestRender();
    }

    _hideForeignName() {
      const tip = document.getElementById('map-tooltip');
      if (tip) tip.hidden = true;
      if (this.renderer.hoveredForeign) {
        this.renderer.hoveredForeign = null;
        this.renderer.requestRender();
      }
    }

    _updateUIState() {
      this._syncForeignObstacles();
      this._renderCurrentMapStats();
      this._refreshProjectAreas();

      // Refresh route dropdown & operation card
      this._updateRouteDropdown();

      // If an object is currently selected, refresh inspector
      if (this.renderer.selected) {
        this._showInspector(this.renderer.selected);
      }

      // Update undo / redo button states
      this._updateHistoryButtons();
      this._updateSaveButton();
    }

    // ------------------------------------------------------------- Route Selector & Operations UI
    _applyRouteMultiSelection() {
      const allRoutes = Object.values(this.store.doc.routes);
      const isAreaFilterActive = this.areaFilterPolygon && this.areaFilterPassingIds;

      if (isAreaFilterActive) {
        this.renderer.visibleRouteIds = new Set(this.selectedRouteIds);
      } else {
        if (this.selectedRouteIds.size === allRoutes.length) {
          this.renderer.visibleRouteIds = null; // all visible
        } else {
          this.renderer.visibleRouteIds = new Set(this.selectedRouteIds);
        }
      }

      if (!this.reviewMode && this.projects && this.activeProjectId && this.activeProjectId !== 'main') {
        const activeProj = this.projects.find((p) => p.id === this.activeProjectId);
        if (activeProj) {
          if (this.selectedRouteIds.size > 0 && this.selectedRouteIds.size < allRoutes.length) {
            activeProj.focusRouteNums = [...new Set(
              [...this.selectedRouteIds]
                .map((id) => this.store.doc.routes[id] && String(this.store.doc.routes[id].number).trim())
                .filter(Boolean)
            )];
          } else {
            delete activeProj.focusRouteNums;
          }
          this._saveProjects();
        }
      }

      // Update Trigger text
      const summaryEl = document.getElementById('multi-select-summary');
      const triggerBtn = document.getElementById('multi-select-trigger');
      const searchInput = document.getElementById('ms-search-input');

      // Count bus numbers, not route pieces: every piece of a bus number is one line
      const allGroups = this._busGroups(allRoutes);
      const running = this._runningBusNumbers();
      const selGroups = this._selectedBusGroups().filter((g) => !running || running.has(g.number));

      let summaryText = '';
      if (isAreaFilterActive) {
        summaryText = `Bus Number (${selGroups.length})`;
        if (triggerBtn) {
          const numList = selGroups.map((g) => g.number).join(', ');
          triggerBtn.title = `${selGroups.length} bus number${selGroups.length === 1 ? '' : 's'} in the area${numList ? ` (Bus ${numList})` : ''}`;
        }
      } else if (running) {
        summaryText = `Bus Number (${selGroups.length})`;
        if (triggerBtn) {
          const numList = selGroups.map((g) => g.number).join(', ');
          triggerBtn.title = `${selGroups.length} bus number${selGroups.length === 1 ? '' : 's'} running ${this._whenFilterLabel()}${numList ? ` (Bus ${numList})` : ''}`;
        }
      } else if (this.selectedRouteIds.size === allRoutes.length) {
        summaryText = `All Bus Numbers (${allGroups.length})`;
        if (triggerBtn) triggerBtn.title = `Click to search and select (${allGroups.length} bus numbers)`;
      } else if (this.selectedRouteIds.size === 0) {
        summaryText = 'None Selected';
        if (triggerBtn) triggerBtn.title = 'No bus numbers selected';
      } else if (selGroups.length <= 3) {
        summaryText = `Bus ${selGroups.map((g) => g.number).join(', ')}`;
        if (triggerBtn) {
          const numList = selGroups.map((g) => g.number).join(', ');
          triggerBtn.title = `Selected: ${selGroups.length} bus number${selGroups.length === 1 ? '' : 's'} (Bus ${numList})`;
        }
      } else {
        summaryText = `${selGroups.length} of ${allGroups.length} Selected`;
        if (triggerBtn) triggerBtn.title = `${selGroups.length} of ${allGroups.length} bus numbers selected`;
      }

      if (summaryEl) summaryEl.textContent = summaryText;
      if (searchInput) {
        searchInput.setAttribute('data-summary', summaryText);
        const tag = document.getElementById('ms-search-focus-tag');
        const hasTag = tag && !tag.classList.contains('hidden') && tag.innerHTML.trim().length > 0;
        const hasItem = Boolean(this.currentFocusItem || (this.selectedEntities && this.selectedEntities.size > 0) || hasTag);
        if (hasItem) {
          searchInput.placeholder = '';
        } else if (!searchInput.value) {
          searchInput.placeholder = 'Search bus number, stop, MRT, road, postal...';
        }
      }

      // Update Select-All checkbox
      const chkAll = document.getElementById('ms-select-all-chk');
      if (chkAll) {
        chkAll.checked = (this.selectedRouteIds.size === allRoutes.length);
        chkAll.indeterminate = (this.selectedRouteIds.size > 0 && this.selectedRouteIds.size < allRoutes.length);
      }

      // Update rows in dropdown list
      const listContainer = document.getElementById('ms-options-list');
      if (listContainer) {
        listContainer.querySelectorAll('.ms-option-row').forEach((row) => {
          const ids = (row.dataset.routeIds || '').split(',').filter(Boolean);
          const isSel = ids.some((rid) => this.selectedRouteIds.has(rid));
          row.classList.toggle('selected', isSel);
          const chk = row.querySelector('.ms-chk');
          if (chk) chk.checked = isSel;
        });
      }

      // Update pill buttons state
      this._renderRoutePills();

      // Update Operation Details Box
      this._updateRouteOperationCard();
      this.renderer.requestRender();
    }

    // Per-bus answers that only change with the document, worked out once per change
    _memo(kind, id, fn) {
      const st = this.store;
      let m = this._memoCache;
      if (!m || m.store !== st || m.rev !== st.rev) m = this._memoCache = { store: st, rev: st.rev, map: new Map() };
      const k = kind + '|' + id;
      if (!m.map.has(k)) m.map.set(k, fn());
      return m.map.get(k);
    }

    _routeDisruptedFraction(r) {
      return r ? this._memo('disrupted', r.id, () => this._workOutDisruptedFraction(r)) : 0;
    }

    _workOutDisruptedFraction(r) {
      const g = this.store.geom[r.id];
      if (!g || !g.legs || !g.legs.length) return 0;
      let totalDist = 0;
      let disruptedDist = 0;
      let totalLegs = g.legs.length;
      let disruptedLegs = 0;

      const isEdgeDisrupted = (edgeId) => {
        if (!edgeId) return false;
        if (this.store.closedSet && this.store.closedSet.has(edgeId)) return true;
        if (this.store.affected && this.store.affected.has(edgeId)) return true;
        return false;
      };

      for (let i = 0; i < g.legs.length; i++) {
        const l = g.legs[i];
        if (!l) continue;
        if (!l.ok) {
          disruptedLegs++;
          const fromA = r.anchors && r.anchors[i];
          const toA = r.anchors && r.anchors[i + 1];
          const at = (a) => { const pos = a && this.store.resolveAnchor(a); return pos ? this.net.posPoint(pos, 0) : null; };
          const fromPt = at(fromA);
          const toPt = at(toA);
          const d = (fromPt && toPt) ? Math.hypot(toPt.x - fromPt.x, toPt.y - fromPt.y) : 500;
          totalDist += d;
          disruptedDist += d;
          continue;
        }

        const legLen = l.length || 0;
        totalDist += legLen;
        let legDisruptedLen = 0;
        if (Array.isArray(l.segs)) {
          for (const sg of l.segs) {
            const sgLen = Math.abs(sg.s1 - sg.s0) || 0;
            if (isEdgeDisrupted(sg.edge)) {
              legDisruptedLen += sgLen;
            }
          }
        }
        disruptedDist += legDisruptedLen;
        if (legDisruptedLen > legLen * 0.35 || (l.segs && l.segs.some((sg) => isEdgeDisrupted(sg.edge)))) {
          disruptedLegs++;
        }
      }

      const stops = (r.anchors || []).filter((a) => a.t === 'stop');
      let stopsDisrupted = 0;
      for (const a of stops) {
        const st = this.store.doc.stops[a.id];
        if (st && isEdgeDisrupted(st.edge)) stopsDisrupted++;
      }

      const distRatio = totalDist > 0 ? (disruptedDist / totalDist) : 0;
      const legRatio = totalLegs > 0 ? (disruptedLegs / totalLegs) : 0;
      const stopRatio = stops.length > 0 ? (stopsDisrupted / stops.length) : 0;

      return Math.max(distRatio, legRatio, stopRatio);
    }

    isRouteAffected(routeId) {
      const r = typeof routeId === 'object' ? routeId : this.store.doc.routes[routeId];
      if (!r) return false;
      return this._memo('affected', r.id, () => this._checkRouteAffected(r));
    }

    _checkRouteAffected(r) {
      const g = this.store.geom[r.id];

      // 1. Direct road closures or rejected road constraints
      if (g && ((g.conflicts && g.conflicts.length > 0) || (g.stopsOnClosed && g.stopsOnClosed.length > 0) || (g.rejectedConflicts && g.rejectedConflicts.length > 0))) {
        return true;
      }
      if (this.store.closedSet && this.store.closedSet.size > 0) {
        if (g && g.legs && g.legs.some((l) => l.ok && l.segs && l.segs.some((sg) => this.store.closedSet.has(sg.edge)))) {
          return true;
        }
        const stopAnchors = (r.anchors || []).filter((a) => a.t === 'stop');
        for (const a of stopAnchors) {
          const s = this.store.doc.stops[a.id];
          if (s && this.store.closedSet.has(s.edge)) return true;
        }
      }

      // 2. Affected areas
      return this._routeInAffectedArea(r);
    }

    // The bus passes through, or stops inside, an affected area
    _routeInAffectedArea(r) {
      return this._memo('inArea', r.id, () => this._checkRouteInArea(r));
    }

    _checkRouteInArea(r) {
      const g = this.store.geom[r.id];
      const areas = Object.values(this.store.doc.areas || {});
      if (areas.length > 0 || (this.store.affected && this.store.affected.size > 0)) {
        // Check if any route leg passes through an edge affected by an area
        if (this.store.affected && this.store.affected.size > 0 && g && g.legs) {
          if (g.legs.some((l) => l.ok && l.segs && l.segs.some((sg) => this.store.affected.has(sg.edge)))) {
            return true;
          }
        }
        // Check if any stop is on an affected edge or inside an affected area polygon
        const stopAnchors = (r.anchors || []).filter((a) => a.t === 'stop');
        for (const a of stopAnchors) {
          const s = this.store.doc.stops[a.id];
          if (!s) continue;
          if (this.store.affected && this.store.affected.has(s.edge)) return true;
          const pt = this.net.posPoint(s, 0.78);
          for (const area of areas) {
            const poly = this.store.areaPoly(area);
            if (B.pointInPoly(pt, poly)) return true;
          }
        }
        // Check points along the route's legs
        if (g && g.legs) {
          for (const l of g.legs) {
            if (!l.ok || !l.pts) continue;
            for (const area of areas) {
              const poly = this.store.areaPoly(area);
              for (let i = 0; i < l.pts.length; i += 3) {
                if (B.pointInPoly(l.pts[i], poly)) return true;
              }
            }
          }
        }
      }

      return false;
    }

    // The bus drives on, or stops on, one of these closed roads
    _routeUsesEdges(r, edges) {
      if (!edges.size) return false;
      const g = this.store.geom[r.id];
      if (g && g.conflicts && g.conflicts.some((e) => edges.has(e))) return true;
      if (g && g.legs && g.legs.some((l) => l.ok && l.segs && l.segs.some((sg) => edges.has(sg.edge)))) return true;
      return (r.anchors || []).some((a) => {
        const st = a.t === 'stop' ? this.store.doc.stops[a.id] : null;
        return !!st && edges.has(st.edge);
      });
    }

    // ------------------------------------------------------------- Quick filters (above the bus pills)
    // Affected area covers affected areas and road closures alike; In view is always there.
    _quickFilterSets() {
      const doc = this.store.doc;
      const routes = Object.values(doc.routes);
      const areas = Object.values(doc.areas || {});
      const closed = new Set(Object.keys(doc.closures || {}).map(Number));
      const sets = [];

      // New bus service: the buses a document introduced (shown while there are any, with the AI mark)
      const fromDocs = routes.filter((r) => r.fromDocument).map((r) => r.id);
      if (fromDocs.length) sets.push({ key: 'newbus', label: 'New bus service', icon: B.AI_ICON || '', ids: fromDocs });

      // Combine AI focus and affected area / road closures into ONE single "Affected bus" chip.
      // It routes every detoured bus again, so it's worked out once per change to the map
      const areaRouteIds = this._memo('qfArea', '', () => {
        if (!(areas.length || closed.size || this.store.affected.size)) return [];
        // A bus detoured around one still counts: the roads its route used before the detour
        const before = new Map();
        for (const r of routes) {
          if (r.isChunk || !r.detourApplied || !r.originalAnchors) continue;
          const g = this.store.computeRoute({ anchors: r.originalAnchors, kind: 'existing' });
          const edges = new Set(g.legs.flatMap((l) => (l.ok && l.segs ? l.segs.map((sg) => sg.edge) : [])));
          for (const a of r.originalAnchors) { const st = a.t === 'stop' && doc.stops[a.id]; if (st) edges.add(st.edge); }
          before.set(r.id, edges);
        }
        const blocked = (e) => this.store.affected.has(e) || closed.has(e);
        const usedBefore = (r) => before.has(r.id) && [...before.get(r.id)].some(blocked);
        return routes.filter((r) => this._routeInAffectedArea(r) || this._routeUsesEdges(r, closed) || usedBefore(r)).map((r) => r.id);
      });
      const aiFocusRouteIds = B.aiFocus ? (B.aiFocus.ids() || []) : [];
      const combinedAffectedIds = [...new Set([...areaRouteIds, ...aiFocusRouteIds])];

      if (combinedAffectedIds.length || areas.length || closed.size || this.store.affected.size) {
        sets.push({
          key: 'area',
          label: 'Affected bus',
          icon: B.AI_ICON || '',
          ids: combinedAffectedIds,
          tip: 'Show only buses through an affected area or closed road, or detoured around one',
          none: 'No affected buses'
        });
      }

      // "Fragmented routes" is hidden per user request

      sets.push({ key: 'inview', label: 'Bus in view', ids: this._busesInView(true).flatMap((g) => g.ids) });

      const scope = this._projectScope();
      if (scope) {
        const part = (n, one, many = one + 's') => (n ? `${n} ${n === 1 ? one : many}` : '');
        const parts = [part(scope.buses, 'bus', 'buses'), part(scope.keyStopIds.size, 'stop'), part(scope.areas.length, 'area'), part(scope.roads.size, 'road')];
        sets.push({ key: 'scope', label: 'View project scope', icon: B.AI_ICON || '', ids: scope.routeIds, count: scope.total, tip: parts.filter(Boolean).join(', '), none: 'Nothing in this project yet' });
      }
      return sets;
    }

    // Everything the open project involves: what it changed, plus the buses and stops its areas and closures reach.
    // Every piece of a bus number comes along. What the project removed isn't on the map, so it isn't counted.
    _projectScope() {
      const id = this.reviewMode ? 'review' : this.activeProjectId;
      if (!id || id === 'main') return null;
      return this._memo('projectScope', id, () => {
        const doc = this.store.doc;
        const base = this.reviewMode ? this.reviewBaseDoc : this._projectBase(id);
        if (!base) return null;
        const items = this._projectChanges(base, doc).map((c) => c.focus).filter((f) => f && !f.gone);
        const ofType = (type) => items.filter((f) => f.type === type);
        const areas = ofType('area').map((f) => doc.areas[f.id]).filter(Boolean);
        const roads = new Set(ofType('closure').map((f) => f.edge));
        const keyStopIds = new Set(ofType('stop').map((f) => f.id));

        const polys = areas.map((a) => this.store.areaPoly(a));
        for (const st of Object.values(doc.stops)) {
          if (!this.net.edge(st.edge)) continue;
          if (roads.has(st.edge)) keyStopIds.add(st.id);
          else if (polys.length) {
            const pt = this.net.posPoint(st, 0.78);
            if (polys.some((p) => B.pointInPoly(pt, p))) keyStopIds.add(st.id);
          }
        }

        const numbers = new Set(ofType('bus').map((f) => String(f.num).trim()));
        const routes = Object.values(doc.routes);
        for (const r of routes) {
          const servesKeyStop = (r.anchors || []).some((a) => a.t === 'stop' && keyStopIds.has(a.id));
          if (servesKeyStop || this._routeUsesEdges(r, roads) || areas.some((a) => this._routeThroughArea(r, a))) numbers.add(String(r.number).trim());
        }
        const scoped = routes.filter((r) => numbers.has(String(r.number).trim()));
        // Close up the involved buses' own stops show too; zoomed out, only the stops the project itself touches
        const stopIds = new Set(keyStopIds);
        for (const r of scoped) for (const a of r.anchors || []) if (a.t === 'stop') stopIds.add(a.id);

        return { routeIds: scoped.map((r) => r.id), buses: numbers.size, stopIds, keyStopIds, areas, roads, total: numbers.size + keyStopIds.size + areas.length + roads.size };
      });
    }

    // Unrelated stops only go away while View project scope is the one filter on
    _activeProjectScope() {
      const qf = this.quickFilter;
      return qf && qf.keys && qf.keys.size === 1 && qf.keys.has('scope') && this._quickFilterOn(qf) ? this._projectScope() : null;
    }

    _fitProjectScope() {
      const scope = this._projectScope();
      if (!scope) return;
      const pts = [];
      for (const rid of scope.routeIds) for (const l of (this.store.geom[rid] || {}).legs || []) pts.push(...(l.pts || []));
      for (const id of scope.keyStopIds) pts.push(this.net.posPoint(this.store.doc.stops[id], 0.78));
      for (const a of scope.areas) pts.push(...this.store.areaPoly(a));
      for (const edge of scope.roads) { const e = this.net.edge(edge); if (e && e.pts) pts.push(...e.pts); }
      if (pts.length) this._fitClearOfPanels(B.bbox(pts, 280));
    }

    // The buses of these quick filters together (keys: a Set of chip keys)
    _quickFilterIds(keys, sets = this._quickFilterSets()) {
      return [...new Set(sets.filter((f) => keys.has(f.key)).flatMap((f) => f.ids))];
    }

    // Turn on exactly these quick filters (none: what was selected before they came on comes back)
    _applyQuickFilters(keys) {
      const allIds = Object.keys(this.store.doc.routes);
      if (!keys.size) {
        const saved = this._qfSaved;
        this._qfSaved = null;
        this.quickFilter = null;
        if (saved) {
          const restored = new Set([...saved].filter((id) => this.store.doc.routes[id]));
          // Keep all sibling chunks of any restored route together
          for (const rid of [...restored]) {
            const r = this.store.doc.routes[rid];
            if (r) {
              const num = String(r.number).trim();
              for (const [id, sib] of Object.entries(this.store.doc.routes)) {
                if (String(sib.number).trim() === num) restored.add(id);
              }
            }
          }
          this.selectedRouteIds = restored;
        } else {
          this.selectedRouteIds = new Set(allIds);
        }
        if (!this.selectedRouteIds.size) this.selectedRouteIds = new Set(allIds);
        if (B.setPillFocus) B.setPillFocus(null);
      } else {
        const ids = this._quickFilterIds(keys);
        if (!ids.length && !keys.has('scope')) return false; // a project can be stops or areas that no bus uses
        if (!this._qfSaved) this._qfSaved = new Set(this.selectedRouteIds);
        this.quickFilter = { keys: new Set(keys), ids: new Set(ids) };
        this.selectedRouteIds = new Set(ids);
        // the AI chip on its own comes back to the changes, not just to where the map was
        const box = keys.size === 1 && keys.has('aifocus') && B.aiFocus ? B.aiFocus.box() : null;
        if (B.setPillFocus) B.setPillFocus(ids, [...keys], box);
      }
      this.isAllRoutesSelected = this.selectedRouteIds.size === allIds.length;
      this._applyRouteMultiSelection();
      this._updateRouteDropdown();
      return true;
    }

    // A chip stays on while the selection is still exactly what it picked
    _quickFilterOn(qf) {
      return !!qf && qf.ids.size === this.selectedRouteIds.size && [...qf.ids].every((id) => this.selectedRouteIds.has(id));
    }

    // While In view is on, the selection follows the screen: buses come and go as you zoom and pan
    _syncInViewFilter() {
      const qf = this.quickFilter;
      if (!qf || !qf.keys || !qf.keys.has('inview') || !this._quickFilterOn(qf)) return;
      const ids = this._quickFilterIds(qf.keys);
      if (ids.length === qf.ids.size && ids.every((id) => qf.ids.has(id))) return;
      this.quickFilter = { keys: qf.keys, ids: new Set(ids) };
      this.selectedRouteIds = new Set(ids);
      if (B.setPillFocus) B.setPillFocus(ids, [...qf.keys]);
      this.isAllRoutesSelected = ids.length === Object.keys(this.store.doc.routes).length;
      this._applyRouteMultiSelection();
    }

    addSelectedEntity(ent) {
      if (!this.selectedEntities) this.selectedEntities = new Map();
      this.selectedEntities.set(ent.id, ent);
      this._renderRoutePills();
    }

    removeSelectedEntity(id) {
      if (this.selectedEntities) {
        this.selectedEntities.delete(id);
      }
      if (window.BRASS_SEARCH && typeof window.BRASS_SEARCH.onEntityRemoved === 'function') {
        window.BRASS_SEARCH.onEntityRemoved(id);
      }
      this._renderRoutePills();
    }

    clearSelectedEntities() {
      if (this.selectedEntities) {
        this.selectedEntities.clear();
      }
      this._renderRoutePills();
    }

    _checkEntityAffected(ent) {
      if (!ent) return { isAffected: false, isAiFocus: false, areaName: '' };
      const pt = { x: ent.x || 0, y: ent.y || 0 };
      const store = this.store;

      // 1. Check AI focus box
      if (window.B && B.aiFocus && typeof B.aiFocus.box === 'function') {
        const box = B.aiFocus.box();
        if (box && pt.x >= box.minX && pt.x <= box.maxX && pt.y >= box.minY && pt.y <= box.maxY) {
          return { isAffected: true, isAiFocus: true, areaName: 'AI Focus Zone' };
        }
      }

      // 2. Check controller drawn area filter polygon
      if (this.areaFilterPolygon && this.areaFilterPolygon.length >= 3) {
        if (B.pointInPoly(pt, this.areaFilterPolygon)) {
          return { isAffected: true, isAiFocus: false, areaName: 'Drawn Boundary Filter' };
        }
      }

      // 3. Check doc.areas (Disruption / Affected zones)
      if (store && store.doc && store.doc.areas) {
        for (const a of Object.values(store.doc.areas)) {
          const poly = store.areaPoly(a);
          if (poly && B.pointInPoly(pt, poly)) {
            return { isAffected: true, isAiFocus: !!(a.fromLink || a.aiGenerated), areaName: a.name || 'Affected Area' };
          }
          if (poly && poly.some((p) => Math.hypot(p.x - pt.x, p.y - pt.y) < 1200)) {
            return { isAffected: true, isAiFocus: !!(a.fromLink || a.aiGenerated), areaName: a.name || 'Affected Area' };
          }
        }
      }

      // 4. For road entities, check if edge is closed or affected
      if (ent.type === 'road' && ent.obj && store) {
        const eid = ent.obj.id;
        if ((store.closedSet && store.closedSet.has(eid)) || (store.affected && store.affected.has(eid))) {
          return { isAffected: true, isAiFocus: false, areaName: 'Road Closure Zone' };
        }
      }

      // 5. Name match for known disruption zones (e.g. Bishan in proj-1)
      const name = (ent.title || ent.name || '').toLowerCase();
      const road = (ent.road || '').toLowerCase();
      if (name.includes('bishan') || road.includes('bishan')) {
        return { isAffected: true, isAiFocus: false, areaName: 'Bishan Works Zone' };
      }

      return { isAffected: false, isAiFocus: false, areaName: '' };
    }

    _isEntityInView(ent) {
      if (!ent || typeof ent.x !== 'number' || typeof ent.y !== 'number' || !this.renderer) return true;
      const cam = this.renderer.camera;
      const w = this.renderer.width;
      const h = this.renderer.height;
      if (!cam || !w || !h) return true;
      const sx = (ent.x - cam.x) * cam.zoom + w / 2;
      const sy = (ent.y - cam.y) * cam.zoom + h / 2;
      return sx >= 200 && sx <= (w - 280) && sy >= 50 && sy <= (h - 50);
    }

    _glideToEntity(ent) {
      if (!ent || typeof ent.x !== 'number' || typeof ent.y !== 'number') return;
      const selType = ent.type === 'interchange' ? 'stop' : ent.type;
      this.renderer.selected = {
        type: selType,
        id: ent.id,
        obj: ent.obj,
        x: ent.x,
        y: ent.y,
        name: ent.title || ent.name,
        district: ent.district || (ent.obj && ent.obj.district) || '',
        road: ent.road || (ent.obj && ent.obj.roadName) || '',
        postalCode: ent.postalCode || (ent.obj && ent.obj.postalCode) || '',
        isSearch: true,
        entity: ent
      };
      this._showInspector(this.renderer.selected);
      const zoom = 1.65; // Zoom in to the area we're searching
      if (window.BRASS_SEARCH && typeof window.BRASS_SEARCH.glideTo === 'function') {
        window.BRASS_SEARCH.glideTo(ent.x, ent.y, zoom);
      } else if (this.renderer && this.renderer.camera) {
        this.renderer.camera.x = ent.x;
        this.renderer.camera.y = ent.y;
        this.renderer.camera.zoom = zoom;
      }
      this.renderer.requestRender();
    }

    _renderQuickFilters(now = false) {
      const row = document.getElementById('quick-filter-row');
      if (!row) return;

      // Right after an edit (or on opening) these counts are slow to work out, so they wait until the map has
      // caught up and the editing pauses
      if (!now && this._chipsRev !== this.store.rev) {
        clearTimeout(this._chipsTimer);
        if (this.store.tx == null) this._chipsTimer = setTimeout(() => this._renderQuickFilters(true), 150);
        return;
      }
      this._chipsRev = this.store.rev;

      // When non-bus entities (Address, Road, Stop, MRT, Interchange) are selected:
      if (this.selectedEntities && this.selectedEntities.size > 0) {
        const entities = Array.from(this.selectedEntities.values());
        const affCount = entities.filter((e) => {
          const aff = this._checkEntityAffected(e);
          return aff.isAffected || aff.isAiFocus;
        }).length;
        const inViewCount = entities.filter((e) => this._isEntityInView(e)).length;

        const chips = [];
        chips.push(`
          <button type="button" class="quick-filter-chip ai-chip ${affCount > 0 ? 'active' : ''}" title="${affCount} selected item${affCount === 1 ? '' : 's'} in affected area">
            ${B.AI_ICON || ''}<span>Affected bus</span><span class="quick-filter-count">${affCount}</span>
          </button>
        `);
        chips.push(`
          <button type="button" class="quick-filter-chip" title="${inViewCount} selected item${inViewCount === 1 ? '' : 's'} in view on map">
            <span>Bus in view</span><span class="quick-filter-count">${inViewCount}</span>
          </button>
        `);

        row.innerHTML = chips.join('');
        return;
      }

      const qf = this.quickFilter;
      // several chips can be on: the buses shown are all of theirs together
      const activeKeys = qf && qf.keys && this._quickFilterOn(qf) ? qf.keys : new Set();
      if (!activeKeys.size) this.quickFilter = null;
      this._syncAreaChips();

      const routes = this.store.doc.routes;
      const busCount = (ids) => this._busGroups(ids.map((id) => routes[id]).filter(Boolean)).length;
      const sets = this._quickFilterSets();
      row.innerHTML = sets.map((f) => {
        const on = activeKeys.has(f.key);
        const n = f.count != null ? f.count : busCount(f.ids);
        return `
          <button type="button" class="quick-filter-chip ${f.icon ? 'ai-chip ' : ''}${on ? 'active' : ''}" data-key="${f.key}" aria-pressed="${on}" ${!n && !on ? 'disabled' : ''}
            title="${on ? 'Turn this filter off' : (f.tip && n ? f.tip : !n && f.none ? f.none : f.key === 'inview' ? 'Show only the buses on screen, as you zoom and pan' : `Show only the ${n} bus${n === 1 ? '' : 'es'} ${({ newbus: 'new from the documents', area: 'through an affected area or closed road, or detoured around one', fragmented: 'in separate pieces, chunks, or with road gaps' })[f.key] || ''}`)}">
            ${f.icon || ''}<span>${f.label}</span><span class="quick-filter-count">${n}</span>
          </button>
        `;
      }).join('');

      row.querySelectorAll('.quick-filter-chip').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const key = btn.dataset.key;
          // Each chip turns on and off by itself; with several on, their buses show together. The first one on
          // keeps what was selected before, and the last one off brings it back. A bus picked in the chip row
          // shows alone, with the others greyed out beside it
          const keys = new Set(activeKeys);
          const turningOn = !keys.has(key);
          if (turningOn) keys.add(key); else keys.delete(key);
          if (!this._applyQuickFilters(keys)) return;
          // Like the bus pills, the map fits the buses picked; the AI chip fits the changes the documents make.
          // Not while In view is on: it's about the screen as it is, and moving the map would change what it holds
          if (turningOn && !keys.has('inview')) {
            const box = key === 'aifocus' && B.aiFocus ? B.aiFocus.box() : null;
            if (key === 'scope') this._fitProjectScope();
            else if (box) this.renderer.fitToBounds(box, { left: 340, right: 350, top: 90, bottom: 90 }, { maxZoom: 1.2, minSize: 900 });
            else this._focusOnSelectedBuses();
          }
        });
      });
    }

    hasActiveDetour(routeId) {
      const r = typeof routeId === 'object' ? routeId : (this.store && this.store.doc.routes[routeId]);
      if (!r || r.isChunk || !r.detourApplied) return false;

      const rejectedSet = this.store.rejectedConstraintEdges ? this.store.rejectedConstraintEdges(r) : new Set();
      if (rejectedSet.size > 0) return true;

      const hasClosures = (this.store.closedSet && this.store.closedSet.size > 0) ||
                          (this.store.doc.closures && Object.keys(this.store.doc.closures).length > 0);
      const hasAreas = (this.store.doc.areas && Object.keys(this.store.doc.areas).length > 0) ||
                       (this.store.affected && this.store.affected.size > 0);
      if (!hasClosures && !hasAreas) return false;

      const checkAnchors = r.originalAnchors || r.anchors;
      const gCheck = this.store.computeRoute({ anchors: checkAnchors, kind: 'existing' });
      const isAffected = (gCheck.conflicts && gCheck.conflicts.length > 0) ||
                         (gCheck.stopsOnClosed && gCheck.stopsOnClosed.length > 0) ||
                         (gCheck.legs && gCheck.legs.some(l => l.ok && l.segs && l.segs.some(sg => this.store.closedSet.has(sg.edge) || (this.store.affected && this.store.affected.has(sg.edge)))));
      return !!isAffected;
    }

    _renderRoutePills() {
      this._renderQuickFilters();
      const container = document.getElementById('route-pills-row');
      if (!container) return;

      const allRoutes = Object.values(this.store.doc.routes);
      if (!allRoutes.length) {
        container.innerHTML = '';
        return;
      }

      const isAreaFilterActive = this.areaFilterPolygon && this.areaFilterPassingIds;
      const running = this._runningBusNumbers();
      const displayRoutes = allRoutes
        .filter((r) => !isAreaFilterActive || this.areaFilterPassingIds.has(r.id))
        .filter((r) => !running || running.has(String(r.number).trim()));

      if ((isAreaFilterActive || running) && displayRoutes.length === 0) {
        container.innerHTML = `
          <div class="route-pills-filter-empty">
            <span>${running ? 'No buses running then' : 'No buses in this area'}</span>
          </div>
        `;
        return;
      }

      // In bus-number order; once some buses are picked (by a filter or by hand), only those show
      const picked = (g) => g.ids.some((rid) => this.selectedRouteIds.has(rid));
      const groups = this._busGroups(displayRoutes).sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
      const allShownOn = groups.every(picked);
      const displayGroups = allShownOn ? [] : groups.filter(picked);

      const hasBuses = displayGroups.length > 0;

      if (!hasBuses) {
        container.innerHTML = '';
        return;
      }

      let html = '';

      if (hasBuses) {
        html += `
          <div class="selected-bus-pills" style="display: flex; flex-wrap: wrap; gap: 5px; width: 100%;">
            ${displayGroups.map((g) => {
              const isAffected = g.routes.some((r) => this.isRouteAffected(r));
              return `
                <button type="button"
                  class="route-chip-btn highlighted ${isAffected ? 'is-affected' : ''}"
                  data-route-ids="${g.ids.join(',')}"
                  data-bus-number="${B.esc(g.number)}"
                  style="background: ${g.color}; color: #ffffff;"
                  title="Click to navigate to Bus ${B.esc(g.number)}">
                  <span>${B.esc(g.number)}</span>
                </button>
              `;
            }).join('')}
          </div>
        `;
      }

      container.innerHTML = html;

      // Click on bus pill -> navigate to bus (remove it by unticking it in the search list)
      container.querySelectorAll('.route-chip-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const ids = (btn.dataset.routeIds || '').split(',').filter(Boolean);
          if (!ids.length) return;

          // User clicks the pill: navigate to this bus!
          const rObj = this.store.doc.routes[ids[0]];
          if (rObj) {
            this.renderer.selected = { type: 'route', id: ids[0], obj: rObj };
            this._showInspector(this.renderer.selected);
            this._focusOnRoute(rObj);
            this.renderer.requestRender();
          }
        });
      });

      // Click on entity card -> navigate to entity; click ✕ -> remove
      container.querySelectorAll('.selected-entity-card').forEach((card) => {
        card.addEventListener('click', (e) => {
          if (e.target.closest('.entity-card-remove-btn')) return;
          const entId = card.dataset.entityId;
          const ent = this.selectedEntities.get(entId);
          if (ent) {
            this._glideToEntity(ent);
          }
        });
        const removeBtn = card.querySelector('.entity-card-remove-btn');
        if (removeBtn) {
          removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const entId = card.dataset.entityId;
            this.removeSelectedEntity(entId);
          });
        }
      });
    }

    // Fits the map to a single route's line (e.g. focused chunk), clear of side panels
    _focusOnRoute(r, instant = true) {
      if (!r) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const g = this.store.geom[r.id];
      for (const l of (g && g.legs) || []) {
        for (const p of l.pts || []) {
          if (p.x < x0) x0 = p.x;
          if (p.y < y0) y0 = p.y;
          if (p.x > x1) x1 = p.x;
          if (p.y > y1) y1 = p.y;
        }
      }
      if (!isFinite(x0)) {
        for (const a of r.anchors || []) {
          const st = this.store.doc.stops[a.id];
          if (st) {
            if (st.x < x0) x0 = st.x;
            if (st.y < y0) y0 = st.y;
            if (st.x > x1) x1 = st.x;
            if (st.y > y1) y1 = st.y;
          }
        }
      }
      if (!isFinite(x0)) return;
      const pad = 60;
      this._fitClearOfPanels({ x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad }, { instant });
    }

    // Fits the map to the picked buses' whole lines, clear of the side panels and the toolbar
    _focusOnSelectedBuses(instant = true) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const rid of this.selectedRouteIds) {
        const g = this.store.geom[rid];
        for (const l of (g && g.legs) || []) {
          for (const p of l.pts || []) {
            if (p.x < x0) x0 = p.x;
            if (p.y < y0) y0 = p.y;
            if (p.x > x1) x1 = p.x;
            if (p.y > y1) y1 = p.y;
          }
        }
      }
      if (!isFinite(x0)) return;
      this._fitClearOfPanels({ x0, y0, x1, y1 }, { instant });
    }

    // Fits the map to a box, clear of the side panels and the toolbar
    _fitClearOfPanels(bounds, opts = {}) {
      const R = this.renderer;
      const view = R.canvas.getBoundingClientRect();
      const shown = (el) => el && el.offsetParent !== null && getComputedStyle(el).display !== 'none' && !el.classList.contains('hidden');
      const insets = { left: 20, right: 20, top: 20, bottom: 20 };
      const header = document.getElementById('top-header');
      if (header) insets.top = header.getBoundingClientRect().bottom - view.top + 12;
      const legend = document.getElementById('legend-panel');
      if (shown(legend)) insets.left = legend.getBoundingClientRect().right - view.left + 16;
      // Room on the right for the open panels
      for (const id of ['inspector-panel', 'changes-panel']) {
        const el = document.getElementById(id);
        if (shown(el)) insets.right = Math.max(insets.right, view.right - el.getBoundingClientRect().left + 16);
      }
      const toolbar = document.getElementById('toolbar-floating');
      if (shown(toolbar)) insets.bottom = view.bottom - toolbar.getBoundingClientRect().top + 12;
      R.fitToBounds(bounds, insets, opts);
    }

    // ------------------------------------------------------------- Operating time filter
    _isTimeFilterActive() {
      return this.timeFilter.from !== '00:00' || this.timeFilter.to !== '23:59';
    }

    _isDayFilterActive() {
      return this.dayFilter.length < 7;
    }

    // Bus numbers running at some point in the chosen window and days, or null when that's all day, every day
    _runningBusNumbers() {
      const days = this._isDayFilterActive() ? this.dayFilter : null;
      if (!this._isTimeFilterActive() && !days) return null;
      return B.runningBusNumbers(this.store.doc, this.timeFilter.from, this.timeFilter.to, days);
    }

    // "Mon–Fri, 07:00 – 09:00": what the day and time filters are set to
    _whenFilterLabel() {
      return [
        this._isDayFilterActive() ? B.daysLabel(this.dayFilter) : '',
        this._isTimeFilterActive() ? `${this.timeFilter.from} – ${this.timeFilter.to}` : '',
      ].filter(Boolean).join(', ');
    }

    _applyTimeFilter() {
      const timeOn = this._isTimeFilterActive();
      const daysOn = this._isDayFilterActive();
      this.renderer.timeWindow = (timeOn || daysOn) ? { ...this.timeFilter, days: daysOn ? this.dayFilter.slice() : null } : null;
      const row = document.getElementById('filter-time-row');
      if (row) row.classList.toggle('active', timeOn);
      const reset = document.getElementById('filter-time-reset');
      if (reset) reset.hidden = !timeOn;
      document.querySelectorAll('#filter-days .day-chip').forEach((chip) => {
        const on = this.dayFilter.includes(Number(chip.dataset.day));
        chip.classList.toggle('on', on);
        chip.setAttribute('aria-pressed', String(on));
      });
      const dayReset = document.getElementById('filter-days-reset');
      if (dayReset) dayReset.hidden = !daysOn;
      this._filterRouteDropdown(this.routeSearchQuery);
      this._applyRouteMultiSelection();
    }

    // Only show bus types that are allowed to pass through this stop
    _busTypesHtml(types) {
      const allowed = B.BUS_MODELS.filter((m) => types.includes(m));
      if (!allowed.length) return '<span class="text-muted" style="font-size: 11.5px; font-style: italic;">None</span>';
      return `<span class="bus-types">${allowed.map((m) => `<span class="bus-type">${m}</span>`).join('')}</span>`;
    }

    // M T W T F S S with the bus's days filled in; buttons when they can be changed
    _dayDotsHtml(days, editable = false) {
      const on = new Set(days);
      return `<span class="day-dots" title="${B.esc(B.daysLabel(days))}">${B.DAY_LETTERS.map((l, i) => editable
        ? `<button type="button" class="day-dot ${on.has(i) ? 'on' : ''}" data-day="${i}" aria-pressed="${on.has(i)}" title="${B.DAY_NAMES[i]}">${l}</button>`
        : `<span class="day-dot ${on.has(i) ? 'on' : ''}" title="${B.DAY_NAMES[i]}">${l}</span>`).join('')}</span>`;
    }

    // One entry per bus number: every route record with that number is one bus line
    _busGroups(routes) {
      const groups = new Map();
      for (const r of routes) {
        const num = String(r.number).trim();
        if (!groups.has(num)) groups.set(num, { number: num, color: r.color || '#2563eb', ids: [], routes: [] });
        const g = groups.get(num);
        g.ids.push(r.id);
        g.routes.push(r);
      }
      return [...groups.values()];
    }

    _selectedBusGroups() {
      return this._busGroups(Object.values(this.store.doc.routes))
        .filter((g) => g.ids.some((rid) => this.selectedRouteIds.has(rid)));
    }

    _updateRouteDropdown() {
      const allRoutes = Object.values(this.store.doc.routes);

      // If initial or all selected previously, ensure all route IDs are present
      if (this.isAllRoutesSelected || this.selectedRouteIds.size === 0) {
        this.selectedRouteIds = new Set(allRoutes.map((r) => r.id));
        this.isAllRoutesSelected = true;
      } else {
        // Prune any deleted routes
        for (const rid of this.selectedRouteIds) {
          if (!this.store.doc.routes[rid]) this.selectedRouteIds.delete(rid);
        }
      }

      if (this.selectedRouteIds.size === allRoutes.length) {
        this.renderer.visibleRouteIds = null;
      } else {
        this.renderer.visibleRouteIds = new Set(this.selectedRouteIds);
      }

      // Populate #ms-options-list
      const listContainer = document.getElementById('ms-options-list');
      if (listContainer) {
        listContainer.innerHTML = this._busGroups(allRoutes).map((g) => {
          const isSel = g.ids.some((rid) => this.selectedRouteIds.has(rid));
          const isAffected = g.routes.some((r) => this.isRouteAffected(r));
          const isActive = B.busActive(this.store.doc, g.number);
          const maxDisruptedFrac = Math.max(0, ...g.routes.map((r) => this._routeDisruptedFraction(r)));
          const suggestSuspend = isActive && (maxDisruptedFrac > 0.5);
          const searchData = `bus ${g.number} ${g.routes.map((r) => r.name || '').join(' ')}`.toLowerCase();

          return `
            <div class="ms-option-row ${isSel ? 'selected' : ''} ${!isActive ? 'is-suspended' : ''}" data-route-ids="${g.ids.join(',')}" data-bus-number="${B.esc(g.number)}" data-search-text="${B.esc(searchData)}">
              <input type="checkbox" class="ms-chk" ${isSel ? 'checked' : ''} />
              <span class="route-badge" style="background: ${g.color}; color: #ffffff; padding: 2px 7px; font-weight: 800; font-size: 11px; border-radius: 5px;">${B.esc(g.number)}</span>
              ${g.routes.length > 1 ? `<span class="ms-chunks-badge" title="${g.routes.length} operating chunks">${g.routes.length} chunks</span>` : ''}
              ${!isActive ? '<span class="ms-suspended-badge">Suspended</span>' : (suggestSuspend ? '<span class="ms-ai-suspend-tag" title="Suspend route (>50% disrupted)">Suspend</span>' : '')}
              <button type="button" class="ms-bus-edit" title="Edit Bus ${B.esc(g.number)}" aria-label="Edit Bus ${B.esc(g.number)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg></button>
            </div>
          `;
        }).join('');

        // The pencil on each row edits that bus number (number, hours, delete)
        listContainer.querySelectorAll('.ms-bus-edit').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._closeBusDropdown();
            this._promptNewBus(btn.closest('.ms-option-row').dataset.busNumber);
          });
        });

        // Wire click on rows: a bus number toggles all of its route pieces together and opens its right sidebar
        listContainer.querySelectorAll('.ms-option-row').forEach((row) => {
          row.addEventListener('click', (e) => {
            e.stopPropagation();
            const ids = (row.dataset.routeIds || '').split(',').filter(Boolean);
            if (!ids.length) return;

            const allShownOn = (this.selectedRouteIds.size === allRoutes.length);
            if (allShownOn) {
              // Selecting a bus number when all are on focuses that bus number and opens its sidebar
              this.selectedRouteIds = new Set(ids);
            } else if (ids.some((rid) => this.selectedRouteIds.has(rid))) {
              ids.forEach((rid) => this.selectedRouteIds.delete(rid));
            } else {
              ids.forEach((rid) => this.selectedRouteIds.add(rid));
            }
            this.isAllRoutesSelected = (this.selectedRouteIds.size === allRoutes.length);
            this._applyRouteMultiSelection();

            if (ids.some((rid) => this.selectedRouteIds.has(rid))) {
              const rObj = this.store.doc.routes[ids[0]];
              if (rObj) {
                this.renderer.selected = { type: 'route', id: ids[0], obj: rObj };
                this._showInspector(this.renderer.selected);
              }
            } else if (!this.isAllRoutesSelected && this.selectedRouteIds.size > 0) {
              const nextId = [...this.selectedRouteIds][0];
              const rObj = this.store.doc.routes[nextId];
              if (rObj) {
                this.renderer.selected = { type: 'route', id: nextId, obj: rObj };
                this._showInspector(this.renderer.selected);
              }
            } else {
              this.renderer.selected = null;
              this._hideInspector();
            }
            this.renderer.requestRender();
          });
        });
      }

      // Apply search filter if active
      this._filterRouteDropdown(this.routeSearchQuery);

      // Update summary and checkboxes
      this._applyRouteMultiSelection();
    }

    _filterRouteDropdown(query = '') {
      this.routeSearchQuery = (query || '').trim().toLowerCase();
      const listContainer = document.getElementById('ms-options-list');
      const clearBtn = document.getElementById('ms-search-clear');
      if (clearBtn) {
        clearBtn.classList.toggle('hidden', !this.routeSearchQuery);
      }
      if (!listContainer) return;

      const rows = listContainer.querySelectorAll('.ms-option-row');
      const running = this._runningBusNumbers();
      let visibleCount = 0;

      rows.forEach((row) => {
        const text = (row.dataset.searchText || '').toLowerCase();
        const matches = (!this.routeSearchQuery || text.includes(this.routeSearchQuery)) &&
          (!running || running.has(row.dataset.busNumber));
        row.style.display = matches ? 'flex' : 'none';
        if (matches) visibleCount++;
      });

      let noResEl = listContainer.querySelector('.ms-no-results');
      if (visibleCount === 0) {
        if (!noResEl) {
          noResEl = document.createElement('div');
          noResEl.className = 'ms-no-results';
          listContainer.appendChild(noResEl);
        }
        noResEl.textContent = this.routeSearchQuery ? `No bus numbers match "${this.routeSearchQuery}"` : 'No buses running then';
      } else if (noResEl) {
        noResEl.remove();
      }
    }

    _selectRouteFromDropdown(routeId) {
      if ((!routeId || routeId === 'all') && this.areaFilterPolygon) {
        this._clearAreaFilter();
        return;
      }
      if (!routeId || routeId === 'all') {
        const allRoutes = Object.keys(this.store.doc.routes);
        this.selectedRouteIds = new Set(allRoutes);
        this.isAllRoutesSelected = true;
        this._applyRouteMultiSelection();
        this._showToast('Showing all buses', 'info');
        return;
      }

      const r = this.store.doc.routes[routeId];
      if (!r) return;

      if (this.selectedRouteIds.has(r.id)) {
        this.selectedRouteIds.delete(r.id);
      } else {
        this.selectedRouteIds.add(r.id);
      }
      this.isAllRoutesSelected = (this.selectedRouteIds.size === Object.keys(this.store.doc.routes).length);
      this._applyRouteMultiSelection();
      if (this.selectedRouteIds.has(r.id)) {
        this.renderer.selected = { type: 'route', id: r.id, obj: r };
        this._showInspector(this.renderer.selected);
        this.renderer.requestRender();
      }
    }

    _updateRouteOperationCard(specificRouteId = null) {
      const box = document.getElementById('route-operation-box');
      if (!box) return;

      // Do not direct to next page of information when selecting bus numbers
      box.innerHTML = '';
      box.style.display = 'none';
    }

    centerOnRoute(routeId) {
      const g = this.store.geom[routeId];
      if (g && g.legs && g.legs.length && g.legs[0].pts && g.legs[0].pts.length) {
        const midLeg = g.legs[Math.floor(g.legs.length / 2)];
        const pt = midLeg.pts[Math.floor(midLeg.pts.length / 2)];
        if (pt) {
          this.renderer.camera.x = pt.x;
          this.renderer.camera.y = pt.y;
          this.renderer.requestRender();
        }
      }
    }

    generateRandomRoutes(count = 6) {
      let generated = [];
      this.store.commit('Randomize Bus Numbers', (doc) => {
        doc.routes = {};
        generated = B.generateRandomRoutes(this.city, this.net, doc, count);
      });

      if (generated && generated.length > 0) {
        const first = generated[0];
        this._selectRouteFromDropdown(first.id);
        this._showToast(`${generated.length} bus numbers generated`, 'success');
      } else {
        this._updateRouteDropdown();
        this._showToast('Bus numbers generated', 'info');
      }
    }

    _showToast(msg, type = 'info', duration = 3500) {
      const container = document.getElementById('toast-container');
      if (!container) return null;

      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;

      const content = document.createElement('div');
      content.className = 'toast-content';
      content.innerHTML = msg;
      toast.appendChild(content);

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'toast-close-btn';
      closeBtn.setAttribute('aria-label', 'Close');
      closeBtn.title = 'Dismiss';
      closeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
      toast.appendChild(closeBtn);

      container.appendChild(toast);

      let fadeTimer = null;
      let removeTimer = null;
      const dismiss = () => {
        if (fadeTimer) clearTimeout(fadeTimer);
        if (removeTimer) clearTimeout(removeTimer);
        toast.classList.add('fade-out');
        removeTimer = setTimeout(() => {
          if (toast && toast.remove) toast.remove();
          else if (toast && toast.parentNode) toast.parentNode.removeChild(toast);
        }, 300);
      };

      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dismiss();
      });

      if (duration > 0) {
        fadeTimer = setTimeout(() => {
          dismiss();
        }, duration);
      }
      return toast;
    }

    // ------------------------------------------------------------- Polygon Area Filter Methods
    _startAreaFilterDrawing() {
      this.isDrawingAreaFilter = true;
      this.areaFilterPts = [];
      this.renderer.drawingAreaFilter = this.areaFilterPts;
      this.renderer.areaFilterPolygon = null;
      this.renderer.areaFilterPassingIds = null;
      this.renderer.hideAreaFilterOutline = false;
      this.renderer.canvas.style.cursor = 'crosshair';
      this._updateAreaFilterUI();
      this.renderer.requestRender();
      this._showToast('Click to draw an area · Double-click to finish', 'info');
    }

    _finishAreaFilterDrawing() {
      if (!this.areaFilterPts || this.areaFilterPts.length < 3) {
        this._cancelAreaFilterDrawing();
        return;
      }
      this.isDrawingAreaFilter = false;
      this.areaFilterPolygon = [...this.areaFilterPts];
      this.areaFilterOutlineHidden = false;
      this.renderer.hideAreaFilterOutline = false;
      this.renderer.areaFilterPolygon = this.areaFilterPolygon;
      this.renderer.drawingAreaFilter = null;
      this.renderer.drawingAreaFilterPreview = null;
      this.renderer.canvas.style.cursor = 'default';

      this._computeAreaFilterMatches();
      this._updateAreaFilterUI();
      this.renderer.selected = { type: 'area-filter' };
      this._showInspector(this.renderer.selected);
      this.renderer.requestRender();
    }

    _doesAreaOverlapPoly(area, polygon) {
      if (!area || !polygon || polygon.length < 3) return false;
      if (area.shape === 'circle') {
        const c = { x: area.cx, y: area.cy }, r = area.r || 100;
        if (B.pointInPoly(c, polygon)) return true;
        for (let i = 0; i < polygon.length; i++) {
          const p1 = polygon[i], p2 = polygon[(i + 1) % polygon.length];
          if (B.segD2(c, p1, p2) <= r * r) return true;
        }
        return false;
      }
      const poly = this.store.areaPoly(area);
      if (!poly || poly.length < 3) return false;
      for (const p of poly) {
        if (B.pointInPoly(p, polygon)) return true;
      }
      for (const p of polygon) {
        if (B.pointInPoly(p, poly)) return true;
      }
      return B.polylineIntersectsPoly(poly.concat([poly[0]]), polygon);
    }

    _focusSelectedTarget(target) {
      if (!target) return;
      if (target.type === 'route' || target.type === 'route-leg') {
        this._focusOnSelectedBuses();
        return;
      }
      let pt = null;
      if (target.type === 'stop' || target.type === 'terminal') {
        const s = target.obj || (this.store && this.store.doc.stops[target.id || target.stopId]);
        if (s) pt = this.net.posPoint(s, 0.78);
      } else if (target.type === 'mrt') {
        const m = target.obj || ((this.city.mrtStations || []).find((x) => x.id === target.id));
        if (m) pt = { x: m.x, y: m.y };
      } else if (target.type === 'road') {
        const e = target.edge || this.net.edge(target.id);
        if (e && e.pts && e.pts.length) {
          const bb = B.bbox(e.pts, 200);
          this._fitClearOfPanels(bb);
          return;
        }
      } else if (target.type === 'area') {
        const a = target.obj || (this.store && this.store.doc.areas[target.id]);
        if (a) {
          const poly = this.store.areaPoly(a);
          if (poly.length) {
            this._fitClearOfPanels(B.bbox(poly, 250));
            return;
          }
        }
      } else if (target.type === 'closure') {
        const e = this.net.edge(target.id);
        if (e && e.pts && e.pts.length) {
          this._fitClearOfPanels(B.bbox(e.pts, 200));
          return;
        }
      } else if (target.type === 'postal' || target.type === 'address') {
        if (isFinite(target.x) && isFinite(target.y)) pt = { x: target.x, y: target.y };
      }

      if (pt && isFinite(pt.x) && isFinite(pt.y)) {
        const pad = 320;
        this._fitClearOfPanels({ x0: pt.x - pad, y0: pt.y - pad, x1: pt.x + pad, y1: pt.y + pad });
      }
    }

    _cancelAreaFilterDrawing() {
      this.isDrawingAreaFilter = false;
      this.areaFilterPts = [];
      this.renderer.drawingAreaFilter = null;
      this.renderer.drawingAreaFilterPreview = null;
      // A cancelled redraw leaves the previous filter as it was
      this.renderer.areaFilterPolygon = this.areaFilterPolygon;
      this.renderer.areaFilterPassingIds = this.areaFilterPassingIds;
      this.renderer.hideAreaFilterOutline = this.areaFilterOutlineHidden;
      this.renderer.canvas.style.cursor = 'default';
      this._updateAreaFilterUI();
      this.renderer.requestRender();
    }

    _clearAreaFilter() {
      this.isDrawingAreaFilter = false;
      this.areaFilterPts = [];
      this.areaFilterPolygon = null;
      this.areaFilterPassingRoutes = [];
      this.areaFilterPassingIds = null;
      this.areaFilterSelectedRouteIds = null;
      this.areaFilterOutlineHidden = false;
      const allRoutes = Object.values(this.store.doc.routes);
      this.selectedRouteIds = new Set(allRoutes.map((r) => r.id));
      this.isAllRoutesSelected = true;
      if (this.renderer) {
        this.renderer.areaFilterPolygon = null;
        this.renderer.drawingAreaFilter = null;
        this.renderer.drawingAreaFilterPreview = null;
        this.renderer.areaFilterPassingIds = null;
        this.renderer.areaFilterSelectedRouteIds = null;
        this.renderer.areaFilterPassingCount = 0;
        this.renderer.visibleRouteIds = null;
        this.renderer.filterMapToArea = false;
        this.renderer.hideAreaFilterOutline = false;
        this.renderer.requestRender();
      }
      this._applyRouteMultiSelection();
      this._renderRoutePills();
      this._updateAreaFilterUI();
      this._showToast('Area filter cleared', 'info');
    }

    // A click on the map hides the drawn area; the buses it filtered stay filtered
    _hideAreaFilterOutline() {
      if (!this.areaFilterPolygon || this.isDrawingAreaFilter || this.areaFilterOutlineHidden) return false;
      this.areaFilterOutlineHidden = true;
      this.renderer.hideAreaFilterOutline = true;
      if (this.renderer.selected && this.renderer.selected.type === 'area-filter') {
        this.renderer.selected = null;
        this._hideInspector();
      }
      this.renderer.requestRender();
      return true;
    }

    _computeAreaFilterMatches() {
      if (!this.areaFilterPolygon || this.areaFilterPolygon.length < 3) {
        this.areaFilterPassingRoutes = [];
        this.areaFilterPassingIds = null;
        if (this.renderer) {
          this.renderer.areaFilterPassingIds = null;
          this.renderer.areaFilterPassingCount = 0;
          this.renderer.visibleRouteIds = null;
          this.renderer.filterMapToArea = false;
        }
        return;
      }

      const passing = [];
      const passingIds = new Set();
      const allRoutes = Object.values(this.store.doc.routes);

      for (const r of allRoutes) {
        if (this.doesRoutePassArea(r, this.areaFilterPolygon)) {
          let stopsInside = 0;
          if (r.anchors) {
            for (const a of r.anchors) {
              if (a.t === 'stop') {
                const s = this.store.doc.stops[a.id];
                if (s) {
                  const pt = this.net.posPoint(s, 0.78);
                  if (B.pointInPoly(pt, this.areaFilterPolygon)) stopsInside++;
                }
              }
            }
          }
          passing.push({
            route: r,
            stopsInside
          });
          passingIds.add(r.id);
        }
      }

      this.areaFilterPassingRoutes = passing;
      this.areaFilterPassingIds = passingIds;
      this.areaFilterSelectedRouteIds = new Set(passingIds);
      this.selectedRouteIds = new Set(passingIds);

      if (this.renderer) {
        this.renderer.areaFilterPassingIds = passingIds;
        this.renderer.areaFilterPassingCount = passing.length;
        this.renderer.filterMapToArea = true;
        this.renderer.areaFilterSelectedRouteIds = this.areaFilterSelectedRouteIds;
        this.renderer.visibleRouteIds = new Set(passingIds);
      }

      this._applyRouteMultiSelection();
      this._renderRoutePills();
      this._showToast(
        passing.length > 0
          ? `${passing.length} bus${passing.length === 1 ? '' : 'es'} in this area`
          : 'No buses in this area',
        passing.length > 0 ? 'info' : 'warn'
      );
    }

    doesRoutePassArea(r, polygon) {
      if (!r || !polygon || polygon.length < 3) return false;
      const g = this.store.geom[r.id];

      // 1. Check all route legs geometry
      if (g && g.legs) {
        for (const leg of g.legs) {
          if (!leg.ok || !leg.pts || leg.pts.length < 2) continue;
          if (B.polylineIntersectsPoly(leg.pts, polygon)) return true;
        }
      }

      // 2. Check stops along the route
      if (r.anchors) {
        for (const a of r.anchors) {
          if (a.t === 'stop') {
            const st = this.store.doc.stops[a.id];
            if (st) {
              const pt = this.net.posPoint(st, 0.78);
              if (B.pointInPoly(pt, polygon)) return true;
            }
          }
        }
      }

      return false;
    }

    _updateAreaFilterUI() {
      const btnDraw = document.getElementById('btn-draw-area-filter');
      if (!btnDraw) return;

      if (this.isDrawingAreaFilter) {
        btnDraw.classList.add('drawing-active');
        btnDraw.classList.remove('filter-active');
        btnDraw.setAttribute('title', 'Drawing an area: click to add points, double-click to finish, Esc to cancel');
        return;
      }

      // Not drawing
      btnDraw.classList.remove('drawing-active');
      if (this.areaFilterPolygon && this.areaFilterPolygon.length >= 3) {
        btnDraw.classList.add('filter-active');
        const count = this.areaFilterPassingRoutes ? this.areaFilterPassingRoutes.length : 0;
        btnDraw.setAttribute('title', `${count} bus${count === 1 ? '' : 'es'} in the area. Click to clear it`);
      } else {
        btnDraw.classList.remove('filter-active');
        btnDraw.setAttribute('title', 'Draw an area to see the buses in it');
      }
    }

    _initLegendCollapsibles() {
      const setupCollapse = (headerId, bodyId, iconId) => {
        const header = document.getElementById(headerId);
        const body = document.getElementById(bodyId);
        const icon = document.getElementById(iconId);
        if (!header || !body) return;

        const toggle = (e) => {
          if (e && e.target && e.target.closest && e.target.closest('button, input, select')) return;
          if (e && e.stopPropagation) e.stopPropagation();
          const isCollapsed = body.classList.toggle('collapsed');
          header.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
        };

        header.addEventListener('click', toggle);
        header.addEventListener('keydown', (e) => {
          if (e && e.target && e.target.closest && e.target.closest('button, input, select')) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle(e);
          }
        });
      };

      setupCollapse('header-current-map', 'body-current-map', 'collapse-icon-current-map');
      setupCollapse('header-projects', 'body-projects', 'collapse-icon-projects');
      setupCollapse('header-layers', 'body-layers', 'collapse-icon-layers');
    }

    _initProjects() {
      this.mainProject = {
        id: 'main',
        name: 'Current Map',
        mode: 'view',
        isMain: true
      };

      let saved = null;
      try {
        const raw = localStorage.getItem('brass_projects_list');
        if (raw) saved = JSON.parse(raw);
      } catch (e) {}

      if (!Array.isArray(saved)) saved = [];

      // Ensure all loaded projects have basic valid fields & sanitize project IDs to clean prj-N format:
      // e.g. proj-1 -> prj-1, and timestamp IDs like proj-1794120738785 -> prj-2, prj-3, etc.
      let migratedAny = false;
      const usedNums = new Set();

      saved.forEach((p, idx) => {
        const oldId = p.id;
        let targetId = oldId;

        if (oldId === 'proj-1') {
          targetId = 'prj-1';
        } else if (!oldId || /^(?:proj|prj)-\d{10,}$/.test(oldId)) {
          const m = (p.name || '').match(/^Project\s+(\d+)$/i);
          let num = m ? parseInt(m[1], 10) : (idx + 1);
          while (usedNums.has(num)) num++;
          targetId = `prj-${num}`;
        } else if (/^proj-(\d+)$/i.test(oldId)) {
          const m = oldId.match(/^proj-(\d+)$/i);
          targetId = `prj-${m[1]}`;
        }

        const mTarget = (targetId || '').match(/^prj-(\d+)$/i);
        if (mTarget) usedNums.add(parseInt(mTarget[1], 10));

        if (oldId && targetId && oldId !== targetId) {
          try {
            const doc = localStorage.getItem('brass_proj_doc_' + oldId);
            if (doc && !localStorage.getItem('brass_proj_doc_' + targetId)) {
              localStorage.setItem('brass_proj_doc_' + targetId, doc);
            }
            const base = localStorage.getItem('brass_proj_base_' + oldId);
            if (base && !localStorage.getItem('brass_proj_base_' + targetId)) {
              localStorage.setItem('brass_proj_base_' + targetId, base);
            }
            if (localStorage.getItem('brass_active_project_id') === oldId) {
              localStorage.setItem('brass_active_project_id', targetId);
            }
          } catch (e) {}
          p.id = targetId;
          migratedAny = true;
        }

        if (!p.owner) {
          p.owner = { name: 'John Doe', email: 'john.doe@brass.sg', role: 'Bus Ops' };
        }
        if (!p.status) {
          p.status = 'progress';
        }
      });

      if (migratedAny) {
        try {
          localStorage.setItem('brass_projects_list', JSON.stringify(saved));
        } catch (e) {}
      }

      this.projects = saved;
      const savedActiveId = localStorage.getItem('brass_active_project_id');
      this.activeProjectId = (savedActiveId === 'main' || this.projects.some((p) => p.id === savedActiveId))
        ? savedActiveId
        : (this.projects[0] ? this.projects[0].id : 'main');

      this.editingProjectId = null;
      if (this.activeProjectId && this.activeProjectId !== 'main') {
        this.expandedProjectIds.add(this.activeProjectId);
      }

      // Seed & load the active project's draft doc
      const activeDraft = this._loadProjectDraft(this.activeProjectId);
      this._prepareForeignBlocked(activeDraft);
      this.store.loadDoc(activeDraft, { label: 'Initialize project draft' });

      const btnCreate = document.getElementById('btn-create-project');
      if (btnCreate) {
        btnCreate.addEventListener('click', (e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          this._createNewProject();
        });
      }

      // Current Map (Main) row listeners: clicking the card views current live map in View Mode
      const btnViewCurrentMap = document.getElementById('btn-view-current-map');
      if (btnViewCurrentMap) {
        btnViewCurrentMap.addEventListener('click', (e) => {
          e.stopPropagation();
          this._switchProject('main', 'view');
        });
      }

      const btnHistory = document.getElementById('btn-current-map-history');
      if (btnHistory) {
        btnHistory.addEventListener('click', (e) => {
          e.stopPropagation();
          this._toggleMapHistory();
        });
      }

      this._initHeaderProject();
      this._renderProjects();
    }

    // ------------------------------------------------------------- Header Project, Save & Undo/Redo
    _initHeaderProject() {
      const btnSave = document.getElementById('btn-header-save');
      const btnUndo = document.getElementById('btn-header-undo');
      const btnRedo = document.getElementById('btn-header-redo');

      this._lastSavedDoc = JSON.stringify(this.store.doc);
      if (!this._lastSavedAt) {
        const p0 = this.activeProjectId === 'main'
          ? this.mainProject
          : (this.projects ? this.projects.find((p) => p.id === this.activeProjectId) : null);
        this._lastSavedAt = (p0 && p0.updatedAt) || Date.now();
      }

      if (btnSave) {
        btnSave.addEventListener('click', () => {
          if (!this._checkBusesConnected(this.store.doc)) return;
          this.store.save();
          this._saveCurrentProjectDraft(false);
          this._lastSavedDoc = JSON.stringify(this.store.doc);
          this._lastSavedAt = Date.now();
          this._updateSaveButton();

          btnSave.classList.add('saved-flash');
          setTimeout(() => {
            btnSave.classList.remove('saved-flash');
          }, 350);

          const activeProj = this.activeProjectId === 'main'
            ? this.mainProject
            : (this.projects ? this.projects.find((p) => p.id === this.activeProjectId) : null);
          const projName = activeProj ? activeProj.name : 'Project';
          if (this._showToast) this._showToast(`${projName} saved`, 'success');
        });
      }

      if (btnUndo) {
        btnUndo.addEventListener('click', () => {
          const undone = this.store.undo();
          if (undone && this._showToast) this._showToast(`Undone: ${undone}`, 'info');
          this._updateHistoryButtons();
          this._updateSaveButton();
        });
      }

      if (btnRedo) {
        btnRedo.addEventListener('click', () => {
          const redone = this.store.redo();
          if (redone && this._showToast) this._showToast(`Redone: ${redone}`, 'info');
          this._updateHistoryButtons();
          this._updateSaveButton();
        });
      }

      this._updateHistoryButtons();
      this._updateSaveButton();
    }

    _updateSaveButton() {
      const btnSave = document.getElementById('btn-header-save');
      const btnSaveText = document.getElementById('btn-header-save-text');
      if (!btnSave) return;

      const currentDocStr = JSON.stringify(this.store.doc);
      if (this._lastSavedDoc === undefined) {
        this._lastSavedDoc = currentDocStr;
      }

      const isSaved = (currentDocStr === this._lastSavedDoc);

      btnSave.classList.toggle('is-saved', isSaved);
      const t = new Date(this._lastSavedAt || Date.now());
      const timeStr = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      if (btnSaveText) {
        btnSaveText.textContent = isSaved ? 'Saved' : 'Save';
      }
      btnSave.title = isSaved
        ? `All changes saved at ${timeStr}`
        : `Last saved at ${timeStr} — click to save (Cmd+S / Ctrl+S)`;
    }

    // Undo and Redo each show only when there's something to undo or redo; with neither, the group goes too
    _updateHistoryButtons() {
      const btnUndo = document.getElementById('btn-header-undo');
      const btnRedo = document.getElementById('btn-header-redo');
      const canUndo = !!(this.store && Array.isArray(this.store.past) && this.store.past.length > 0);
      const canRedo = !!(this.store && Array.isArray(this.store.future) && this.store.future.length > 0);

      if (btnUndo) {
        btnUndo.disabled = !canUndo;
        btnUndo.hidden = !canUndo;
        const lastPast = canUndo ? this.store.past[this.store.past.length - 1] : null;
        btnUndo.title = `Undo ${lastPast && lastPast.label ? `"${lastPast.label}" ` : ''}(Cmd+Z / Ctrl+Z)`;
      }
      if (btnRedo) {
        btnRedo.disabled = !canRedo;
        btnRedo.hidden = !canRedo;
        const nextFuture = canRedo ? this.store.future[this.store.future.length - 1] : null;
        btnRedo.title = `Redo ${nextFuture && nextFuture.label ? `"${nextFuture.label}" ` : ''}(Cmd+Shift+Z / Ctrl+Y)`;
      }
      const group = document.querySelector('.header-history-btns');
      if (group) group.hidden = !canUndo && !canRedo;
    }

    _updateHeaderProjectDisplay() {
      const activeProj = this.activeProjectId === 'main'
        ? this.mainProject
        : (this.projects ? this.projects.find((p) => p.id === this.activeProjectId) : null);
      const projName = this.reviewMode ? (this.reviewName || 'Project') : (activeProj ? activeProj.name : 'Current Map');
      const projCode = this.reviewMode
        ? (this.reviewCode || '')
        : (activeProj ? (activeProj.code || activeProj.id || '') : '');

      const nameEl = document.getElementById('header-selected-project-name');
      if (nameEl) {
        nameEl.textContent = projName;
      }

      const idEl = document.getElementById('header-selected-project-id');
      const periodEl = document.getElementById('header-selected-project-period');
      if (idEl) {
        if (projCode && projCode !== 'main') {
          idEl.textContent = projCode.startsWith('ID:') ? projCode : `ID: ${projCode}`;
          idEl.hidden = false;
        } else {
          idEl.hidden = true;
        }
      }
      if (periodEl) {
        if (projCode && projCode !== 'main' && activeProj) {
          const isPerm = (activeProj.applyPeriod || {}).mode === 'permanent' || (activeProj.applyPeriod && activeProj.applyPeriod.mode !== 'scheduled');
          periodEl.textContent = isPerm ? 'Permanent' : 'Temporary';
          periodEl.className = `header-project-period ${isPerm ? 'is-permanent' : 'is-temporary'}`;
          periodEl.hidden = false;
        } else {
          periodEl.hidden = true;
        }
      }

      const btnEl = document.getElementById('header-selected-project');
      if (btnEl) {
        const isMain = !this.reviewMode && this.activeProjectId === 'main';
        btnEl.title = `Active: ${projName}${projCode && projCode !== 'main' ? ` (${projCode})` : ''}${isMain ? ' (Main Map)' : ''}`;
      }

      this._updateHistoryButtons();
    }

    _saveProjects() {
      if (this.reviewMode) return;
      try {
        localStorage.setItem('brass_projects_list', JSON.stringify(this.projects));
        localStorage.setItem('brass_active_project_id', this.activeProjectId);
      } catch (e) {}
    }

    _markProjectInProgress(projId = this.activeProjectId) {
      if (!projId || projId === 'main' || this.reviewMode || !this.projects) return;
      const p = this.projects.find((x) => x.id === projId);
      if (p && (!p.status || p.status === 'not_started')) {
        p.status = 'progress';
        delete p.manualNotStarted;
        p.updatedAt = Date.now();
        this._saveProjects();
      }
    }

    _saveCurrentProjectDraft(showFeedback = false) {
      if (!this.activeProjectId || this._isReadOnlyView()) return;
      try {
        const key = 'brass_proj_doc_' + this.activeProjectId;
        const docStr = JSON.stringify(this.store.doc);
        // The draft as it's stored: the same as what's there already means nothing changed since the last save,
        // so it isn't written again and the project doesn't count as updated
        let stored = docStr;
        try { if (B.docPatch && B.storedRaw) stored = '~d' + JSON.stringify(B.docPatch(this.store.doc)); } catch (e) { stored = docStr; }
        const changed = stored !== (B.storedRaw ? B.storedRaw(key) : null);
        if (changed) {
          localStorage.setItem(key, stored);
          if (this.activeProjectId === 'main') localStorage.setItem(this.store.KEY, docStr);
        }
        this.store.saved = docStr;

        const activeProj = this.activeProjectId === 'main'
          ? this.mainProject
          : (this.projects ? this.projects.find((p) => p.id === this.activeProjectId) : null);

        if (activeProj) {
          activeProj.mode = this.mode;
          if (changed) activeProj.updatedAt = Date.now();
          if (this.activeProjectId !== 'main') {
            this._saveProjects();
          }
        }

        if (showFeedback) {
          this._lastSavedDoc = JSON.stringify(this.store.doc);
          this._lastSavedAt = Date.now();
          this._updateSaveButton();
          const btnSave = document.getElementById('btn-header-save');
          if (btnSave) {
            btnSave.classList.add('saved-flash');
            setTimeout(() => {
              btnSave.classList.remove('saved-flash');
            }, 350);
          }
          const projName = activeProj ? activeProj.name : 'Project';
          if (this._showToast) this._showToast(`${projName} saved`, 'success');
        }
        if (this._storedDocs) this._storedDocs.delete('brass_proj_doc_' + this.activeProjectId);
        this._foreignKey = null;
        this._syncForeignObstacles();
      } catch (e) {
        console.warn('Failed to save project draft', e);
      }
    }

    _loadProjectDraft(projId) {
      if (projId === 'main') {
        let rawMain = null;
        try {
          rawMain = localStorage.getItem('brass_proj_doc_main');
        } catch (e) {}
        if (rawMain && this.store._validDoc(rawMain)) {
          return JSON.parse(rawMain);
        }
        try {
          const legacy = localStorage.getItem(this.store.KEY);
          if (legacy && this.store._validDoc(legacy)) {
            return JSON.parse(legacy);
          }
        } catch (e) {}
        const base = this.store.baseTemplate
          ? JSON.parse(this.store.baseTemplate)
          : (this.store.sample ? JSON.parse(this.store.sample) : JSON.parse(JSON.stringify(this.store.doc)));
        return base;
      }

      let raw = null;
      try {
        raw = localStorage.getItem('brass_proj_doc_' + projId)
          || (projId === 'prj-1' ? localStorage.getItem('brass_proj_doc_proj-1') : null)
          || (projId === 'proj-1' ? localStorage.getItem('brass_proj_doc_prj-1') : null);
      } catch (e) {}

      if (raw && this.store._validDoc(raw)) {
        return JSON.parse(raw);
      }

      // Check legacy doc for initial migration of Project 1
      if (projId === 'proj-1' || projId === 'prj-1' || (this.projects && this.projects[0] && (this.projects[0].id === projId || (this.projects[0].id === 'prj-1' && projId === 'proj-1')))) {
        try {
          const legacy = localStorage.getItem(this.store.KEY);
          if (legacy && this.store._validDoc(legacy)) {
            localStorage.setItem('brass_proj_doc_' + projId, legacy);
            return JSON.parse(legacy);
          }
        } catch (e) {}
      }

      // Fresh clean template draft
      const base = this.store.baseTemplate
        ? JSON.parse(this.store.baseTemplate)
        : (this.store.sample ? JSON.parse(this.store.sample) : JSON.parse(JSON.stringify(this.store.doc)));
      try {
        localStorage.setItem('brass_proj_base_' + projId, JSON.stringify(base));
      } catch (e) {}
      try {
        localStorage.setItem('brass_proj_doc_' + projId, JSON.stringify(base));
      } catch (e) {}
      return base;
    }

    _switchProject(targetProjectId, targetMode) {
      this.setBeforeView(false);
      this._toggleProjectChanges(false);
      this._markChangesNew(false);
      if (targetProjectId && this.projects && this.projects.length) {
        if (targetProjectId === 'proj-1' && !this.projects.some((p) => p.id === 'proj-1') && this.projects.some((p) => p.id === 'prj-1')) {
          targetProjectId = 'prj-1';
        } else if (targetProjectId === 'prj-1' && !this.projects.some((p) => p.id === 'prj-1') && this.projects.some((p) => p.id === 'proj-1')) {
          targetProjectId = 'proj-1';
        }
      }
      if (this.activeProjectId === targetProjectId && targetMode && this.mode !== targetMode) {
        this.setMode(targetMode);
        return;
      }
      if (this.activeProjectId === targetProjectId && !targetMode) {
        return;
      }

      // 1. Save current active project's draft first
      this._saveCurrentProjectDraft(false);

      // 2. Clean up transient drawing / connecting operations
      this.pendingNewBus = null;
      this._syncToolbar();
      if (this.activeConnectStopId) {
        this._cancelConnectingStops();
      }
      if (this.isDrawingAreaFilter) {
        this._cancelAreaFilterDrawing();
      }
      this.polyDrawingPts = [];
      this.routeDrawingAnchors = [];
      this.renderer.drawingArea = null;
      this.renderer.drawingRoute = null;
      this.renderer.snapTarget = null;
      this.renderer.connectingPreview = null;
      this.renderer.activeConnectStopId = null;
      this.renderer.selected = null;
      this._hideInspector();
      this._hideFloatingLegActions();
      this._hideFloatingStopActions();

      // 3. Switch active project ID
      this.activeProjectId = targetProjectId;
      if (targetProjectId !== 'main') {
        this.expandedProjectIds.add(targetProjectId);
      }
      try {
        localStorage.setItem('brass_active_project_id', targetProjectId);
      } catch (e) {}

      // 4. Load target project's draft doc
      if (targetProjectId === 'main') {
        this._processScheduledChanges();
      }
      const draftDoc = this._loadProjectDraft(targetProjectId);
      this._prepareForeignBlocked(draftDoc);
      this.store.loadDoc(draftDoc, { label: `Switch to ${targetProjectId}` });
      this._lastSavedDoc = JSON.stringify(this.store.doc);

      // 5. Reset route selection & filters so all routes of this project are visible
      this.isAllRoutesSelected = true;
      this.selectedRouteIds = new Set(Object.keys(this.store.doc.routes));
      this.renderer.visibleRouteIds = null;
      this._updateRouteDropdown();
      this._renderRoutePills();

      // 6. Set mode (targetMode or project's saved mode or current mode)
      const targetProj = targetProjectId === 'main'
        ? this.mainProject
        : (this.projects ? this.projects.find((p) => p.id === targetProjectId) : null);
      const newMode = targetMode || (targetProj && targetProj.mode) || (targetProjectId === 'main' ? 'view' : (this.mode || 'edit'));
      this.setMode(newMode);

      // 7. Update UI
      this._renderProjects();
      this._updateUIState();
      this.renderer.requestRender();

      // Said on the map only: a project made from the Projects page switches quietly until it's opened
      if (this._showToast && targetProj && document.documentElement.classList.contains('in-map')) {
        const modeLabel = this._isArchivedActive() ? 'Archived · View only' : this.mode === 'view' ? 'View' : 'Edit';
        this._showToast(`Switched to ${targetProj.name} (${modeLabel})`, 'info');
      }
    }

    _createNewProject() {
      // 1. Save current project draft
      this._saveCurrentProjectDraft(false);

      // 2. Determine project number & sequential prj-N ID
      let maxNum = 0;
      for (const p of (this.projects || [])) {
        const m = (p.name || '').match(/^Project\s+(\d+)$/i);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n > maxNum) maxNum = n;
        }
        const mId = (p.id || '').match(/^(?:proj|prj)-(\d+)$/i);
        if (mId) {
          const nId = parseInt(mId[1], 10);
          if (nId > maxNum) maxNum = nId;
        }
      }
      const newNum = maxNum ? (maxNum + 1) : ((this.projects && this.projects.length) ? this.projects.length + 1 : 2);
      const newId = `prj-${newNum}`;
      const newName = `Project ${newNum}`;

      // 3. Initialize fresh draft doc based on CURRENT MAP!
      // New project will create based on current map:
      const currentMapDoc = (this.activeProjectId === 'main')
        ? this.store.doc
        : this._loadProjectDraft('main');
      const freshDraft = JSON.parse(JSON.stringify(currentMapDoc));
      try {
        localStorage.setItem('brass_proj_doc_' + newId, JSON.stringify(freshDraft));
        // The map it starts from, so its share link can list just what it changes
        localStorage.setItem('brass_proj_base_' + newId, JSON.stringify(freshDraft));
      } catch (e) {}

      // 4. Create new project entry
      const curUser = (window.B && window.B.currentUser) || { name: 'John Doe', email: 'john.doe@brass.sg', role: 'Bus Ops' };
      const newProj = {
        id: newId,
        name: newName,
        status: 'not_started',
        mode: 'edit',
        owner: { name: curUser.name, email: curUser.email, role: curUser.role },
        collaborators: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      this.projects.push(newProj);
      this._saveProjects();

      // 5. Switch to the newly created project draft
      this._switchProject(newId, 'edit');
      this.editingProjectId = newId; // Start in inline rename so user can customize name immediately
      // Ensure projects section is expanded so user sees the newly created project
      const bodyProjects = document.getElementById('body-projects');
      const headerProjects = document.getElementById('header-projects');
      if (bodyProjects && bodyProjects.classList.contains('collapsed')) {
        bodyProjects.classList.remove('collapsed');
        if (headerProjects) headerProjects.setAttribute('aria-expanded', 'true');
      }

      this._renderProjects();
      if (this._showToast) this._showToast(`Created ${newName}`, 'success');
    }

    _duplicateProject(id) {
      this._saveCurrentProjectDraft(false);

      const sourceProj = this.projects.find((p) => p.id === id);
      const sourceDoc = (id === this.activeProjectId) ? this.store.doc : this._loadProjectDraft(id);

      let maxNum = 0;
      for (const p of (this.projects || [])) {
        const m = (p.name || '').match(/^Project\s+(\d+)/i);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n > maxNum) maxNum = n;
        }
        const mId = (p.id || '').match(/^(?:proj|prj)-(\d+)$/i);
        if (mId) {
          const nId = parseInt(mId[1], 10);
          if (nId > maxNum) maxNum = nId;
        }
      }
      const newNum = maxNum ? (maxNum + 1) : ((this.projects && this.projects.length) ? this.projects.length + 1 : 2);
      const newId = `prj-${newNum}`;
      const newName = `${sourceProj ? sourceProj.name : 'Project'} (Copy)`;

      try {
        localStorage.setItem('brass_proj_doc_' + newId, JSON.stringify(sourceDoc));
        // A copy starts from where the original did
        localStorage.setItem('brass_proj_base_' + newId, JSON.stringify(this._projectBase(id)));
      } catch (e) {}

      const newProj = {
        id: newId,
        name: newName,
        status: (sourceProj && sourceProj.status) || 'not_started',
        mode: (sourceProj && sourceProj.mode) || 'edit',
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      this.projects.push(newProj);
      this._saveProjects();

      this._switchProject(newId, newProj.mode);
      if (this._showToast) this._showToast(`Duplicated as ${newName}`, 'success');
    }

    // ------------------------------------------------------------- Changes log (share links)
    // The open map's changes are asked for several times per edit (the scope chip, View Changes, the focused
    // buses), so they're worked out once per change to it. The list is shared: read it, don't change it
    _projectChanges(base, doc) {
      const st = this.store, m = this._changesMemo;
      if (doc !== st.doc) return this._listProjectChanges(base, doc);
      if (m && m.doc === doc && m.rev === st.rev && m.base === base) return m.out;
      const out = this._listProjectChanges(base, doc);
      this._changesMemo = { doc, rev: st.rev, base, out };
      return out;
    }

    // What a shared project changes from the map it started from: one line per bus number, stop, area and
    // closure, in groups. A line brings its change into view (a bus line picks that bus out); again lets go.
    _listProjectChanges(base, doc) {
      const out = [];
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const items = (d, key) => (d && d[key]) || {};

      // Buses, by number (every piece of a number is one bus)
      const byNumber = (d) => {
        const m = new Map();
        for (const r of Object.values(items(d, 'routes'))) {
          const n = String(r.number).trim();
          if (!m.has(n)) m.set(n, []);
          m.get(n).push(r);
        }
        return m;
      };
      const stopIds = (routes) => new Set(routes.flatMap((r) => (r.anchors || []).filter((a) => a.t === 'stop').map((a) => a.id)));
      const was = byNumber(base), now = byNumber(doc);
      // A bus given a new number keeps its route pieces, so it's one line ("was Bus …"), not a bus removed and one added
      const renamedFrom = new Map(); // new number → old number
      for (const [n, rs] of was) {
        if (now.has(n)) continue;
        const moved = rs.map((r) => items(doc, 'routes')[r.id]).filter(Boolean);
        const m = moved.length && String(moved[0].number).trim();
        if (m && !was.has(m) && !renamedFrom.has(m) && moved.every((r) => String(r.number).trim() === m)) renamedFrom.set(m, n);
      }
      const renamed = new Set(renamedFrom.values());
      // Hours, days, fleet, model and whether it runs: all of them for a new bus (so its edits show), else what changed
      const busSettings = (n, oldN = null) => {
        const parts = [];
        const hA = oldN && B.busHours(base, oldN), hB = B.busHours(doc, n);
        if (!hA || hA.start !== hB.start || hA.end !== hB.end) parts.push(`${hB.start}–${hB.end}`);
        const dB = B.busDays(doc, n);
        if (!oldN || !same(B.busDays(base, oldN), dB)) parts.push(B.daysLabel(dB));
        const fB = B.busFleetSet(doc, n);
        if (fB && (!oldN || B.busFleetSet(base, oldN) !== fB)) parts.push(`${fB} buses`);
        const mB = B.busModel(doc, n);
        if (!oldN || B.busModel(base, oldN) !== mB) parts.push(mB);
        const on = B.busActive(doc, n);
        if (oldN ? B.busActive(base, oldN) !== on : !on) parts.push(on ? 'active again' : 'not active');
        return parts;
      };
      // A bus's constraint decisions, whichever piece holds them
      const decided = (routes) => Object.entries(Object.assign({}, ...routes.map((r) => r.constraintDecisions || {}))).sort();
      const numbers = [...new Set([...was.keys(), ...now.keys()])].filter((n) => !renamed.has(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      for (const n of numbers) {
        const oldN = renamedFrom.get(n) || n;
        const a = was.get(oldN), b = now.get(n);
        if (!a) {
          const parts = [`new · ${stopIds(b).size} stops`, ...busSettings(n)];
          if (decided(b).length) parts.push('constraints reviewed');
          out.push({ group: 'Buses', mark: 'add', title: `Bus ${n}`, text: parts.join(' · '), focus: { type: 'bus', num: n } });
          continue;
        }
        if (!b) {
          out.push({ group: 'Buses', mark: 'del', title: `Bus ${n}`, text: 'removed', focus: { type: 'bus', num: n, gone: true } });
          continue;
        }
        if (same(a, b)) continue; // the checks below each look through every route, so skip the buses that didn't change
        const parts = oldN !== n ? [`was Bus ${oldN}`] : [];
        const sa = stopIds(a), sb = stopIds(b);
        const added = [...sb].filter((id) => !sa.has(id)).length;
        const dropped = [...sa].filter((id) => !sb.has(id)).length;
        const detour = b.find((r) => r.detourApplied && !a.some((x) => x.id === r.id && x.detourApplied));
        if (detour) parts.push(`detour ${detour.viaName ? detour.viaName.replace(/^Via /, 'via ') : 'applied'}`);
        if (a.length !== b.length) parts.push(b.length > a.length ? `cut into ${b.length} chunks` : b.length === 1 ? 'chunks joined' : `${b.length} chunks`);
        if (added || dropped) parts.push([added ? `+${added}` : '', dropped ? `−${dropped}` : ''].filter(Boolean).join(' ') + ' stops');
        else if (!detour && a.length === b.length && !same(a.map((r) => r.anchors), b.map((r) => r.anchors))) parts.push('route redrawn');
        parts.push(...busSettings(n, oldN));
        if (!same(decided(a), decided(b))) parts.push('constraints reviewed');
        if (parts.length) out.push({ group: 'Buses', mark: 'mod', title: `Bus ${n}`, text: parts.join(' · '), focus: { type: 'bus', num: n } });
      }

      // Stops
      const stA = items(base, 'stops'), stB = items(doc, 'stops');
      // The bus types a stop was set to take, if set
      const takes = (s) => (Array.isArray(s.busTypes) && s.busTypes.length
        ? (s.busTypes.length >= B.BUS_MODELS.length ? 'all bus types' : `${B.BUS_MODELS.filter((m) => s.busTypes.includes(m)).join(', ')} only`)
        : null);
      for (const [id, st] of Object.entries(stB)) {
        const old = stA[id];
        if (!old) {
          const parts = ['new stop'];
          if (st.active === false) parts.push('not active');
          if (takes(st)) parts.push(takes(st));
          out.push({ group: 'Stops', mark: 'add', title: st.name, text: parts.join(' · '), focus: { type: 'stop', id } });
          continue;
        }
        const parts = [];
        if (old.name !== st.name) parts.push(`was ${old.name}`);
        if ((old.active === false) !== (st.active === false)) parts.push(st.active === false ? 'not active' : 'active again');
        if (!same(old.busTypes || null, st.busTypes || null)) parts.push(takes(st) || 'bus types');
        if (old.edge !== st.edge || old.s !== st.s || old.dir !== st.dir) parts.push('moved');
        if (parts.length) out.push({ group: 'Stops', mark: 'mod', title: st.name, text: parts.join(' · '), focus: { type: 'stop', id } });
      }
      for (const [id, st] of Object.entries(stA)) {
        if (!stB[id]) out.push({ group: 'Stops', mark: 'del', title: st.name, text: 'removed', focus: { type: 'stop', id, gone: true } });
      }

      // Affected areas, then road closures (closures an area makes come with it)
      const arA = items(base, 'areas'), arB = items(doc, 'areas');
      for (const [id, ar] of Object.entries(arB)) {
        const old = arA[id];
        if (!old) out.push({ group: 'Areas & closures', mark: 'add', title: ar.name || id, text: 'affected area', focus: { type: 'area', id } });
        else if (!same(old, ar)) out.push({ group: 'Areas & closures', mark: 'mod', title: ar.name || id, text: old.name !== ar.name ? `was ${old.name}` : 'reshaped', focus: { type: 'area', id } });
      }
      for (const [id, ar] of Object.entries(arA)) {
        if (!arB[id]) out.push({ group: 'Areas & closures', mark: 'del', title: ar.name || id, text: 'area removed', focus: { type: 'area', id, gone: true } });
      }
      const ownClosure = (c, areas) => c && (c.areaId || Object.values(areas).some((ar) => c.reason === `Closed by ${ar.name}`));
      const road = (edge) => { const e = this.net.edge(Number(edge)); return (e && e.name) || `Road #${edge}`; };
      const clA = items(base, 'closures'), clB = items(doc, 'closures');
      for (const [edge, c] of Object.entries(clB)) {
        if (!clA[edge] && !ownClosure(c, arB)) out.push({ group: 'Areas & closures', mark: 'add', title: road(edge), text: 'closed', focus: { type: 'closure', edge: Number(edge) } });
      }
      for (const [edge, c] of Object.entries(clA)) {
        if (!clB[edge] && !ownClosure(c, arA)) out.push({ group: 'Areas & closures', mark: 'del', title: road(edge), text: 'reopened', focus: { type: 'closure', edge: Number(edge) } });
      }
      return out;
    }

    // Collects all route IDs that have changes or are focused on in the project
    _getSharedFocusRouteIds(base, doc, focusNums = null) {
      const targetDoc = doc || this.store.doc;
      if (!targetDoc || !targetDoc.routes) return [];
      const allRoutes = Object.values(targetDoc.routes);
      const changedBusNums = new Set();

      if (Array.isArray(focusNums)) {
        focusNums.forEach((n) => {
          if (n != null && String(n).trim()) changedBusNums.add(String(n).trim());
        });
      }

      const changes = base ? this._projectChanges(base, targetDoc) : [];
      for (const c of changes) {
        if (c.focus && c.focus.type === 'bus' && !c.focus.gone) {
          changedBusNums.add(String(c.focus.num).trim());
        }
      }

      for (const r of allRoutes) {
        if (r.kind === 'proposed' || r.detourApplied || r.fromDocument || (r.constraintDecisions && Object.keys(r.constraintDecisions).length > 0)) {
          changedBusNums.add(String(r.number).trim());
        }
      }

      // If no direct bus route modifications were made yet, include routes serving modified stops or affected areas/closures
      if (!changedBusNums.size) {
        for (const c of changes) {
          const f = c.focus;
          if (!f) continue;
          if (f.type === 'stop') {
            this._busesServing(f.id).forEach((rid) => {
              const r = targetDoc.routes[rid];
              if (r) changedBusNums.add(String(r.number).trim());
            });
          } else if (f.type === 'area') {
            const ar = ((f.gone ? base : targetDoc).areas || {})[f.id];
            if (ar) {
              this._busesOnEdges(new Set(this.net.edgesInPolygon(this.store.areaPoly(ar)))).forEach((rid) => {
                const r = targetDoc.routes[rid];
                if (r) changedBusNums.add(String(r.number).trim());
              });
            }
          } else if (f.type === 'closure') {
            this._busesOnEdges(new Set([f.edge])).forEach((rid) => {
              const r = targetDoc.routes[rid];
              if (r) changedBusNums.add(String(r.number).trim());
            });
          }
        }
      }

      if (!changedBusNums.size) return [];
      return allRoutes.filter((r) => changedBusNums.has(String(r.number).trim())).map((r) => r.id);
    }

    _fitSharedProjectView() {
      const pts = [];
      const doc = this.store.doc;
      const routeIds = (this.reviewFocusRouteIds && this.reviewFocusRouteIds.size)
        ? [...this.reviewFocusRouteIds]
        : [...this.selectedRouteIds];

      for (const rid of routeIds) {
        const g = this.store.geom[rid];
        for (const l of (g && g.legs) || []) {
          for (const p of l.pts || []) pts.push(p);
        }
      }

      for (const c of this.reviewChanges || []) {
        const f = c.focus;
        if (!f) continue;
        if (f.type === 'stop') {
          const st = ((f.gone ? this.reviewBase : doc).stops || {})[f.id];
          if (st && this.net.edge(st.edge)) pts.push(this.net.posPoint(st, 0.78));
        } else if (f.type === 'area') {
          const ar = ((f.gone ? this.reviewBase : doc).areas || {})[f.id];
          if (ar) pts.push(...this.store.areaPoly(ar));
        } else if (f.type === 'closure') {
          const e = this.net.edge(f.edge);
          if (e && e.pts) pts.push(...e.pts);
        }
      }

      if (pts.length) {
        const bb = B.bbox(pts, 280);
        this._fitClearOfPanels(bb);
      } else {
        this.renderer.fitToBoundary();
      }
      this.renderer.requestRender();
    }

    _showChangesPanel(base) {
      const panel = document.getElementById('changes-panel');
      if (!panel) return;
      this.reviewBase = base;
      const titleEl = panel.querySelector('.changes-title');
      if (titleEl) {
        titleEl.textContent = this.reviewMode && this.reviewName ? `${this.reviewName} · Changes` : 'Changes';
      }
      const list = panel.querySelector('.changes-list');
      const count = panel.querySelector('.changes-count');
      if (!base) {
        panel.classList.add('hidden');
        return;
      }
      const changes = this._projectChanges(base, this.store.doc);
      this.reviewChanges = changes;
      count.textContent = String(changes.length);

      let routesBar = panel.querySelector('.changes-routes-bar');
      if (!routesBar) {
        routesBar = document.createElement('div');
        routesBar.className = 'changes-routes-bar';
        panel.insertBefore(routesBar, list);
      }
      const focusIds = (this.reviewFocusRouteIds && this.reviewFocusRouteIds.size)
        ? [...this.reviewFocusRouteIds]
        : this._getSharedFocusRouteIds(base, this.store.doc);
      const focusRoutes = focusIds.map((id) => this.store.doc.routes[id]).filter(Boolean);
      const focusGroups = this._busGroups(focusRoutes).sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));

      const marks = { add: '+', del: '−', mod: '~' };

      const filterChangesForBus = (busNum) => {
        if (!busNum || busNum === 'all') return changes;
        const targetNum = String(busNum).trim();
        return changes.filter((c) => {
          if (!c.focus) return false;
          const f = c.focus;
          if (f.type === 'bus') {
            return String(f.num).trim() === targetNum;
          }
          if (f.type === 'stop') {
            const stopId = f.id;
            const busMatches = (r) => String(r.number).trim() === targetNum;
            const hasStop = (anchors) => (anchors || []).some((a) => a.t === 'stop' && a.id === stopId);
            const currentServed = Object.values(this.store.doc.routes).some((r) => busMatches(r) && (hasStop(r.anchors) || hasStop(r.originalAnchors)));
            const baseServed = base && base.routes && Object.values(base.routes).some((r) => busMatches(r) && hasStop(r.anchors));
            return currentServed || baseServed;
          }
          if (f.type === 'closure') {
            const edgeId = Number(f.edge);
            const usesEdge = (doc) => {
              if (!doc || !doc.routes) return false;
              return Object.values(doc.routes).some((r) => {
                if (String(r.number).trim() !== targetNum) return false;
                const g = (doc === this.store.doc && this.store.geom) ? this.store.geom[r.id] : null;
                if (g && g.legs && g.legs.some((l) => l.segs && l.segs.some((s) => Number(s.edge) === edgeId))) return true;
                for (const a of r.anchors || []) {
                  if (a.t === 'stop') {
                    const st = doc.stops && doc.stops[a.id];
                    if (st && Number(st.edge) === edgeId) return true;
                  }
                }
                return false;
              });
            };
            return usesEdge(this.store.doc) || usesEdge(base);
          }
          if (f.type === 'area') {
            const areaId = f.id;
            const ar = (this.store.doc.areas && this.store.doc.areas[areaId]) || (base && base.areas && base.areas[areaId]);
            if (!ar) return false;
            const areaEdges = new Set(this.store.areaEdges && this.store.areaEdges[areaId] ? this.store.areaEdges[areaId] : []);
            if (!areaEdges.size && this.net && typeof this.store.areaPoly === 'function') {
              try {
                const poly = this.store.areaPoly(ar);
                if (poly) {
                  for (const eid of this.net.edgesInPolygon(poly)) areaEdges.add(Number(eid));
                }
              } catch (e) {}
            }
            const touchesArea = (doc) => {
              if (!doc || !doc.routes) return false;
              return Object.values(doc.routes).some((r) => {
                if (String(r.number).trim() !== targetNum) return false;
                if (doc === this.store.doc && this.isRouteAffected(r.id)) return true;
                const g = (doc === this.store.doc && this.store.geom) ? this.store.geom[r.id] : null;
                if (g && g.legs && g.legs.some((l) => l.segs && l.segs.some((s) => areaEdges.has(Number(s.edge))))) return true;
                for (const a of r.anchors || []) {
                  if (a.t === 'stop') {
                    const st = doc.stops && doc.stops[a.id];
                    if (st && areaEdges.has(Number(st.edge))) return true;
                  }
                }
                return false;
              });
            };
            return touchesArea(this.store.doc) || touchesArea(base);
          }
          return false;
        });
      };

      const renderChangeRows = (itemsToRender) => {
        let group = null;
        list.innerHTML = itemsToRender.length ? itemsToRender.map((c) => {
          const origIdx = changes.indexOf(c);
          const head = c.group !== group ? `<li class="changes-group">${B.esc((group = c.group))}</li>` : '';
          return `${head}<li class="change-row" data-i="${origIdx}" title="${B.esc(c.title)}: ${B.esc(c.text)}">
            <span class="change-mark ${c.mark}">${marks[c.mark]}</span>
            <span class="change-text"><strong>${B.esc(c.title)}</strong> · ${B.esc(c.text)}</span>
          </li>`;
        }).join('') : '<li class="changes-empty">No changes related to this route</li>';
        count.textContent = String(itemsToRender.length);
        list.querySelectorAll('.change-row').forEach((row) => {
          row.addEventListener('click', () => this._focusChange(Number(row.dataset.i), row));
        });
      };

      if (focusGroups.length) {
        routesBar.innerHTML = `
          <div class="changes-routes-label">Focused routes</div>
          <div class="changes-routes-chips">
            <button type="button" class="changes-route-chip is-all active" data-focus-bus="all">All (${focusGroups.length})</button>
            ${focusGroups.map((g) => `<button type="button" class="changes-route-chip" data-focus-bus="${B.esc(g.number)}" style="--chip-color: ${g.color || '#2563eb'};">${B.esc(g.number)}</button>`).join('')}
          </div>
        `;
        routesBar.hidden = false;
        routesBar.querySelectorAll('.changes-route-chip').forEach((chip) => {
          chip.addEventListener('click', () => {
            const busNum = chip.dataset.focusBus;
            routesBar.querySelectorAll('.changes-route-chip').forEach((el) => el.classList.remove('active'));
            chip.classList.add('active');

            const filtered = filterChangesForBus(busNum);
            renderChangeRows(filtered);

            if (busNum === 'all') {
              this.selectedRouteIds = new Set(focusIds);
              this.isAllRoutesSelected = this.selectedRouteIds.size === Object.keys(this.store.doc.routes).length;
              this._applyRouteMultiSelection();
              this._updateRouteDropdown();
              this.renderer.selected = null;
              this._hideInspector();
              this._fitSharedProjectView();
            } else {
              const rIds = Object.values(this.store.doc.routes)
                .filter((r) => String(r.number).trim() === busNum)
                .map((r) => r.id);
              if (rIds.length) {
                this.selectedRouteIds = new Set(rIds);
                this.isAllRoutesSelected = false;
                this._applyRouteMultiSelection();
                this._updateRouteDropdown();
                this.renderer.selected = { type: 'route', id: rIds[0] };
                this._showInspector(this.renderer.selected);
                this._focusOnSelectedBuses();
              }
            }
          });
        });
      } else {
        routesBar.innerHTML = '';
        routesBar.hidden = true;
      }

      renderChangeRows(changes);
      panel.classList.remove('hidden');
    }

    // Brings one change into view: the map keeps to the buses it touches and it is picked out (its card opens
    // where it has one), zoomed to. Clicking it again returns to the project's focused routes
    _focusChange(i, row) {
      const c = this.reviewChanges && this.reviewChanges[i];
      if (!c) return;
      const f = c.focus;
      const doc = f.gone ? this.reviewBase : this.store.doc;
      const list = row.parentElement;
      const panel = document.getElementById('changes-panel');
      const wasOn = row.classList.contains('active');
      list.querySelectorAll('.change-row.active').forEach((el) => el.classList.remove('active'));
      if (panel) {
        panel.querySelectorAll('.changes-route-chip').forEach((el) => el.classList.remove('active'));
      }
      const allIds = Object.keys(this.store.doc.routes);
      const defaultIds = (this.reviewMode && this.reviewFocusRouteIds && this.reviewFocusRouteIds.size)
        ? [...this.reviewFocusRouteIds]
        : allIds;
      const show = (ids) => {
        const next = ids && ids.length ? new Set(ids) : new Set(defaultIds);
        this.selectedRouteIds = next;
        this.isAllRoutesSelected = next.size === allIds.length;
        this._applyRouteMultiSelection();
        this._updateRouteDropdown();
      };
      if (wasOn) {
        if (panel) {
          const allChip = panel.querySelector('.changes-route-chip.is-all');
          if (allChip) allChip.classList.add('active');
        }
        show(null);
        this.renderer.selected = null;
        this._hideInspector();
        if (this.reviewMode) this._fitSharedProjectView();
        else this.renderer.requestRender();
        return;
      }
      row.classList.add('active');
      const pts = [];
      if (f.type === 'bus') {
        if (panel) {
          const chip = panel.querySelector(`.changes-route-chip[data-focus-bus="${CSS.escape(f.num)}"]`);
          if (chip) chip.classList.add('active');
        }
        const routes = Object.values(doc.routes).filter((r) => String(r.number).trim() === f.num);
        if (!f.gone && routes.length) {
          show(routes.map((r) => r.id));
          this.renderer.selected = { type: 'route', id: routes[0].id };
          this._showInspector(this.renderer.selected);
          this._focusOnSelectedBuses();
          return;
        }
        show(null);
        for (const r of routes) for (const a of r.anchors || []) {
          const st = a.t === 'stop' && doc.stops[a.id];
          if (st && this.net.edge(st.edge)) pts.push(this.net.posPoint(st, 0.78));
        }
      } else if (f.type === 'stop') {
        const st = doc.stops[f.id];
        show(this._busesServing(f.id));
        if (st && this.net.edge(st.edge)) pts.push(this.net.posPoint(st, 0.78));
        if (!f.gone) {
          this.renderer.selected = { type: 'stop', id: f.id };
          this._showInspector(this.renderer.selected);
        }
      } else if (f.type === 'area') {
        const ar = doc.areas[f.id];
        if (ar) {
          pts.push(...this.store.areaPoly(ar));
          show(this._busesOnEdges(new Set(this.net.edgesInPolygon(this.store.areaPoly(ar)))));
          if (!f.gone) { this.renderer.selected = { type: 'area', id: f.id }; this._hideInspector(); }
        }
      } else if (f.type === 'closure') {
        const e = this.net.edge(f.edge);
        if (e) {
          pts.push(...e.pts);
          show(this._busesOnEdges(new Set([f.edge])));
          this.renderer.selected = { type: 'closure', id: f.edge };
          this._showInspector(this.renderer.selected);
        }
      }
      if (!pts.length) return;
      const bb = B.bbox(pts, 350);
      this._fitClearOfPanels(bb);
      this.renderer.requestRender();
    }

    // The buses (every piece of each number) that use these roads now or did before a detour
    _busesOnEdges(edges) {
      const routes = Object.values(this.store.doc.routes);
      const uses = (g) => !!g && (g.legs || []).some((l) => l.ok && (l.segs || []).some((sg) => edges.has(sg.edge)));
      const nums = new Set(routes.filter((r) => uses(this.store.geom[r.id])
        || (r.originalAnchors && uses(this.store.computeRoute({ anchors: r.originalAnchors, kind: 'existing' }))))
        .map((r) => String(r.number).trim()));
      return routes.filter((r) => nums.has(String(r.number).trim())).map((r) => r.id);
    }

    // The buses that stop at this stop now or did before a detour
    _busesServing(stopId) {
      const routes = Object.values(this.store.doc.routes);
      const has = (anchors) => (anchors || []).some((a) => a.t === 'stop' && a.id === stopId);
      const nums = new Set(routes.filter((r) => has(r.anchors) || has(r.originalAnchors)).map((r) => String(r.number).trim()));
      return routes.filter((r) => nums.has(String(r.number).trim())).map((r) => r.id);
    }

    // A red dot on View Changes: changes from the documents landed and the list hasn't been opened since
    _markChangesNew(on = true) {
      const btn = document.getElementById('btn-header-changes');
      if (!btn) return;
      const show = !!on && !this.projectChangesOpen;
      btn.classList.toggle('has-new', show);
      btn.title = show ? 'New changes from the documents · list them' : "List this project's changes";
    }

    // View Changes in the header: this project's changes from the map it started from, in the side panel
    _toggleProjectChanges(open = !this.projectChangesOpen) {
      open = !!open && !this.reviewMode;
      this.projectChangesOpen = open;
      const btn = document.getElementById('btn-header-changes');
      if (btn) { btn.classList.toggle('active', open); btn.setAttribute('aria-pressed', String(open)); }
      if (open) this._markChangesNew(false);
      if (open) this._showChangesPanel(this._projectBase(this.activeProjectId));
      else {
        const panel = document.getElementById('changes-panel');
        if (panel) panel.classList.add('hidden');
      }
    }

    // The changes the AI made from the attached documents that touch this bus, as bullets, with the AI mark
    _docNotesHtml(r) {
      let lines = B.aiFocus && B.aiFocus.notes ? [...B.aiFocus.notes(r.number)] : [];
      if (r.detourApplied && !lines.some((l) => l.startsWith('AI detour applied'))) {
        lines.push(`AI detour applied: ${r.viaName || r.detourTitle || 'Best option'} (Best option)`);
      }
      const frac = this._routeDisruptedFraction(r);
      if (frac > 0.5) {
        lines.unshift(`Suspend route (over 50% obstructed by closures / affected areas)`);
      }
      if (!lines.length) return '';
      // Restore undoes changes made to this route only
      const restore = (B.aiFocus && typeof B.aiFocus.restorableRoute === 'function')
        ? B.aiFocus.restorableRoute(r.number || r.id)
        : Boolean(r.originalAnchors || r.detourApplied || r.fromDocument || r.fromAiSuggest);
      return `<div class="panel-section doc-notes">
          <div class="doc-notes-head">${B.AI_ICON || ''}<span>Changes made by AI</span>
            ${restore ? `<button type="button" class="doc-notes-restore" data-act="ai-restore" title="Undo changes made to this route">Restore</button>` : ''}</div>
          <ul class="doc-notes-list">${lines.map((l) => `<li>${B.esc(l)}</li>`).join('')}</ul>
          ${restore ? `<div class="doc-notes-confirm">
            <span>Undo changes made to this route?</span>
            <button type="button" class="pp-btn" data-act="ai-restore-no">Cancel</button>
            <button type="button" class="pp-btn pp-primary" data-act="ai-restore-yes" data-route-id="${B.esc(r.id)}" data-bus="${B.esc(r.number)}">Restore</button>
          </div>` : ''}
        </div>`;
    }

    // Restore changes made by AI for this route only (leaves road closures, affected areas, and other bus detours intact)
    restoreRouteAiChanges(routeIdOrNum) {
      if (window.B && B.aiFocus && typeof B.aiFocus.restoreRoute === 'function') {
        B.aiFocus.restoreRoute(routeIdOrNum);
        return;
      }
      const store = this.store;
      const routes = Object.values(store.doc.routes);
      const target = routes.find((r) => r.id === routeIdOrNum || String(r.number).trim().toUpperCase() === String(routeIdOrNum).trim().toUpperCase());
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

      this._updateUIState();
      const sel = this.renderer.selected;
      if (sel && sel.type === 'route' && store.doc.routes[sel.id]) {
        this._showInspector(sel);
      } else {
        this.renderer.selected = null;
        this._hideInspector();
      }
      this.renderer.requestRender();
      this._showToast(`Changes for Bus ${target.number} restored`, 'info');
    }

    _projectBase(id) {
      const stored = this._storedDoc('brass_proj_base_' + id);
      if (stored) return stored;
      // No copy kept: the saved Current Map, else the network as generated. Never the working copy the
      // Current Map otherwise falls back to, which holds this project's own edits
      return this._storedDoc('brass_proj_doc_main') || this._generatedDoc || (this._generatedDoc = JSON.parse(this.store.sample));
    }

    // ------------------------------------------------------------- Before / After (header)
    // Before draws the map this project started from, read-only, keeping the buses the filters show;
    // After is the project as it is now. Opening a project always starts on After.
    setBeforeView(on) {
      on = !!on;
      if (on === !!this.beforeView) {
        document.querySelectorAll('#header-compare [data-view]').forEach((b) => {
          const active = (b.dataset.view === 'before') === on;
          b.classList.toggle('active', active);
          b.setAttribute('aria-pressed', String(active));
        });
        return;
      }
      this.beforeView = on;
      document.body.classList.toggle('before-view', on);
      document.querySelectorAll('#header-compare [data-view]').forEach((b) => {
        const active = (b.dataset.view === 'before') === on;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      if (on) {
        this.renderer.selected = null;
        this._hideInspector();
        this._hideFloatingStopActions();
        this._hideFloatingLegActions();
        this.setTool('select');
        const before = Object.create(B.Store.prototype);
        const baseDoc = this.reviewMode
          ? (this.reviewBaseDoc || this._projectBase('main'))
          : this._projectBase(this.activeProjectId);
        Object.assign(before, { city: this.store.city, net: this.store.net, doc: JSON.parse(JSON.stringify(baseDoc)), legCache: this.store.legCache });
        before.derive();
        this.renderer.store = before;
      } else {
        this.renderer.store = this.store;
      }
      this.renderer.requestRender();
    }

    // ------------------------------------------------------------- Share Links
    // The draft map rides in the link's #hash (compressed), so it never reaches a server.
    // The city is generated from a fixed seed, so a shared draft lines up on any machine.
    async _shareProject(id) {
      this._saveCurrentProjectDraft(false);
      const proj = this.projects.find((p) => p.id === id);
      const doc = (id === this.activeProjectId) ? this.store.doc : this._loadProjectDraft(id);
      if (!proj || !doc) return;

      const base = this._projectBase(id);
      const focusNums = Array.isArray(proj.focusRouteNums) && proj.focusRouteNums.length
        ? proj.focusRouteNums.slice()
        : null;

      try {
        const data = await this._encodeShare({
          name: proj.name,
          code: proj.code || proj.id,
          id: proj.id,
          doc,
          base,
          ...(focusNums ? { focusNums } : {})
        });
        const url = `${location.origin}${location.pathname}#review=${data}`;
        await this._copyText(url);
        if (this._showToast) this._showToast('Share link copied', 'success');
      } catch (e) {
        console.warn('Could not create a share link', e);
        if (this._showToast) this._showToast("Couldn't copy the link", 'warn');
      }
    }

    // Share menu under a project's share button: copy a link, or download a PDF change report
    _openShareMenu(anchor, p) {
      const wasOpen = this._shareMenu && this._shareMenu.anchor === anchor;
      this._closeShareMenu();
      if (wasOpen) return;
      const menu = document.createElement('div');
      menu.className = 'share-menu';
      menu.setAttribute('role', 'menu');
      menu.innerHTML = `
        <button type="button" class="share-menu-item" role="menuitem" data-act="link"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg><span>Copy share link</span></button>
        <button type="button" class="share-menu-item" role="menuitem" data-act="pdf"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="12" x2="12" y2="18"></line><polyline points="9 15 12 18 15 15"></polyline></svg><span>Download PDF</span></button>
        <button type="button" class="share-menu-item is-locked" role="menuitem" aria-disabled="true" title="Locked" data-act="slides"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg><span>Download presentation</span><svg class="share-menu-lock" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-label="Locked"><rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg></button>
      `;
      document.body.appendChild(menu);
      const r = anchor.getBoundingClientRect();
      menu.style.top = `${r.bottom + 6}px`;
      menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`;

      menu.querySelector('[data-act="link"]').addEventListener('click', () => {
        this._closeShareMenu();
        this._shareProject(p.id);
      });
      menu.querySelector('[data-act="pdf"]').addEventListener('click', async () => {
        this._closeShareMenu();
        this._showToast('Preparing PDF…', 'info');
        try {
          await B.downloadChangeReport(this, p.id);
          this._showToast('PDF downloaded', 'success');
        } catch (err) {
          console.warn('Could not build the change report', err);
          this._showToast("Couldn't make the PDF", 'error');
        }
      });

      const onOutside = (e) => {
        if (!menu.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) this._closeShareMenu();
      };
      const onKey = (e) => { if (e.key === 'Escape') this._closeShareMenu(); };
      setTimeout(() => document.addEventListener('mousedown', onOutside), 0);
      document.addEventListener('keydown', onKey);
      this._shareMenu = { menu, anchor, onOutside, onKey };
    }

    _closeShareMenu() {
      if (!this._shareMenu) return;
      const { menu, onOutside, onKey } = this._shareMenu;
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('keydown', onKey);
      menu.remove();
      this._shareMenu = null;
    }

    async _copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
      } catch (e) {
        // Older browsers or no clipboard permission: copy through a hidden textarea
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        if (!ok) throw e;
      }
    }

    // A map in a link goes as its changes from the generated network, which every machine builds the same way
    async _encodeShare(payload) {
      for (const key of ['doc', 'base']) {
        if (!payload[key]) continue;
        payload = { ...payload, [key + 'Patch']: B.docPatch(payload[key]) };
        delete payload[key];
      }
      const stream = new Blob([JSON.stringify(payload)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    async _decodeShare(data) {
      const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
      const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      const payload = JSON.parse(await new Response(stream).text());
      for (const key of ['doc', 'base']) {
        if (!payload || !payload[key + 'Patch']) continue;
        payload[key] = B.docFromPatch(payload[key + 'Patch']);
        delete payload[key + 'Patch'];
      }
      return payload;
    }

    // Links come from anyone, so markup characters are stripped from every name and label
    _sanitizeShared(value) {
      if (typeof value === 'string') return value.replace(/[<>]/g, '');
      if (Array.isArray(value)) return value.map((item) => this._sanitizeShared(item));
      if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = this._sanitizeShared(v);
        return out;
      }
      return value;
    }

    // A share link opens a review of the shared map: just the map, the header and Visualization Settings.
    // Nothing is saved while reviewing, so the reviewer's own projects stay as they were.
    async _openSharedProject() {
      const match = location.hash.match(/^#(review|share|draw|drawresult)=([A-Za-z0-9_-]+)$/);
      if (!match) {
        // The link was taken out of the address bar: back to your own projects
        if (this.reviewMode) location.reload();
        return;
      }
      const kind = match[1];

      let shared = null;
      try {
        shared = this._sanitizeShared(await this._decodeShare(match[2]));
      } catch (e) {
        console.warn('Could not read share link', e);
      }

      // Drawings sent back from a drawing link: keep them for that project's Refresh
      if (kind === 'drawresult') {
        history.replaceState(null, '', location.pathname + location.search);
        if (!shared || !shared.sid || typeof shared.areas !== 'object') {
          this._showToast('This link is broken', 'warn');
          return;
        }
        this._storeDrawSession(shared);
        const proj = (this.projects || []).find((p) => p.drawLink && p.drawLink.sid === shared.sid);
        this._showToast(proj ? `Drawings for ${B.esc(proj.name)} received · Refresh to add them` : 'Drawings received', 'success');
        if (proj) this._renderProjects();
        return;
      }
      const doc = shared && shared.doc;
      if (!doc || typeof doc.stops !== 'object' || typeof doc.routes !== 'object') {
        if (!this.reviewMode) {
          history.replaceState(null, '', location.pathname + location.search);
          document.body.classList.remove('review-mode');
        }
        if (this._showToast) this._showToast('This share link is broken', 'warn');
        return;
      }

      this._saveCurrentProjectDraft(false);
      this.reviewMode = true;
      this.reviewName = (typeof shared.name === 'string' && shared.name.trim()) ? shared.name.trim().slice(0, 60) : 'Project';
      const matchingProj = (this.projects || []).find((p) => p.name === this.reviewName || (shared.id && p.id === shared.id) || (shared.code && (p.code === shared.code || p.id === shared.code)));
      this.reviewCode = (typeof shared.code === 'string' && shared.code.trim())
        ? shared.code.trim()
        : ((typeof shared.id === 'string' && shared.id.trim())
          ? shared.id.trim()
          : (matchingProj ? (matchingProj.code || matchingProj.id || '') : ''));
      if (!this.reviewCode) {
        const m = this.reviewName.match(/^Project\s+(\d+)$/i);
        if (m) this.reviewCode = `prj-${m[1]}`;
      }
      document.documentElement.classList.add('authed', 'in-map', 'review-view');
      document.body.classList.add('review-mode');
      // A drawing link: the same read-only page, plus the area and closure tools; what's drawn is kept for the project
      this.drawMode = kind === 'draw' && !!shared.sid;
      document.body.classList.toggle('draw-mode', this.drawMode);
      if (this.drawMode) {
        this.drawSession = { sid: shared.sid, pid: shared.pid || null, name: this.reviewName };
        this.drawBase = { areas: JSON.parse(JSON.stringify(doc.areas || {})), closures: JSON.parse(JSON.stringify(doc.closures || {})) };
        const tag = document.querySelector('.header-review-tag');
        if (tag) tag.textContent = 'Draw areas';
        // The base map only: roads with their names, places and buildings; no buses or stops
        const L = this.renderer.layers;
        L.existingRoutes = L.proposedRoutes = false;
        L.stops = L.stopPoints = L.stopNames = false;
        L.roadNames = L.buildings = L.labels = true;
        this.renderer.namesAlways = true;
      }

      this.pendingNewBus = null;
      if (this.activeConnectStopId) this._cancelConnectingStops();
      if (this.isDrawingAreaFilter) this._cancelAreaFilterDrawing();
      this.setTool('select');
      this.renderer.selected = null;
      this._hideInspector();
      this._hideFloatingLegActions();
      this._hideFloatingStopActions();

      this.store.loadDoc(doc, { label: 'Open review' });
      this._lastSavedDoc = JSON.stringify(this.store.doc);
      const baseDoc = (shared.base && typeof shared.base.routes === 'object') ? shared.base : this._projectBase('main');
      this.reviewBaseDoc = baseDoc;
      this.beforeView = false;
      this.setBeforeView(false);
      const focusIds = !this.drawMode ? this._getSharedFocusRouteIds(baseDoc, this.store.doc, shared.focusNums) : [];
      this.reviewFocusRouteIds = focusIds.length ? new Set(focusIds) : null;
      if (!this.drawMode) this._showChangesPanel(baseDoc);
      const allIds = Object.keys(this.store.doc.routes);
      if (this.reviewFocusRouteIds && this.reviewFocusRouteIds.size) {
        this.selectedRouteIds = new Set(this.reviewFocusRouteIds);
        this.isAllRoutesSelected = this.selectedRouteIds.size === allIds.length;
        this._applyRouteMultiSelection();
      } else {
        this.isAllRoutesSelected = true;
        this.selectedRouteIds = new Set(allIds);
        this.renderer.visibleRouteIds = null;
      }
      this.setMode('view');
      this._updateHeaderProjectDisplay();
      this.renderer.resize();
      this.renderer.canvas.style.cursor = 'grab';
      if (!this.drawMode) {
        this._fitSharedProjectView();
        setTimeout(() => {
          if (this.reviewMode && !this.drawMode) {
            this.renderer.resize();
            this._fitSharedProjectView();
          }
        }, 120);
      } else {
        this.renderer.requestRender();
      }
      if (this.drawMode) {
        // Drawings already sent from this browser come back, so the link can be picked up where it was left
        const earlier = this._loadDrawSession(this.drawSession.sid);
        if (earlier && (Object.keys(earlier.areas || {}).length || Object.keys(earlier.closures || {}).length)) {
          this.store.commit('Earlier drawings', (d) => {
            d.areas = { ...(d.areas || {}), ...(earlier.areas || {}) };
            d.closures = { ...(d.closures || {}), ...(earlier.closures || {}) };
          });
        }
        this.drawLastSent = JSON.stringify(this._drawnItems());
        this._updateDrawSendState();
        window.addEventListener('beforeunload', (e) => {
          if (this.drawMode && JSON.stringify(this._drawnItems()) !== this.drawLastSent) {
            e.preventDefault();
            e.returnValue = '';
          }
        });
        this._showToast('Pick Affected Area or Road Closure below to draw', 'info');
      }
    }

    // ------------------------------------------------------------- Drawing links (temporary projects)
    // The owner copies a link; whoever opens it draws affected areas and road closures on the project's map.
    // On the same browser the drawings reach the project straight away; elsewhere "Send back" copies a link
    // that carries them home. Refresh on the project adds them (and replaces what an earlier Refresh added).
    _drawSessionKey(sid) {
      return 'brass_draw_' + sid;
    }

    _storeDrawSession(data) {
      try {
        localStorage.setItem(this._drawSessionKey(data.sid), JSON.stringify({
          sid: data.sid, pid: data.pid || null, areas: data.areas || {}, closures: data.closures || {}, updatedAt: data.updatedAt || Date.now(),
        }));
      } catch (e) {
        console.warn('Could not keep the drawings', e);
      }
    }

    _loadDrawSession(sid) {
      try {
        const raw = localStorage.getItem(this._drawSessionKey(sid));
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    }

    // On the drawing page: what's been drawn there (anything not in the project when the link was opened)
    _drawnItems() {
      const doc = this.store.doc;
      const areas = {};
      for (const [id, a] of Object.entries(doc.areas || {})) if (!this.drawBase.areas[id]) areas[id] = a;
      const closures = {};
      for (const [edge, c] of Object.entries(doc.closures || {})) if (!this.drawBase.closures[edge]) closures[edge] = c;
      return { areas, closures };
    }

    // "Update to LTA" lights up when the drawings differ from what was last sent
    _updateDrawSendState() {
      const send = document.getElementById('btn-draw-send');
      if (send) send.disabled = JSON.stringify(this._drawnItems()) === this.drawLastSent;
    }

    // "Update to LTA": saves the drawings for the project's Refresh (straight away on this browser) and copies
    // a link that carries them to LTA from another device. Deleting everything sends an empty update.
    async _sendDrawUpdate() {
      if (!this.drawMode) return;
      const items = this._drawnItems();
      const updatedAt = Date.now();
      this._storeDrawSession({ ...this.drawSession, ...items, updatedAt });
      this.drawLastSent = JSON.stringify(items);
      this._updateDrawSendState();
      try {
        const data = await this._encodeShare({ sid: this.drawSession.sid, pid: this.drawSession.pid, ...items, updatedAt });
        await this._copyText(`${location.origin}${location.pathname}#drawresult=${data}`);
        this._showToast('Updated to LTA · link copied', 'success');
      } catch (e) {
        console.warn('Could not make the link', e);
        this._showToast('Updated to LTA', 'success');
      }
    }

    // On the drawing page: an area or closure drawn here, under the cursor
    _drawnAt(world) {
      const items = this._drawnItems();
      for (const a of Object.values(items.areas)) {
        if (B.pointInPoly(world, this.store.areaPoly(a))) return { type: 'area', id: a.id };
      }
      const near = this.net.nearest(world, 10 / this.renderer.camera.zoom + 6);
      if (near && items.closures[near.edge]) return { type: 'closure', id: near.edge };
      return null;
    }

    _deleteDrawn(sel) {
      if (!sel) return;
      if (sel.type === 'area' && !this.drawBase.areas[sel.id]) {
        this.store.commit(`Delete area ${sel.id}`, (doc) => { B.ops.deleteArea(doc, sel.id); });
        this._showToast('Area deleted', 'info');
      } else if (sel.type === 'closure' && !this.drawBase.closures[sel.id]) {
        const e = this.net.edge(Number(sel.id));
        this.store.commit('Delete closure', (doc) => { B.ops.setClosed(doc, [Number(sel.id)], false); });
        this._showToast(`${B.esc(e ? e.name : 'Road')} reopened`, 'info');
      } else {
        return;
      }
      this.renderer.selected = null;
      this.renderer.requestRender();
    }

    // How many drawings came in on the project's link since its last Refresh (0 when none)
    _drawUpdatePending(p) {
      const session = p.drawLink && this._loadDrawSession(p.drawLink.sid);
      if (!session || !(session.updatedAt > (p.drawLink.refreshedAt || 0))) return 0;
      return Math.max(1, Object.keys(session.areas || {}).length + Object.keys(session.closures || {}).length);
    }

    // The project's affected areas: how many, then one chip each. A chip shows only the buses through
    // that area and brings it into view; clicking it again shows every bus.
    _buildProjectAreas(p) {
      const doc = p.id === this.activeProjectId ? this.store.doc : this._storedAreasClosures(p.id);
      const areas = Object.values((doc && doc.areas) || {});
      const areaIds = new Set(areas.map((a) => a.id));
      const areaNames = new Set(areas.map((a) => `Closed by ${a.name}`));
      const areaPolyEdges = new Set();
      if (this.net && this.store && typeof this.store.areaPoly === 'function') {
        for (const a of areas) {
          try {
            const poly = this.store.areaPoly(a);
            if (poly) {
              const edges = this.net.edgesInPolygon(poly);
              for (const eid of edges) areaPolyEdges.add(Number(eid));
            }
          } catch (e) {}
        }
      }
      const standaloneRoads = new Set();
      let standaloneAnonymous = 0;
      for (const [edgeIdStr, cl] of Object.entries((doc && doc.closures) || {})) {
        if (!cl) continue;
        const eid = Number(edgeIdStr);
        if (cl.areaId && areaIds.has(cl.areaId)) continue;
        if (cl.reason && areaNames.has(cl.reason)) continue;
        if (areaPolyEdges.has(eid)) continue;
        const edgeObj = this.net && typeof this.net.edge === 'function' ? this.net.edge(eid) : null;
        const roadKey = cl.roadName || (edgeObj && edgeObj.name) || cl.closureId || null;
        if (roadKey) {
          standaloneRoads.add(roadKey.toLowerCase().trim());
        } else {
          standaloneAnonymous++;
        }
      }
      const standaloneCount = standaloneRoads.size + standaloneAnonymous;
      const totalCount = areas.length + standaloneCount;
      const row = document.createElement('div');
      row.className = 'project-areas';
      row.dataset.projectId = p.id;
      row.innerHTML = `
        <div class="project-areas-head">
          <span class="project-areas-label">Affected areas</span>
          <span class="project-areas-count">${totalCount}</span>
        </div>
        ${areas.length ? `<div class="project-area-chips">${areas.map((a) => `
          <button type="button" class="project-area-chip" data-area-id="${B.esc(a.id)}" title="Show only the buses through ${B.esc(a.name || a.id)}">${B.esc(a.name || a.id)}</button>
        `).join('')}</div>` : ''}
      `;
      row.querySelectorAll('.project-area-chip').forEach((chip) => {
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          this._filterByArea(p.id, chip.dataset.areaId);
        });
      });
      this._syncAreaChips(row);
      return row;
    }

    // After the map changes, the open project's count and chips follow it
    _refreshProjectAreas() {
      const row = document.querySelector(`.project-areas[data-project-id="${CSS.escape(this.activeProjectId || '')}"]`);
      const p = (this.projects || []).find((x) => x.id === this.activeProjectId);
      if (row && p) row.replaceWith(this._buildProjectAreas(p));
    }

    // The chip of the area being filtered stays lit while its buses are the ones shown
    _syncAreaChips(root = document) {
      const qf = this.quickFilter;
      const keys = qf && qf.keys && this._quickFilterOn(qf) ? qf.keys : new Set();
      root.querySelectorAll('.project-area-chip').forEach((chip) => {
        const row = chip.closest('.project-areas');
        const on = !!row && row.dataset.projectId === this.activeProjectId && keys.has('area:' + chip.dataset.areaId);
        chip.classList.toggle('active', on);
        chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }

    _filterByArea(projectId, areaId) {
      if (projectId !== this.activeProjectId) this._switchProject(projectId);
      const area = this.store.doc.areas[areaId];
      if (!area) return;
      const key = 'area:' + areaId;
      const allIds = Object.keys(this.store.doc.routes);
      const on = !!this.quickFilter && !!this.quickFilter.keys && this.quickFilter.keys.has(key) && this._quickFilterOn(this.quickFilter);
      if (on) {
        this.quickFilter = null;
        this.selectedRouteIds = new Set(allIds);
      } else {
        const ids = Object.values(this.store.doc.routes).filter((r) => this._routeThroughArea(r, area)).map((r) => r.id);
        if (ids.length) {
          this.quickFilter = { keys: new Set([key]), ids: new Set(ids) };
          this.selectedRouteIds = new Set(ids);
        } else {
          this._showToast(`No buses through ${B.esc(area.name || area.id)}`, 'info');
        }
      }
      this.isAllRoutesSelected = this.selectedRouteIds.size === allIds.length;
      this._applyRouteMultiSelection();
      if (!on) {
        // The area with some of the streets round it
        const bb = B.bbox(this.store.areaPoly(area), 600);
        this._fitClearOfPanels(bb);
      }
      this._syncAreaChips();
    }

    // A bus that drives a road inside the area or stops inside it
    _routeThroughArea(r, area) {
      const edges = new Set(this.store.areaEdges[area.id] || []);
      const g = this.store.geom[r.id];
      if (g && g.legs && g.legs.some((l) => l.ok && (l.segs || []).some((sg) => edges.has(sg.edge)))) return true;
      const poly = this.store.areaPoly(area);
      return (r.anchors || []).some((a) => {
        const st = a.t === 'stop' && this.store.doc.stops[a.id];
        return !!st && B.pointInPoly(this.net.posPoint(st, 0.78), poly);
      });
    }

    _buildDrawLinkRow(p) {
      const row = document.createElement('div');
      row.className = 'project-drawlink';
      const pending = this._drawUpdatePending(p);
      // "Draw closure" with its link icon on the left; the refresh icon on the right
      row.innerHTML = `
        <span class="drawlink-label">Draw closure</span>
        <button type="button" class="btn-drawlink-icon btn-drawlink-copy" title="Copy a link for drawing affected areas and road closures on ${B.esc(p.name)}" aria-label="Copy drawing link">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
        </button>
        <button type="button" class="btn-drawlink-icon btn-drawlink-refresh" ${p.drawLink ? '' : 'disabled'} title="${p.drawLink ? 'Add what was drawn on the link' : 'Copy the drawing link first'}" aria-label="Refresh drawings">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
          ${pending ? `<span class="drawlink-count">${pending}</span>` : ''}
        </button>
      `;
      row.querySelector('.btn-drawlink-copy').addEventListener('click', (e) => { e.stopPropagation(); this._copyDrawLink(p); });
      row.querySelector('.btn-drawlink-refresh').addEventListener('click', (e) => { e.stopPropagation(); this._refreshDrawings(p); });
      return row;
    }

    // Owner: copy the project's drawing link (one per project; copying again keeps the same link)
    async _copyDrawLink(p) {
      const doc = p.id === this.activeProjectId ? this.store.doc : this._loadProjectDraft(p.id);
      if (!p.drawLink) {
        p.drawLink = { sid: `draw-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, createdAt: Date.now() };
        this._saveProjects();
      }
      try {
        const data = await this._encodeShare({ sid: p.drawLink.sid, pid: p.id, name: p.name, doc });
        await this._copyText(`${location.origin}${location.pathname}#draw=${data}`);
        this._showToast('Drawing link copied', 'success');
      } catch (e) {
        console.warn('Could not make a drawing link', e);
        this._showToast("Couldn't copy the link", 'warn');
      }
      this._renderProjects();
    }

    // Owner: add the latest drawings to the project, replacing what an earlier Refresh added
    _refreshDrawings(p) {
      const session = p.drawLink && this._loadDrawSession(p.drawLink.sid);
      const sid = p.drawLink && p.drawLink.sid;
      if (!session) {
        this._showToast('Nothing drawn yet', 'info');
        return;
      }
      const merge = (doc) => {
        doc.areas = doc.areas || {};
        doc.closures = doc.closures || {};
        for (const [id, a] of Object.entries(doc.areas)) if (a.fromLink === sid) delete doc.areas[id];
        for (const [edge, c] of Object.entries(doc.closures)) if (c && c.fromLink === sid) delete doc.closures[edge];
        // Areas get ids of this project, and their roads closed by them follow
        const idMap = {};
        for (const [oldId, a] of Object.entries(session.areas || {})) {
          // Same numbering as new areas in the editor (Store.newId), skipping any id already used
          let id;
          do { id = 'A' + (doc.seq = doc.seq || 1000); doc.seq += 1; } while (doc.areas[id]);
          idMap[oldId] = id;
          doc.areas[id] = { ...a, id, name: (a.name || '').replace(oldId, id) || `Disruption Zone ${id}`, fromLink: sid };
        }
        for (const [edge, c] of Object.entries(session.closures || {})) {
          if (doc.closures[edge]) continue;
          const closure = { ...c, fromLink: sid };
          if (closure.areaId) closure.areaId = idMap[closure.areaId] || closure.areaId;
          doc.closures[edge] = closure;
        }
        return { areas: Object.keys(session.areas || {}).length, closures: Object.keys(session.closures || {}).length };
      };

      let counts;
      if (p.id === this.activeProjectId) {
        this.store.commit(`Add drawings to ${p.name}`, (doc) => { counts = merge(doc); });
      } else {
        const doc = this._loadProjectDraft(p.id);
        counts = merge(doc);
        try { localStorage.setItem('brass_proj_doc_' + p.id, JSON.stringify(doc)); } catch (e) {}
      }
      p.drawLink.refreshedAt = Date.now();
      this._markProjectInProgress(p.id);
      this._saveProjects();
      this._renderProjects();
      const parts = [];
      if (counts.areas) parts.push(`${counts.areas} area${counts.areas === 1 ? '' : 's'}`);
      if (counts.closures) parts.push(`${counts.closures} road closure${counts.closures === 1 ? '' : 's'}`);
      this._showToast(parts.length ? `Added ${parts.join(', ')}` : 'Nothing drawn yet', parts.length ? 'success' : 'info');
    }

    // ------------------------------------------------------------- Delete Project Confirmation Pop-up (Minimal)
    _initConfirmDeleteProjectModal() {
      const modal = document.getElementById('confirm-delete-project-modal');
      const btnCloseX = document.getElementById('btn-close-project-modal-x');
      const btnCancel = document.getElementById('btn-project-modal-cancel');
      const btnConfirm = document.getElementById('btn-project-modal-confirm');
      const input = document.getElementById('modal-project-input');

      const checkMatch = () => {
        if (!this.pendingDeleteProjectId) return false;
        const proj = this.projects.find((p) => p.id === this.pendingDeleteProjectId);
        if (!proj) return false;
        const targetName = (proj.name || '').trim().toLowerCase();
        const typed = (input ? input.value : '').trim().toLowerCase();
        const match = Boolean(targetName && typed === targetName);
        if (btnConfirm) btnConfirm.disabled = !match;
        return match;
      };

      if (input) {
        input.addEventListener('input', checkMatch);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (checkMatch()) {
              this._confirmDeleteProject();
            }
          }
        });
      }

      if (btnCloseX) {
        btnCloseX.addEventListener('click', () => this._closeConfirmDeleteProjectModal());
      }
      if (btnCancel) {
        btnCancel.addEventListener('click', () => this._closeConfirmDeleteProjectModal());
      }
      if (modal) {
        modal.addEventListener('click', (e) => {
          if (e.target === modal) {
            this._closeConfirmDeleteProjectModal();
          }
        });
      }
      if (btnConfirm) {
        btnConfirm.addEventListener('click', () => {
          if (btnConfirm.disabled) return;
          this._confirmDeleteProject();
        });
      }
    }

    _promptDeleteProject(id) {
      if (id === 'main') return;
      const proj = this.projects.find((p) => p.id === id);
      if (!proj) return;

      this.pendingDeleteProjectId = id;

      const modal = document.getElementById('confirm-delete-project-modal');
      if (!modal) {
        this._deleteProject(id);
        return;
      }

      const nameEl = document.getElementById('modal-project-name');
      if (nameEl) nameEl.textContent = proj.name || 'this project';
      const noteEl = document.getElementById('modal-project-note');
      if (noteEl) noteEl.hidden = !this._projectOnCurrentMap(id);

      const input = document.getElementById('modal-project-input');
      const btnConfirm = document.getElementById('btn-project-modal-confirm');
      if (input) {
        input.value = '';
        input.placeholder = `Type "${proj.name || 'project'}"`;
      }
      if (btnConfirm) btnConfirm.disabled = true;

      modal.classList.remove('hidden');
      if (input && typeof input.focus === 'function') {
        setTimeout(() => input.focus(), 50);
      }
    }

    _confirmDeleteProject() {
      const id = this.pendingDeleteProjectId;
      if (!id) return;
      const proj = this.projects.find((p) => p.id === id);
      if (proj) {
        const input = document.getElementById('modal-project-input');
        const typed = (input ? input.value : '').trim().toLowerCase();
        if (typed !== (proj.name || '').trim().toLowerCase()) return;
      }
      this._closeConfirmDeleteProjectModal();
      this._deleteProject(id);
    }

    _closeConfirmDeleteProjectModal() {
      const modal = document.getElementById('confirm-delete-project-modal');
      if (modal) {
        modal.classList.add('hidden');
      }
      const input = document.getElementById('modal-project-input');
      if (input) input.value = '';
      const btnConfirm = document.getElementById('btn-project-modal-confirm');
      if (btnConfirm) btnConfirm.disabled = true;
      this.pendingDeleteProjectId = null;
    }

    // ------------------------------------------------------------- Restore Version Confirmation Pop-up
    _initConfirmRestoreVersionModal() {
      const modal = document.getElementById('confirm-restore-version-modal');
      const btnCloseX = document.getElementById('btn-close-restore-modal-x');
      const btnCancel = document.getElementById('btn-restore-modal-cancel');
      const btnConfirm = document.getElementById('btn-restore-modal-confirm');

      if (btnCloseX) {
        btnCloseX.addEventListener('click', () => this._closeConfirmRestoreVersionModal());
      }
      if (btnCancel) {
        btnCancel.addEventListener('click', () => this._closeConfirmRestoreVersionModal());
      }
      if (modal) {
        modal.addEventListener('click', (e) => {
          if (e.target === modal) {
            this._closeConfirmRestoreVersionModal();
          }
        });
      }
      if (btnConfirm) {
        btnConfirm.addEventListener('click', () => this._confirmRestoreMapVersion());
      }
    }

    _promptRestoreMapVersion(versionId) {
      const v = this.mapVersions.find((item) => item.id === versionId);
      if (!v) return;

      this.pendingRestoreVersionId = versionId;

      const modal = document.getElementById('confirm-restore-version-modal');
      if (!modal) {
        this._confirmRestoreMapVersion();
        return;
      }

      const titleEl = document.getElementById('modal-restore-title');
      if (titleEl) titleEl.textContent = 'Restore this version?';
      const nameEl = document.getElementById('modal-restore-name');
      if (nameEl) nameEl.textContent = `${this._mapVersionName(v)} (${this._formatShortTime(v.appliedAt)})`;

      modal.classList.remove('hidden');
      const btnCancel = document.getElementById('btn-restore-modal-cancel');
      if (btnCancel && typeof btnCancel.focus === 'function') {
        setTimeout(() => btnCancel.focus(), 50);
      }
    }

    _confirmRestoreMapVersion() {
      const id = this.pendingRestoreVersionId;
      if (!id) return;
      this._closeConfirmRestoreVersionModal();
      this._restoreMapVersion(id);
    }

    _closeConfirmRestoreVersionModal() {
      const modal = document.getElementById('confirm-restore-version-modal');
      if (modal) {
        modal.classList.add('hidden');
      }
      this.pendingRestoreVersionId = null;
    }

    // ------------------------------------------------------------- New Bus Number Pop-up
    // Number and operating hours; the colour is picked at random from the ones no other bus uses
    _initNewBusModal() {
      const modal = document.getElementById('new-bus-modal');
      if (!modal) return;
      const close = () => this._closeNewBusModal();
      ['btn-close-new-bus-x', 'btn-new-bus-cancel'].forEach((id) => {
        const btn = document.getElementById(id);
        if (btn) btn.addEventListener('click', close);
      });
      modal.addEventListener('click', (e) => {
        if (e.target === modal) close();
      });
      const btnCreate = document.getElementById('btn-new-bus-create');
      if (btnCreate) btnCreate.addEventListener('click', () => this._confirmNewBus());
      // The bin asks first
      const btnDelete = document.getElementById('btn-new-bus-delete');
      if (btnDelete) {
        btnDelete.addEventListener('click', () => {
          const num = this.editingBusNumber;
          if (!num) return;
          this._closeNewBusModal();
          this._promptDeleteBus(num);
        });
      }
      const delModal = document.getElementById('delete-bus-modal');
      if (delModal) {
        // Like deleting a stop: Delete unlocks once the bus number is typed exactly
        const delInput = document.getElementById('delete-bus-confirm-input');
        const delBtn = document.getElementById('btn-delete-bus-confirm');
        const matches = () => !!this.deletingBusNumber && delInput.value.trim() === this.deletingBusNumber;
        const closeDel = () => { delModal.classList.add('hidden'); this.deletingBusNumber = null; };
        const confirmDel = () => {
          if (!matches()) return;
          const num = this.deletingBusNumber;
          closeDel();
          this._deleteBusNumber(num);
        };
        delInput.addEventListener('input', () => { delBtn.disabled = !matches(); });
        ['btn-close-delete-bus-x', 'btn-delete-bus-cancel'].forEach((id) => document.getElementById(id).addEventListener('click', closeDel));
        delBtn.addEventListener('click', confirmDel);
        delModal.addEventListener('click', (e) => { if (e.target === delModal) closeDel(); });
        delModal.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { e.preventDefault(); closeDel(); }
          else if (e.key === 'Enter' && e.target && e.target.id === 'delete-bus-confirm-input') { e.preventDefault(); confirmDel(); }
        });
      }

      const activeBtn = document.getElementById('new-bus-active');
      if (activeBtn) activeBtn.addEventListener('click', () => this._setNewBusActive(!activeBtn.classList.contains('on')));

      // Day chips toggle; a bus keeps at least one day
      modal.querySelectorAll('#new-bus-days .day-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          if (chip.disabled) return;
          const onCount = modal.querySelectorAll('#new-bus-days .day-chip.on').length;
          if (chip.classList.contains('on') && onCount === 1) return;
          chip.classList.toggle('on');
          chip.setAttribute('aria-pressed', String(chip.classList.contains('on')));
        });
      });

      // The badge shows the number on its colour as it is typed
      const input = document.getElementById('new-bus-number');
      if (input) input.addEventListener('input', () => this._updateNewBusBadge());

      // Enter creates and Esc closes, even while typing in a field
      modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          close();
        } else if (e.key === 'Enter' && !(e.target && (e.target.id === 'btn-new-bus-cancel' || e.target.id === 'btn-new-bus-delete'))) {
          e.preventDefault();
          this._confirmNewBus();
        }
      });
    }

    // Without a number: a new bus. With one: edit that bus (its number and hours, or delete it).
    _promptNewBus(editNumber = null) {
      this._ensureEditableForRoute();
      if (this._isCurrentMapReadOnly()) return;
      // A project in view mode can't be changed
      if (editNumber && this.mode === 'view') {
        this._showToast('View mode · switch to edit to change it', 'info');
        return;
      }
      const modal = document.getElementById('new-bus-modal');
      if (!modal) return;

      const routes = Object.values(this.store.doc.routes);
      const editing = editNumber ? this._busGroups(routes).find((g) => g.number === String(editNumber).trim()) : null;
      this.editingBusNumber = editing ? editing.number : null;
      this.newBusColor = editing ? editing.color : B.randomRouteColor(routes.map((r) => r.color));
      const hours = editing ? B.busHours(this.store.doc, editing.number) : { start: '06:00', end: '23:00' };
      // A new bus gets a random model; an existing one shows its own
      const model = editing ? B.busModel(this.store.doc, editing.number) : B.BUS_MODELS[Math.floor(Math.random() * B.BUS_MODELS.length)];
      const modelSelect = document.getElementById('new-bus-model');
      if (modelSelect) modelSelect.value = model;
      const fleetInput = document.getElementById('new-bus-fleet');
      if (fleetInput) fleetInput.value = String(editing ? this._busFleet(editing.number) : 4);
      const activeRow = document.getElementById('new-bus-active-row');
      if (activeRow) activeRow.hidden = !editing;
      this._setNewBusActive(editing ? B.busActive(this.store.doc, editing.number) : true);
      const busDays = editing ? B.busDays(this.store.doc, editing.number) : B.ALL_DAYS;
      document.querySelectorAll('#new-bus-days .day-chip').forEach((chip) => {
        const on = busDays.includes(Number(chip.dataset.day));
        chip.classList.toggle('on', on);
        chip.setAttribute('aria-pressed', String(on));
      });

      const input = document.getElementById('new-bus-number');
      if (input) input.value = editing ? editing.number : '';
      const start = document.getElementById('new-bus-start');
      const end = document.getElementById('new-bus-end');
      if (start) start.value = hours.start;
      if (end) end.value = hours.end;

      const title = document.getElementById('new-bus-title');
      if (title) title.textContent = editing ? 'Edit bus' : 'New bus number';
      const btnCreate = document.getElementById('btn-new-bus-create');
      if (btnCreate) btnCreate.textContent = editing ? 'Save' : 'Create';
      const btnDelete = document.getElementById('btn-new-bus-delete');
      if (btnDelete) btnDelete.hidden = !editing;
      this._showNewBusError('');
      this._updateNewBusBadge();

      // Render road segment constraints when editing an existing bus route
      this._renderNewBusConstraints(editing ? editing.routes[0] : null);

      modal.classList.remove('hidden');
      if (input) setTimeout(() => input.focus(), 50);
    }

    _renderNewBusConstraints(route) {
      const box = document.getElementById('new-bus-constraints-section');
      if (!box) return;
      if (!route) {
        box.hidden = true;
        box.innerHTML = '';
        return;
      }
      const g = this.store.geom[route.id];
      box.hidden = false;
      box.innerHTML = this._renderRouteSegmentsConstraintsHtml(route, g);
      this._bindConstraintEvents(box, route, () => {
        const fresh = this.store.doc.routes[route.id];
        this._renderNewBusConstraints(fresh);
      });
    }

    // Buses running on a bus number: the number set in Edit bus, else enough for one every 10 minutes
    _busFleet(number) {
      const set = B.busFleetSet(this.store.doc, number);
      if (set) return set;
      const num = String(number).trim();
      const oneWay = Object.values(this.store.doc.routes)
        .filter((r) => String(r.number).trim() === num)
        .reduce((t, r) => t + ((this.store.geom[r.id] && this.store.geom[r.id].time) || 0), 0);
      return B.defaultBusFleet(oneWay);
    }

    // While a temporary project is live on the Current Map: the map without it (worked out once per base)
    _temporaryBase() {
      if (this.activeProjectId !== 'main' || this.reviewMode || !this.scheduledBase || !this._liveScheduledChanges().length) return null;
      const key = JSON.stringify(this.scheduledBase);
      if (this._tempBaseCache && this._tempBaseCache.key === key) return this._tempBaseCache.calc;
      const calc = Object.create(B.Store.prototype);
      Object.assign(calc, { city: this.store.city, net: this.store.net, doc: JSON.parse(key), legCache: this.store.legCache });
      calc.derive();
      this._tempBaseCache = { key, calc };
      return calc;
    }

    // A route's numbers before the live temporary project: its buses, and the piece's time, length and stops
    _routeNumbersBefore(r) {
      const calc = this._temporaryBase();
      if (!calc) return null;
      const num = String(r.number).trim();
      const line = this._busLine(calc.doc, calc.geom, num);
      if (!line.pieces.length) return null;
      return {
        fleet: B.busFleetSet(calc.doc, num) || B.defaultBusFleet(line.time || 0),
        time: line.time,
        length: line.length,
        stops: line.time != null ? line.stops.length : null,
      };
    }

    // One bus number as a whole: its pieces' travel time and distance added up, and its stops in order.
    // A stop shared with an earlier piece is listed once; each piece starts at an origin and ends at a terminal.
    _busLine(doc, geom, number) {
      const num = String(number).trim();
      const pieces = Object.values(doc.routes).filter((x) => String(x.number).trim() === num);
      const stops = [];
      const listed = new Set();
      let time = 0;
      let length = 0;
      let drawn = false;
      for (const p of pieces) {
        const g = geom[p.id];
        if (g) {
          time += g.time || 0;
          length += g.length || 0;
          drawn = true;
        }
        // Waypoints only pin a path in place; the list shows real stops
        const ids = (p.anchors || []).filter((a) => a.t === 'stop').map((a) => a.id);
        const earlier = new Set(listed);
        ids.forEach((id, i) => {
          if (earlier.has(id)) return;
          stops.push({ id, isStart: i === 0, isEnd: i === ids.length - 1 });
          listed.add(id);
        });
      }
      return { pieces, time: drawn ? time : null, length: drawn ? length : null, stops };
    }

    // ▲ in green or ▼ in red when a number moved since before the live temporary project
    _deltaArrow(now, before, fmt = String) {
      if (before == null || now == null || fmt(now) === fmt(before)) return '';
      const up = now > before;
      return `<span class="delta-arrow ${up ? 'up' : 'down'}" title="Was ${B.esc(fmt(before))}">${up ? '▲' : '▼'}</span>`;
    }

    // A small pop-up whose button unlocks once `word` is typed exactly
    _confirmByTyping({ title, word, action = 'Delete', onConfirm }) {
      const modal = document.getElementById('typed-confirm-modal');
      if (!modal) return onConfirm();
      const input = document.getElementById('typed-confirm-input');
      const ok = document.getElementById('btn-typed-confirm-ok');
      document.getElementById('typed-confirm-title').textContent = title;
      document.getElementById('typed-confirm-word').textContent = word;
      ok.textContent = action;
      ok.disabled = true;
      input.value = '';
      input.placeholder = word;

      const matches = () => input.value.trim() === String(word).trim();
      const close = () => {
        modal.classList.add('hidden');
        input.oninput = null;
        ok.onclick = null;
        modal.onkeydown = null;
        modal.onclick = null;
      };
      const confirm = () => {
        if (!matches()) return;
        close();
        onConfirm();
      };
      input.oninput = () => { ok.disabled = !matches(); };
      ok.onclick = confirm;
      document.getElementById('btn-typed-confirm-cancel').onclick = close;
      document.getElementById('btn-close-typed-confirm-x').onclick = close;
      modal.onclick = (e) => { if (e.target === modal) close(); };
      modal.onkeydown = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        else if (e.key === 'Enter' && e.target === input) { e.preventDefault(); confirm(); }
      };
      modal.classList.remove('hidden');
      setTimeout(() => input.focus(), 30);
    }

    _promptDeleteBus(num) {
      const modal = document.getElementById('delete-bus-modal');
      if (!modal) return this._deleteBusNumber(num);
      this.deletingBusNumber = num;
      document.getElementById('delete-bus-name').textContent = num;
      const input = document.getElementById('delete-bus-confirm-input');
      input.value = '';
      input.placeholder = num;
      document.getElementById('btn-delete-bus-confirm').disabled = true;
      modal.classList.remove('hidden');
      setTimeout(() => input.focus(), 30);
    }

    // Not active locks the hours and days in the popup (they're kept for when the bus runs again)
    _setNewBusActive(on) {
      const btn = document.getElementById('new-bus-active');
      if (!btn) return;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-checked', String(on));
      btn.querySelector('.bus-active-label').textContent = on ? 'Active' : 'Not active';
      ['new-bus-start', 'new-bus-end', 'new-bus-fleet'].forEach((id) => { const el = document.getElementById(id); if (el) el.disabled = !on; });
      document.querySelectorAll('#new-bus-days .day-chip').forEach((chip) => { chip.disabled = !on; });
      document.querySelectorAll('#new-bus-modal .new-bus-hours, #new-bus-days, #new-bus-fleet').forEach((el) => el.classList.toggle('is-locked', !on));
    }

    _updateNewBusBadge() {
      const badge = document.getElementById('new-bus-badge');
      const input = document.getElementById('new-bus-number');
      if (!badge) return;
      badge.style.background = this.newBusColor || '#2563eb';
      badge.textContent = (input && input.value.trim()) || '–';
      this._showNewBusError('');
    }

    _showNewBusError(msg) {
      const el = document.getElementById('new-bus-error');
      if (!el) return;
      el.textContent = msg;
      el.hidden = !msg;
    }

    _confirmNewBus() {
      const input = document.getElementById('new-bus-number');
      const num = String((input && input.value) || '').trim();
      const start = (document.getElementById('new-bus-start') || {}).value;
      const end = (document.getElementById('new-bus-end') || {}).value;
      const model = (document.getElementById('new-bus-model') || {}).value || B.BUS_MODELS[0];
      const days = [...document.querySelectorAll('#new-bus-days .day-chip.on')].map((chip) => Number(chip.dataset.day));
      const activeBtn = document.getElementById('new-bus-active');
      const active = !activeBtn || activeBtn.classList.contains('on');
      const fleet = Number((document.getElementById('new-bus-fleet') || {}).value);

      if (!num) {
        this._showNewBusError('Enter a bus number');
        if (input) input.focus();
        return;
      }
      if (!Number.isInteger(fleet) || fleet < 1 || fleet > 99) {
        this._showNewBusError('Number of buses: 1 to 99');
        const fi = document.getElementById('new-bus-fleet');
        if (fi) fi.focus();
        return;
      }
      if (this.editingBusNumber) {
        this._saveBusEdit(this.editingBusNumber, num, start, end, model, days, active, fleet);
        return;
      }
      if (Object.values(this.store.doc.routes).some((r) => String(r.number).trim() === num)) {
        this._showNewBusError(`Bus ${num} already exists`);
        if (input) input.focus();
        return;
      }
      if (!start || !end) {
        this._showNewBusError('Set the operating hours');
        return;
      }

      this._closeNewBusModal();
      // Drawing a route needs Edit mode
      if (this.mode !== 'edit') this._switchProject(this.activeProjectId, 'edit');

      // The bus joins the list straight away; it gets its stops when its route is drawn
      let id = null;
      this.store.commit(`New Bus ${num}`, (doc) => {
        id = this.store.newId('R');
        doc.routes[id] = {
          id,
          number: num,
          name: `Bus ${num}`,
          color: this.newBusColor,
          kind: 'proposed',
          baseId: null,
          override: false,
          planned: true,
          hours: { start, end },
          model,
          days: days.length ? days : B.ALL_DAYS.slice(),
          fleet,
          anchors: [],
        };
      });
      if (id && !this.selectedRouteIds.has(id)) {
        this.selectedRouteIds.add(id);
        this.isAllRoutesSelected = this.selectedRouteIds.size === Object.keys(this.store.doc.routes).length;
        this._applyRouteMultiSelection();
      }
      this.pendingNewBus = { number: num };
      this._syncToolbar();
      this._showToast(`Bus ${B.esc(num)} added. Click a Bus Interchange to start its route`, 'success');
    }

    _closeNewBusModal() {
      const modal = document.getElementById('new-bus-modal');
      if (modal) modal.classList.add('hidden');
      this.editingBusNumber = null;
    }

    // Renames every piece of a bus number and sets its hours and model
    _saveBusEdit(oldNum, num, start, end, model, days = null, active = true, fleet = null) {
      if (num !== oldNum && Object.values(this.store.doc.routes).some((r) => String(r.number).trim() === num)) {
        this._showNewBusError(`Bus ${num} already exists`);
        const input = document.getElementById('new-bus-number');
        if (input) input.focus();
        return;
      }
      if (!start || !end) {
        this._showNewBusError('Set the operating hours');
        return;
      }
      if (model && model !== B.busModel(this.store.doc, oldNum)) {
        const ids = Object.values(this.store.doc.routes).filter((r) => String(r.number).trim() === oldNum).map((r) => r.id);
        const stopIds = new Set(ids.flatMap((rid) => (this.store.doc.routes[rid].anchors || []).filter((a) => a.t === 'stop').map((a) => a.id)));
        for (const sid of stopIds) {
          const others = (this.store.stopLines[sid] || []).filter((rid) => !ids.includes(rid));
          if (!B.stopBusTypes(this.store.doc, sid, others).includes(model)) {
            this._showNewBusError(`${this.store.doc.stops[sid].name} can't take ${model}`);
            return;
          }
        }
      }
      const escaped = oldNum.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const namePrefix = new RegExp(`^(Route|Bus) ${escaped}(?=\\s|$)`);
      this.store.commit(num === oldNum ? `Bus ${num} hours` : `Bus ${oldNum} → ${num}`, (doc) => {
        for (const r of Object.values(doc.routes)) {
          if (String(r.number).trim() !== oldNum) continue;
          r.number = num;
          if (r.name) r.name = r.name.replace(namePrefix, `$1 ${num}`);
          r.hours = { start, end };
          if (model) r.model = model;
          if (days && days.length) r.days = days;
          if (active) delete r.active;
          else r.active = false;
          if (fleet) r.fleet = fleet;
        }
      });
      this._closeNewBusModal();
      this._showToast(num === oldNum ? `Bus ${B.esc(num)} saved` : `Bus ${B.esc(oldNum)} is now Bus ${B.esc(num)}`, 'success');
    }

    // Removes every piece of a bus number (Cmd+Z brings it back)
    _deleteBusNumber(num) {
      const ids = Object.values(this.store.doc.routes).filter((r) => String(r.number).trim() === num).map((r) => r.id);
      if (!ids.length) return;
      this.store.commit(`Delete Bus ${num}`, (doc) => {
        for (const id of ids) delete doc.routes[id];
      });
      const sel = this.renderer.selected;
      if (sel && ids.includes(sel.routeId || sel.id)) {
        this.renderer.selected = null;
        this._hideInspector();
      }
      this._hideFloatingLegActions();
      this._closeNewBusModal();
      this.renderer.requestRender();
      this._showToast(`Deleted Bus ${B.esc(num)}`, 'info');
    }

    _closeBusDropdown() {
      const menu = document.getElementById('multi-select-dropdown');
      const trigger = document.getElementById('multi-select-trigger');
      if (menu) menu.classList.add('hidden');
      if (trigger) {
        trigger.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
      }
    }

    // Deleting a project deletes its draft only: whatever it applied to the Current Map stays there, for the
    // time that was set (a temporary change still ends when it was due to)
    _deleteProject(id) {
      if (id === 'main') return;
      const idx = this.projects.findIndex((p) => p.id === id);
      if (idx === -1) return;

      const deleted = this.projects.splice(idx, 1)[0];
      if (this.editingProjectId === id) {
        this.editingProjectId = null;
      }

      this._saveProjects();
      if (this.activeProjectId === id) {
        // Leave it first, so its map is never saved as the next one's
        const nextId = this.projects.length ? this.projects[Math.max(0, idx - 1)].id : 'main';
        this._switchProject(nextId, nextId === 'main' ? 'view' : undefined);
      }

      try {
        localStorage.removeItem('brass_proj_doc_' + id);
        localStorage.removeItem('brass_proj_base_' + id);
        if (deleted.drawLink) localStorage.removeItem('brass_draw_' + deleted.drawLink.sid);
      } catch (e) {}

      this._syncForeignObstacles();
      this._renderProjects();
      if (this._showToast) this._showToast(`Deleted ${deleted.name}`, 'info');
    }

    // Whether a project is Go-Live (active) or has put anything on the Current Map
    _projectOnCurrentMap(id) {
      const p = (this.projects || []).find((x) => x.id === id);
      if (p && p.status === 'go_live') return true;
      return (this.scheduledChanges || []).some((sc) => sc.projectId === id) ||
        (this.mapVersions || []).some((v) => v.type === 'permanent' && v.projectId === id);
    }

    // Takes versions off the history, with the maps kept for them
    _dropMapVersions(test) {
      const gone = (this.mapVersions || []).filter(test);
      if (!gone.length) return;
      for (const v of gone) {
        this._dropMapSnapshot(v);
        try { localStorage.removeItem('brass_project_map_' + v.id); } catch (e) {}
      }
      this.mapVersions = this.mapVersions.filter((v) => !test(v));
      this._saveMapVersions();
    }

    // ------------------------------------------------------------- Apply to Current Map Confirmation & Review Dialog
    _initConfirmApplyProjectModal() {
      const modal = document.getElementById('confirm-apply-project-modal');
      const btnCloseX = document.getElementById('btn-close-apply-modal-x');
      const btnCancel = document.getElementById('btn-apply-modal-cancel');
      const btnConfirm = document.getElementById('btn-apply-modal-confirm');

      if (btnCloseX) {
        btnCloseX.addEventListener('click', () => this._closeConfirmApplyProjectModal());
      }
      if (btnCancel) {
        btnCancel.addEventListener('click', () => this._closeConfirmApplyProjectModal());
      }
      if (modal) {
        modal.addEventListener('click', (e) => {
          if (e.target === modal) {
            this._closeConfirmApplyProjectModal();
          }
        });
      }
      if (btnConfirm) {
        btnConfirm.addEventListener('click', () => this._confirmApplyProject());
      }
    }

    _promptApplyProject(p, period) {
      this.pendingApplyProject = { project: p, period };

      const modal = document.getElementById('confirm-apply-project-modal');
      if (!modal) {
        this._applyProjectToCurrentMap(p.id, period);
        return;
      }

      // One line: when it applies and how many changes it brings
      const projDoc = (this.activeProjectId === p.id) ? this.store.doc : this._loadProjectDraft(p.id);
      const currentMap = (this.activeProjectId === 'main') ? this.store.doc : this._loadProjectDraft('main');
      const changes = this._computeProjectChanges(currentMap, projDoc);
      const count = changes.length;
      let when = 'Permanent';
      if (period.mode === 'scheduled') {
        const sameDay = new Date(period.start).toDateString() === new Date(period.end).toDateString();
        const endText = sameDay
          ? new Date(period.end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
          : this._formatShortTime(period.end);
        when = period.start <= Date.now()
          ? `Temporary until ${this._formatShortTime(period.end)}`
          : `Temporary, ${this._formatShortTime(period.start)} – ${endText}`;
      }

      const titleEl = document.getElementById('apply-modal-title');
      if (titleEl) titleEl.textContent = `Apply ${p.name || 'project'}?`;
      const descEl = document.getElementById('apply-modal-desc');
      if (descEl) descEl.textContent = `${when} · ${count ? `${count} change${count === 1 ? '' : 's'}` : 'No changes'}`;

      // The first few changes, one short line each
      const listEl = document.getElementById('apply-modal-changes');
      if (listEl) {
        const MAX_SHOWN = 5;
        listEl.innerHTML = '';
        changes.slice(0, MAX_SHOWN).forEach((ch) => {
          const li = document.createElement('li');
          li.className = `apply-change tone-${ch.action}`;
          li.textContent = ch.text;
          listEl.appendChild(li);
        });
        if (count > MAX_SHOWN) {
          const more = document.createElement('li');
          more.className = 'apply-change more';
          more.textContent = `${count - MAX_SHOWN} more`;
          listEl.appendChild(more);
        }
        listEl.hidden = !count;
      }

      modal.classList.remove('hidden');
      const btnConfirm = document.getElementById('btn-apply-modal-confirm');
      if (btnConfirm && typeof btnConfirm.focus === 'function') {
        setTimeout(() => btnConfirm.focus(), 50);
      }
    }

    _confirmApplyProject() {
      if (!this.pendingApplyProject) return;
      const { project, period } = this.pendingApplyProject;
      this._closeConfirmApplyProjectModal();
      this._applyProjectToCurrentMap(project.id, period);
    }

    _closeConfirmApplyProjectModal() {
      const modal = document.getElementById('confirm-apply-project-modal');
      if (modal) {
        modal.classList.add('hidden');
      }
      this.pendingApplyProject = null;
    }

    // One short line per difference between the Current Map and a draft, e.g. "Added Bus 12", "Moved stop Opp Blk 511"
    _computeProjectChanges(baseDoc, projDoc) {
      const changes = [];
      const add = (action, text) => changes.push({ action, text });
      const base = baseDoc || {};
      const proj = projDoc || {};
      const stopCount = (r) => (r.anchors || []).filter((a) => a.t === 'stop').length;
      const roadName = (id) => {
        const e = this.net && this.net.edge(id);
        return (e && e.name) || `road ${id}`;
      };

      // 1. Bus Routes
      const baseRoutes = base.routes || {};
      const projRoutes = proj.routes || {};
      for (const [id, r] of Object.entries(projRoutes)) {
        const b = baseRoutes[id];
        if (!b) {
          const baseR = (r.kind === 'proposed' && r.baseId) ? baseRoutes[r.baseId] : null;
          if (baseR) add('mod', `Detour for Bus ${r.number || baseR.number}`);
          else add('add', `Added Bus ${r.number}`);
        } else if (JSON.stringify(b) !== JSON.stringify(r)) {
          const bStops = stopCount(b);
          const pStops = stopCount(r);
          const bHours = B.busHours(base, r.number);
          const pHours = B.busHours(proj, r.number);
          const bModel = B.busModel(base, r.number);
          const pModel = B.busModel(proj, r.number);
          const bDays = B.busDays(base, r.number).join();
          const pDays = B.busDays(proj, r.number);
          const bActive = B.busActive(base, r.number);
          const pActive = B.busActive(proj, r.number);
          const bFleet = B.busFleetSet(base, r.number);
          const pFleet = B.busFleetSet(proj, r.number);
          if (bActive !== pActive) add('mod', `Bus ${r.number}: ${pActive ? 'active' : 'not active'}`);
          else if (pFleet && bFleet !== pFleet) add('mod', `Bus ${r.number}: ${pFleet} bus${pFleet === 1 ? '' : 'es'}`);
          else if (bModel !== pModel) add('mod', `Bus ${r.number}: now ${pModel}`);
          else if (bHours.start !== pHours.start || bHours.end !== pHours.end) add('mod', `Bus ${r.number}: ${pHours.start} – ${pHours.end}`);
          else if (bDays !== pDays.join()) add('mod', `Bus ${r.number}: ${B.daysLabel(pDays)}`);
          else if (bStops !== pStops) add('mod', `Bus ${r.number}: ${bStops} → ${pStops} stops`);
          else if (JSON.stringify(b.anchors) !== JSON.stringify(r.anchors)) add('mod', `Bus ${r.number}: new path`);
          else if (b.name !== r.name) add('mod', `Renamed Bus ${r.number}`);
          else add('mod', `Updated Bus ${r.number}`);
        }
      }
      for (const [id, r] of Object.entries(baseRoutes)) {
        if (!projRoutes[id] && !Object.values(projRoutes).some((pr) => pr.baseId === id)) {
          add('del', `Removed Bus ${r.number}`);
        }
      }

      // 2. Bus Stops
      const baseStops = base.stops || {};
      const projStops = proj.stops || {};
      for (const [id, st] of Object.entries(projStops)) {
        const b = baseStops[id];
        const name = st.name || `Stop ${id}`;
        if (!b) add('add', `Added stop ${name}`);
        else if (b.name !== st.name) add('mod', `Renamed stop ${b.name || id} → ${name}`);
        else if ((b.active !== false) !== (st.active !== false)) add('mod', `Stop ${name}: ${st.active === false ? 'not active' : 'active'}`);
        else if (b.edge !== st.edge || Math.abs((b.s || 0) - (st.s || 0)) > 1) add('mod', `Moved stop ${name}`);
        else if (b.code !== st.code) add('mod', `Updated stop ${name}`);
      }
      for (const [id, st] of Object.entries(baseStops)) {
        if (!projStops[id]) add('del', `Removed stop ${st.name || id}`);
      }

      // 3. Road Closures
      const baseClosures = base.closures || {};
      const projClosures = proj.closures || {};
      for (const id of Object.keys(projClosures)) {
        if (!baseClosures[id]) add('close', `Closed ${roadName(id)}`);
      }
      for (const id of Object.keys(baseClosures)) {
        if (!projClosures[id]) add('reopen', `Reopened ${roadName(id)}`);
      }

      // 4. Incident / Disruption Areas
      const baseAreas = base.areas || {};
      const projAreas = proj.areas || {};
      for (const [id, ar] of Object.entries(projAreas)) {
        const b = baseAreas[id];
        const name = ar.name || 'a disruption area';
        if (!b) add('add', `Added ${name}`);
        else if (Math.hypot((b.cx || 0) - (ar.cx || 0), (b.cy || 0) - (ar.cy || 0)) > 5 || Math.abs((b.r || 0) - (ar.r || 0)) > 5 || b.name !== ar.name) {
          add('mod', `Updated ${name}`);
        }
      }
      for (const [id, ar] of Object.entries(baseAreas)) {
        if (!projAreas[id]) add('del', `Removed ${ar.name || 'a disruption area'}`);
      }

      return changes;
    }

    // ------------------------------------------------------------- Apply to Current Map (straight from the project card)
    _applyFromDrawer(p) {
      const period = this._readProjectPeriod(p);
      if (period.error) {
        if (this._showToast) this._showToast(B.esc(period.error), 'warn');
        return;
      }
      const doc = (this.activeProjectId === p.id) ? this.store.doc : this._loadProjectDraft(p.id);
      if (!this._checkBusesConnected(doc, 'apply')) return;
      if (this.activeProjectId === p.id) {
        this._saveCurrentProjectDraft(false);
      }
      this._promptApplyProject(p, period);
    }

    // ------------------------------------------------------------- Effective Period (chosen in each project's drawer)
    _defaultApplyPeriod() {
      const start = new Date();
      start.setSeconds(0, 0);
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      const pad = (n) => String(n).padStart(2, '0');
      const toDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const toTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      return {
        mode: 'scheduled',
        startDate: toDate(start),
        startTime: toTime(start),
        endDate: toDate(end),
        endTime: toTime(end)
      };
    }

    _setProjectPeriodMode(p, mode) {
      const current = p.applyPeriod || {};
      if (mode === 'scheduled') {
        // Start from now → +1 day unless the project still has a usable range from before
        const endTs = (current.endDate && current.endTime) ? new Date(`${current.endDate}T${current.endTime}`).getTime() : NaN;
        p.applyPeriod = (isNaN(endTs) || endTs <= Date.now())
          ? this._defaultApplyPeriod()
          : Object.assign({}, current, { mode: 'scheduled' });
      } else {
        p.applyPeriod = Object.assign({}, current, { mode: 'permanent' });
      }
      this._markProjectInProgress(p.id);
      this._saveProjects();
      this._renderProjects();
    }

    // Permanent stays as picked; a Temporary range that has already ended no longer counts
    _hasUsablePeriod(p) {
      const period = p && p.applyPeriod;
      if (!period || !period.mode) return false;
      if (period.mode !== 'scheduled') return true;
      const endTs = (period.endDate && period.endTime) ? new Date(`${period.endDate}T${period.endTime}`).getTime() : NaN;
      return !isNaN(endTs) && endTs > Date.now();
    }

    _readProjectPeriod(p) {
      const period = (p && p.applyPeriod) || this._defaultApplyPeriod();
      if (period.mode !== 'scheduled') return { mode: 'permanent' };

      const toTs = (date, time) => (date && time ? new Date(`${date}T${time}`).getTime() : NaN);
      const start = toTs(period.startDate, period.startTime);
      const end = toTs(period.endDate, period.endTime);
      const now = Date.now();

      let error = null;
      let field = null;
      if (isNaN(start)) {
        error = 'Pick a start date and time.';
        field = 'start';
      } else if (isNaN(end)) {
        error = 'Pick an end date and time.';
        field = 'end';
      } else if (end <= start) {
        error = 'End must be after the start.';
        field = 'end';
      } else if (end <= now) {
        error = 'That end time has already passed.';
        field = 'end';
      } else {
        // A project can't overlap its own schedule; changes from differently named projects may overlap.
        // The very range it's already scheduled for is that schedule, not a clash.
        const effStart = Math.max(start, now);
        const name = String(p.name).trim();
        const clash = (this.scheduledChanges || []).find((sc) => String(sc.projectName).trim() === name && effStart < sc.end && sc.start < end
          && !(sc.projectId === p.id && sc.start === start && sc.end === end));
        if (clash) {
          error = `Overlaps "${clash.projectName}" (${this._formatPeriodTime(clash.start)} – ${this._formatPeriodTime(clash.end)}).`;
          field = 'both';
        }
      }

      return { mode: 'scheduled', start, end, error, field };
    }

    _periodApplyLabel(period) {
      if (period.mode === 'permanent') return 'Apply to Current Map';
      return (!period.error && period.start <= Date.now()) ? 'Apply Now' : 'Schedule Change';
    }

    _buildProjectPeriod(p) {
      // Projects start on Temporary (now → +1 day); a range that has already ended starts fresh, except on a project
      // that went live or is archived, where the period is what happened
      const done = p.status === 'archive' || p.status === 'go_live';
      if (!p.applyPeriod || (!done && !this._hasUsablePeriod(p))) p.applyPeriod = this._defaultApplyPeriod();
      const period = p.applyPeriod;
      const isRange = period.mode === 'scheduled';
      // An archived project's period is what happened: shown in grey, not changed
      const archived = p.status === 'archive';

      const box = document.createElement('div');
      box.className = `project-period${archived ? ' is-archived' : ''}`;

      const head = document.createElement('div');
      head.className = 'project-period-head';
      head.innerHTML = `<span class="project-period-title">Effective period</span>`;

      const toggle = document.createElement('div');
      toggle.className = 'project-period-toggle';
      toggle.setAttribute('role', 'radiogroup');
      toggle.setAttribute('aria-label', `Effective period for ${p.name}`);
      for (const [mode, label] of [['scheduled', 'Temporary'], ['permanent', 'Permanent']]) {
        const isOn = (mode === 'scheduled') === isRange;
        const opt = document.createElement('button');
        opt.type = 'button';
        opt.className = `project-period-opt ${isOn ? 'active' : ''}`;
        opt.setAttribute('role', 'radio');
        opt.setAttribute('aria-checked', isOn ? 'true' : 'false');
        opt.textContent = label;
        opt.disabled = archived;
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!isOn) this._setProjectPeriodMode(p, mode);
        });
        toggle.appendChild(opt);
      }
      head.appendChild(toggle);
      box.appendChild(head);

      if (!isRange) return box;

      // From / Until rows, each with a date picker and a time picker
      const range = document.createElement('div');
      range.className = 'project-period-range';
      for (const [key, label] of [['start', 'From'], ['end', 'Until']]) {
        const row = document.createElement('div');
        row.className = 'project-period-row';
        const dateId = `period-${p.id}-${key}-date`;
        row.innerHTML = `<label class="project-period-label" for="${dateId}">${label}</label>`;

        for (const part of ['date', 'time']) {
          const field = key + (part === 'date' ? 'Date' : 'Time');
          const input = document.createElement('input');
          input.type = part;
          input.className = `project-period-input project-period-${part}`;
          input.dataset.field = field;
          if (part === 'date') input.id = dateId;
          input.value = period[field] || '';
          input.disabled = archived;
          input.setAttribute('aria-label', `${label} ${part}`);
          const onEdit = () => {
            p.applyPeriod = Object.assign({}, p.applyPeriod, { [field]: input.value });
            this._markProjectInProgress(p.id);
            this._saveProjects();
            this._updateProjectPeriodUI(p, box.parentNode);
          };
          input.addEventListener('input', onEdit);
          input.addEventListener('change', onEdit);
          input.addEventListener('click', (e) => e.stopPropagation());
          row.appendChild(input);
        }
        range.appendChild(row);
      }

      const summary = document.createElement('div');
      summary.className = 'project-period-summary';
      summary.setAttribute('aria-live', 'polite');
      range.appendChild(summary);

      box.appendChild(range);
      return box;
    }

    _updateProjectPeriodUI(p, drawer) {
      if (!drawer) return;
      if (p && p.id === this.activeProjectId) this._syncForeignObstacles();
      const period = this._readProjectPeriod(p);
      // An archived period has ended on purpose: no error, and nothing to apply
      const archived = p && p.status === 'archive';
      if (archived) period.error = 'Archived';

      const err = period.error && !archived ? period.field : null;
      drawer.querySelectorAll('.project-period-input').forEach((input) => {
        const isStart = (input.dataset.field || '').startsWith('start');
        input.classList.toggle('invalid', err === 'both' || err === (isStart ? 'start' : 'end'));
      });

      const summary = drawer.querySelector('.project-period-summary');
      if (summary && archived) {
        summary.classList.remove('error');
        summary.textContent = '';
      } else if (summary && period.mode === 'scheduled') {
        const now = Date.now();
        summary.classList.toggle('error', !!period.error);
        if (period.error) {
          summary.textContent = period.error;
        } else if (period.start <= now) {
          // Measure from the current minute so a default 24h range reads "1 day", not "23 hr 59 min"
          summary.textContent = `Starts now · lasts ${this._formatDuration(period.end - Math.floor(now / 60000) * 60000)}`;
        } else {
          summary.textContent = `Starts in ${this._formatDuration(period.start - now)} · lasts ${this._formatDuration(period.end - period.start)}`;
        }
      }

      const btnApply = drawer.querySelector('.btn-drawer-apply');
      if (btnApply) {
        btnApply.innerHTML = `<span>${this._periodApplyLabel(period)}</span>`;
        btnApply.disabled = !!period.error;
        btnApply.title = period.error
          ? period.error
          : (period.mode === 'permanent'
            ? `Apply ${p.name} to Current Map permanently`
            : `Apply ${p.name} to Current Map from ${this._formatPeriodTime(Math.max(period.start, Date.now()))} until ${this._formatPeriodTime(period.end)}`);
      }
    }

    _formatPeriodTime(ts) {
      const d = new Date(ts);
      const opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
      if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
      return d.toLocaleString([], opts);
    }

    _formatDuration(ms) {
      const totalMin = Math.max(1, Math.round(ms / 60000));
      const days = Math.floor(totalMin / 1440);
      const hours = Math.floor((totalMin % 1440) / 60);
      const mins = totalMin % 60;
      const parts = [];
      if (days) parts.push(`${days} day${days > 1 ? 's' : ''}`);
      if (hours) parts.push(`${hours} hr`);
      if (mins && !days) parts.push(`${mins} min`);
      return parts.slice(0, 2).join(' ');
    }

    // ------------------------------------------------------------- Scheduled (date-range) Changes to Current Map
    // Each scheduled change keeps only what its project changes (a patch). While any change is live, the
    // permanent map is kept in `scheduledBase` and the Current Map = base + every live patch, so changes
    // from different projects can overlap and each one ends cleanly.
    _initScheduledChanges() {
      this.scheduledChanges = [];
      this.scheduledBase = null;
      try {
        const raw = localStorage.getItem('brass_scheduled_changes');
        const parsed = raw ? JSON.parse(raw) : null;
        if (Array.isArray(parsed)) this.scheduledChanges = parsed;
        const rawBase = localStorage.getItem('brass_scheduled_base');
        if (rawBase) this.scheduledBase = JSON.parse(rawBase);
      } catch (e) {}

      // Older entries stored a whole copy of the map; convert them to patches
      let migrated = false;
      for (const sc of this.scheduledChanges) {
        if (sc.patch || !sc.doc) continue;
        if (sc.status === 'active' && sc.baseDoc && !this.scheduledBase) this.scheduledBase = sc.baseDoc;
        const reference = (sc.status === 'active' && sc.baseDoc) || this.scheduledBase || this._loadProjectDraft('main');
        sc.patch = this._diffDocs(reference, sc.doc);
        delete sc.doc;
        delete sc.baseDoc;
        migrated = true;
      }
      if (migrated) this._saveScheduledChanges();
      this._backfillMapVersions();

      // Catch up on periods that started or ended while the app was closed
      this._processScheduledChanges(true);

      this._scheduleTimer = setInterval(() => this._processScheduledChanges(), 2000);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) this._processScheduledChanges();
      });
    }

    _saveScheduledChanges() {
      if (this.renderer) this._syncForeignObstacles();
      try {
        localStorage.setItem('brass_scheduled_changes', JSON.stringify(this.scheduledChanges));
        if (this.scheduledBase) {
          localStorage.setItem('brass_scheduled_base', JSON.stringify(this.scheduledBase));
        } else {
          localStorage.removeItem('brass_scheduled_base');
        }
      } catch (e) {
        console.warn('Failed to save scheduled changes', e);
      }
    }

    _writeCurrentMapDoc(doc, label) {
      const docStr = JSON.stringify(doc);
      try {
        localStorage.setItem('brass_proj_doc_main', docStr);
        localStorage.setItem(this.store.KEY, docStr);
      } catch (e) {
        console.warn('Failed to save to Current Map', e);
      }

      if (this.activeProjectId === 'main' && !this.reviewMode) {
        this.store.loadDoc(JSON.parse(docStr), { label });
        this._lastSavedDoc = JSON.stringify(this.store.doc);
        this._updateSaveButton();
        this.renderer.requestRender();
      }
      // The counts describe the Current Map, so they change with it even while a draft is open
      this._renderCurrentMapStats();
    }

    // Patch of what `target` changes relative to `base`. Entries where `target` matches `inherited`
    // (the map the user sees, including live changes) came from those changes, not from this project.
    _diffDocs(base, target, inherited = null) {
      const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const patch = {};
      for (const key of new Set([...Object.keys(base || {}), ...Object.keys(target || {})])) {
        const b = base ? base[key] : undefined;
        const t = target ? target[key] : undefined;
        const inh = inherited ? inherited[key] : undefined;
        if (isMap(b) || isMap(t)) {
          const bm = isMap(b) ? b : {};
          const tm = isMap(t) ? t : {};
          const im = isMap(inh) ? inh : {};
          const set = {};
          const del = [];
          for (const id of Object.keys(tm)) {
            if (!same(tm[id], bm[id]) && !(inherited && same(tm[id], im[id]))) set[id] = tm[id];
          }
          for (const id of Object.keys(bm)) {
            if (!(id in tm) && !(inherited && !(id in im))) del.push(id);
          }
          if (Object.keys(set).length || del.length) patch[key] = { set, del };
        } else if (t !== undefined && !same(b, t) && !(inherited && same(t, inh))) {
          patch[key] = { value: t };
        }
      }
      return patch;
    }

    _applyDocPatch(doc, patch) {
      for (const [key, p] of Object.entries(patch || {})) {
        if ('value' in p) {
          // The id counter only moves forward, so ids from every live change stay unique
          doc[key] = (key === 'seq' && typeof doc.seq === 'number' && typeof p.value === 'number')
            ? Math.max(doc.seq, p.value)
            : JSON.parse(JSON.stringify(p.value));
          continue;
        }
        if (!p.set && !p.del) continue;
        doc[key] = doc[key] || {};
        for (const [id, val] of Object.entries(p.set || {})) doc[key][id] = JSON.parse(JSON.stringify(val));
        for (const id of p.del || []) delete doc[key][id];
      }
      return doc;
    }

    // Live changes in the order they apply: earliest start first, so a later one wins where both touch the same item
    _liveScheduledChanges() {
      return (this.scheduledChanges || [])
        .filter((sc) => sc.status === 'active')
        .sort((a, b) => (a.start - b.start) || (a.createdAt - b.createdAt));
    }

    _composeCurrentMap(live) {
      const doc = JSON.parse(JSON.stringify(this.scheduledBase));
      for (const sc of live) this._applyDocPatch(doc, sc.patch);
      return doc;
    }

    // Rebuild the Current Map after the set of live changes moved from `prevLive` to the current one
    _rebuildCurrentMap(prevLive, label) {
      const live = this._liveScheduledChanges();
      if (!this.scheduledBase && !live.length) return;

      const currentDoc = (this.activeProjectId === 'main') ? this.store.doc : this._loadProjectDraft('main');
      if (this.scheduledBase) {
        // Keep edits made directly on the Current Map while changes were live
        const edits = this._diffDocs(this._composeCurrentMap(prevLive), currentDoc);
        this._applyDocPatch(this.scheduledBase, edits);
      } else {
        this.scheduledBase = JSON.parse(JSON.stringify(currentDoc));
      }

      const next = this._composeCurrentMap(live);
      if (!live.length) this.scheduledBase = null;
      this._writeCurrentMapDoc(next, label);
    }

    _processScheduledChanges(isInit = false) {
      if (!this.scheduledChanges) return;

      const now = Date.now();
      const prevLive = this._liveScheduledChanges();
      const notices = [];
      let changed = false;

      // 1. Drop finished periods
      for (const sc of this.scheduledChanges.filter((item) => now >= item.end)) {
        this._setMapVersionStatus(sc.id, 'ended');
        if (sc.status === 'active') {
          notices.push([`"${B.esc(sc.projectName)}" ended`, 'info']);
        }
        changed = true;
      }
      this.scheduledChanges = this.scheduledChanges.filter((item) => now < item.end);

      // 2. Start periods whose start time has arrived
      for (const sc of this.scheduledChanges) {
        if (sc.status === 'active' || now < sc.start) continue;
        sc.status = 'active';
        notices.push([`"${B.esc(sc.projectName)}" live until ${B.esc(this._formatShortTime(sc.end))}`, 'success']);
        changed = true;
      }

      // A kept base with nothing live (e.g. after an interrupted session) means the map should go back to it
      if (!changed && !(this.scheduledBase && !prevLive.length)) return;

      this._rebuildCurrentMap(prevLive, 'Update date-range changes');
      this._saveScheduledChanges();
      if (!isInit) this._renderProjects();
      if (this._showToast) notices.forEach(([msg, type]) => this._showToast(msg, type));
    }

    _cancelScheduledChange(id) {
      const sc = (this.scheduledChanges || []).find((item) => item.id === id);
      if (!sc) return;

      const wasActive = sc.status === 'active';
      const prevLive = this._liveScheduledChanges();
      this.scheduledChanges = this.scheduledChanges.filter((item) => item.id !== id);
      this._setMapVersionStatus(id, wasActive ? 'ended-early' : 'cancelled');
      if (wasActive) {
        this._rebuildCurrentMap(prevLive, `End ${sc.projectName} period early`);
      }
      this._saveScheduledChanges();
      this._renderProjects();

      if (this._showToast) {
        this._showToast(wasActive
          ? `Ended "${B.esc(sc.projectName)}"`
          : `Cancelled "${B.esc(sc.projectName)}"`, 'info');
      }
    }

    // ------------------------------------------------------------- Distinct Bus Colours
    // Every bus number keeps one colour of its own, the same in every stored map: Current Map, project
    // drafts, date-range changes and version snapshots. Runs on load; does nothing once colours are distinct.
    // Every stored copy of a map (Current Map, project drafts, date-range base, version snapshots) with just its buses,
    // plus the date-range changes. A map is read whole only when it has to change.
    _storedMaps() {
      const read = (key) => {
        try {
          const raw = localStorage.getItem(key);
          return raw ? JSON.parse(raw) : null;
        } catch (e) {
          return null;
        }
      };

      const keys = ['brass_proj_doc_main', this.store.KEY, 'brass_scheduled_base'];
      (read('brass_projects_list') || []).forEach((p) => { if (p && p.id) keys.push('brass_proj_doc_' + p.id); });
      Object.keys(localStorage).filter((k) => k.startsWith('brass_map_snapshot_')).forEach((k) => keys.push(k));
      return {
        maps: [...new Set(keys)].map((key) => ({ key, routes: B.storedPart(key, 'routes') })).filter((m) => m.routes),
        read,
        schedules: read('brass_scheduled_changes') || [],
        scheduledRoutes: (sc) => (sc.patch && sc.patch.routes && sc.patch.routes.set) || {}
      };
    }

    // Bus pieces left with fewer than two stops by older stop deletions can't be drawn or selected: remove them everywhere
    _removeEmptyRoutes() {
      const { maps, read, schedules, scheduledRoutes } = this._storedMaps();
      const empty = (r) => !(r.planned && !(r.anchors || []).length) && (!r.anchors || r.anchors.length < 2);
      try {
        for (const { key, routes } of maps) {
          if (!Object.values(routes).some(empty)) continue;
          const doc = read(key);
          if (doc && B.ops.pruneEmptyRoutes(doc).length) localStorage.setItem(key, JSON.stringify(doc));
        }
        let schedulesChanged = false;
        for (const sc of schedules) {
          const set = scheduledRoutes(sc);
          for (const [id, r] of Object.entries(set)) {
            if (r.planned && !(r.anchors || []).length) continue;
            if (!r.anchors || r.anchors.length < 2) {
              delete set[id];
              schedulesChanged = true;
            }
          }
        }
        if (schedulesChanged) localStorage.setItem('brass_scheduled_changes', JSON.stringify(schedules));
      } catch (e) {
        console.warn('Could not remove empty bus pieces', e);
      }
    }

    _separateBusColors() {
      const { maps, read, schedules, scheduledRoutes } = this._storedMaps();
      const routeLists = [
        ...maps.map((m) => Object.values(m.routes)),
        ...schedules.map((sc) => Object.values(scheduledRoutes(sc)))
      ];

      // First colour seen for each bus number; the Current Map comes first, so the original buses keep theirs
      const colorOf = new Map();
      for (const list of routeLists) {
        for (const r of list) {
          const num = String(r.number).trim();
          if (r.color && !colorOf.has(num)) colorOf.set(num, r.color);
        }
      }

      // A colour already used by an earlier bus number moves to a colour nobody uses
      const taken = [];
      for (const [num, color] of colorOf) {
        if (taken.includes(color)) colorOf.set(num, B.pickRouteColor([...taken, ...colorOf.values()]));
        taken.push(colorOf.get(num));
      }

      const recolor = (routes) => {
        let changed = false;
        for (const r of Object.values(routes)) {
          const want = colorOf.get(String(r.number).trim());
          if (want && r.color !== want) {
            r.color = want;
            changed = true;
          }
        }
        return changed;
      };
      try {
        for (const { key, routes } of maps) {
          if (!Object.values(routes).some((r) => { const want = colorOf.get(String(r.number).trim()); return want && r.color !== want; })) continue;
          const doc = read(key);
          if (doc && recolor(doc.routes)) localStorage.setItem(key, JSON.stringify(doc));
        }
        if (schedules.map((sc) => recolor(scheduledRoutes(sc))).some(Boolean)) {
          localStorage.setItem('brass_scheduled_changes', JSON.stringify(schedules));
        }
      } catch (e) {
        console.warn('Could not update bus colours', e);
      }
    }

    // ------------------------------------------------------------- Current Map Version History
    // Every project applied to the Current Map (permanent or temporary) is kept as a numbered version.
    _initMapVersions() {
      this.mapVersions = [];
      this.historyOpen = false;
      this.historyTab = 'temporary'; // 'temporary' (date ranges applying now or later) or 'permanent'
      try {
        const raw = localStorage.getItem('brass_map_versions');
        const parsed = raw ? JSON.parse(raw) : null;
        if (Array.isArray(parsed)) this.mapVersions = parsed;
      } catch (e) {}
      // Entries a deleted project left behind before deleting took them along
      this._dropMapVersions((v) => v.status === 'deleted' || v.type === 'removed' || (v.type === 'permanent' && v.undone));
    }

    _saveMapVersions() {
      try {
        localStorage.setItem('brass_map_versions', JSON.stringify(this.mapVersions));
      } catch (e) {
        console.warn('Failed to save map versions', e);
      }
    }

    _recordMapVersion(entry, save = true, snapshot = null) {
      const next = this.mapVersions.reduce((max, v) => Math.max(max, v.version || 0), 0) + 1;
      const version = Object.assign({ id: `ver-${Date.now()}-${next}`, version: next, appliedAt: Date.now(), status: null }, entry);
      if (snapshot) version.hasSnapshot = this._saveMapSnapshot(version.id, snapshot);
      this.mapVersions.push(version);
      if (this.mapVersions.length > 200) {
        this.mapVersions.slice(0, this.mapVersions.length - 200).forEach((old) => this._dropMapSnapshot(old));
        this.mapVersions = this.mapVersions.slice(-200);
      }
      if (save) this._saveMapVersions();
      return version;
    }

    // ------------------------------------------------------------- Version snapshots & Restore
    // Permanent versions keep a copy of the permanent map (never including live date-range changes),
    // for the newest MAX_SNAPSHOTS versions plus the starting point, so they can be restored.
    _isBaselineVersion(v) {
      return v.type !== 'temporary';
    }

    _saveMapSnapshot(versionId, doc) {
      const MAX_SNAPSHOTS = 15;
      const str = JSON.stringify(doc);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          localStorage.setItem('brass_map_snapshot_' + versionId, str);
          // Keep only the newest snapshots (the starting point always stays)
          this.mapVersions
            .filter((v) => v.hasSnapshot && v.type !== 'start')
            .sort((a, b) => (b.version || 0) - (a.version || 0))
            .slice(MAX_SNAPSHOTS - 1)
            .forEach((v) => this._dropMapSnapshot(v));
          return true;
        } catch (e) {
          // Storage full: drop the oldest snapshot and try once more
          const oldest = this.mapVersions
            .filter((v) => v.hasSnapshot && v.type !== 'start')
            .sort((a, b) => (a.version || 0) - (b.version || 0))[0];
          if (!oldest) break;
          this._dropMapSnapshot(oldest);
        }
      }
      console.warn('Could not save a snapshot for this version; it cannot be restored.');
      return false;
    }

    // A temporary version's project map (what the project looked like when applied), for its review link.
    // Only the newest ones are kept.
    _saveProjectMap(versionId, doc) {
      const MAX_MAPS = 15;
      try {
        localStorage.setItem('brass_project_map_' + versionId, JSON.stringify(doc));
      } catch (e) {
        return false;
      }
      this.mapVersions
        .filter((v) => v.hasProjectMap && v.id !== versionId)
        .sort((a, b) => (b.version || 0) - (a.version || 0))
        .slice(MAX_MAPS - 1)
        .forEach((v) => {
          try { localStorage.removeItem('brass_project_map_' + v.id); } catch (e) {}
          v.hasProjectMap = false;
        });
      return true;
    }

    // The map an Applied Project item stands for, or null when it wasn't kept
    _versionProjectMap(v) {
      const read = (key) => {
        try {
          const raw = localStorage.getItem(key);
          return raw ? JSON.parse(raw) : null;
        } catch (e) {
          return null;
        }
      };
      if (v.hasProjectMap) {
        const doc = read('brass_project_map_' + v.id);
        if (doc) return doc;
      }
      if (v.type !== 'temporary') return this._loadMapSnapshot(v);
      // Live or scheduled: the map before it plus its changes
      const sc = (this.scheduledChanges || []).find((item) => item.id === v.scheduleId);
      if (sc && sc.patch) {
        const base = this.scheduledBase || (this.activeProjectId === 'main' ? this.store.doc : this._loadProjectDraft('main'));
        const doc = JSON.parse(JSON.stringify(base));
        this._applyDocPatch(doc, sc.patch);
        return doc;
      }
      // Ended before maps were kept: the project's draft, if it's still around
      return v.projectId ? read('brass_proj_doc_' + v.projectId) : null;
    }

    // The map an Applied Project item went onto: the permanent map for a date range, else the version before it
    _versionBaseMap(v) {
      if (v.type === 'temporary') return this._currentPermanentMap();
      const prev = this.mapVersions
        .filter((x) => this._isBaselineVersion(x) && (x.version || 0) < (v.version || 0))
        .reduce((a, b) => (!a || (b.version || 0) > (a.version || 0) ? b : a), null);
      return this._loadMapSnapshot(prev);
    }

    // Copies the item's map as a review link, like a project's share link
    async _copyVersionReview(v, name) {
      const doc = this._versionProjectMap(v);
      if (!doc) return;
      try {
        const data = await this._encodeShare({ name, doc, base: this._versionBaseMap(v) });
        await this._copyText(`${location.origin}${location.pathname}#review=${data}`);
        this._showToast('Review link copied', 'success');
      } catch (e) {
        console.warn('Could not make a review link', e);
        this._showToast("Couldn't copy the link", 'warn');
      }
    }

    _dropMapSnapshot(v) {
      try {
        localStorage.removeItem('brass_map_snapshot_' + v.id);
        localStorage.removeItem('brass_map_before_' + v.id); // kept by an earlier version of the app
      } catch (e) {}
      v.hasSnapshot = false;
    }

    _loadMapSnapshot(v) {
      if (!v || !v.hasSnapshot) return null;
      try {
        const raw = localStorage.getItem('brass_map_snapshot_' + v.id);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    }

    _latestBaselineVersion() {
      return this.mapVersions
        .filter((v) => this._isBaselineVersion(v))
        .reduce((a, b) => (!a || (b.version || 0) > (a.version || 0) ? b : a), null);
    }

    // The permanent map right now: base under any live date-range changes, plus edits made on the Current Map
    _currentPermanentMap() {
      const shown = (this.activeProjectId === 'main') ? this.store.doc : this._loadProjectDraft('main');
      if (!this.scheduledBase) return JSON.parse(JSON.stringify(shown));
      const base = JSON.parse(JSON.stringify(this.scheduledBase));
      this._applyDocPatch(base, this._diffDocs(this._composeCurrentMap(this._liveScheduledChanges()), shown));
      return base;
    }

    // Before the first permanent change, keep the map as it was so it can always be restored
    _ensureStartVersion() {
      if (this.mapVersions.some((v) => v.type === 'start')) return;
      this._recordMapVersion({ type: 'start', version: 0, projectName: 'Starting point' }, true, this._currentPermanentMap());
    }

    _restoreMapVersion(versionId) {
      const v = this.mapVersions.find((item) => item.id === versionId);
      const snapshot = this._loadMapSnapshot(v);
      if (!v || !snapshot) {
        if (this._showToast) this._showToast("This version can't be restored", 'warn');
        return;
      }

      // Edits made on the Current Map since its latest version are saved first, so restoring never loses them
      const current = this._currentPermanentMap();
      const latestSnap = this._loadMapSnapshot(this._latestBaselineVersion());
      if (!latestSnap || JSON.stringify(latestSnap) !== JSON.stringify(current)) {
        this._recordMapVersion({ type: 'edits', projectName: 'Direct edits' }, true, current);
      }

      // Live date-range changes keep running on top of the restored map
      const name = this._mapVersionName(v);
      if (this.scheduledBase) {
        this.scheduledBase = JSON.parse(JSON.stringify(snapshot));
        this._saveScheduledChanges();
        this._writeCurrentMapDoc(this._composeCurrentMap(this._liveScheduledChanges()), `Restore ${name}`);
      } else {
        this._writeCurrentMapDoc(snapshot, `Restore ${name}`);
      }

      this._recordMapVersion({ type: 'restore', restoredFrom: v.version, projectId: v.projectId, projectName: v.projectName }, true, snapshot);
      this._renderProjects();
      if (this._showToast) {
        this._showToast(`Restored "${B.esc(name)}"`, 'success');
      }
    }

    // Date-range changes scheduled before the history existed still get an entry
    _backfillMapVersions() {
      const missing = (this.scheduledChanges || [])
        .filter((sc) => !this.mapVersions.some((v) => v.scheduleId === sc.id))
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      for (const sc of missing) {
        this._recordMapVersion({
          type: 'temporary',
          scheduleId: sc.id,
          projectId: sc.projectId,
          projectName: sc.projectName,
          start: sc.start,
          end: sc.end,
          appliedAt: sc.createdAt || Date.now()
        }, false);
      }
      if (missing.length) this._saveMapVersions();
    }

    _setMapVersionStatus(scheduleId, status) {
      const v = this.mapVersions.find((item) => item.scheduleId === scheduleId);
      if (!v || v.status) return;
      v.status = status;
      v.endedAt = Date.now();
      this._saveMapVersions();
    }

    // Row times stay short: just the time when it is today
    _formatShortTime(ts) {
      const d = new Date(ts);
      if (d.toDateString() === new Date().toDateString()) {
        return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      }
      return this._formatPeriodTime(ts);
    }

    _mapVersionName(v) {
      if (v.type === 'start') return 'Starting point';
      if (v.type === 'edits') return 'Direct edits';
      return v.projectName || 'Project';
    }

    // { label, tone, detail, range, schedule, canRestore } for one version row
    _mapVersionState(v) {
      if (this._isBaselineVersion(v)) {
        const latest = this._latestBaselineVersion();
        const isCurrent = !!latest && latest.id === v.id;
        const when = this._formatShortTime(v.appliedAt);
        const kinds = {
          restore: 'Restored',
          edits: 'Saved before a restore'
        };
        return {
          label: isCurrent ? 'Current' : 'Replaced',
          tone: isCurrent ? 'current' : 'past',
          detail: kinds[v.type] ? `${kinds[v.type]} · ${when}` : when,
          canRestore: !isCurrent && !!v.hasSnapshot
        };
      }

      // Same-day ranges only repeat the time: "Oct 30, 12:15 PM – 5:15 PM"
      const sameDay = new Date(v.start).toDateString() === new Date(v.end).toDateString();
      const endText = sameDay
        ? new Date(v.end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : this._formatPeriodTime(v.end);
      const range = `${this._formatPeriodTime(v.start)} – ${endText}`;
      const schedule = (this.scheduledChanges || []).find((sc) => sc.id === v.scheduleId);
      const finished = { ended: 'Ended', 'ended-early': 'Ended early', cancelled: 'Cancelled', replaced: 'Replaced' };
      // Finished ones stay listed as offline, from when they came off the map
      const offlineState = (label, at) => ({ label, tone: 'past', offline: true, offlineAt: at, detail: `Offline since ${this._formatShortTime(at)}`, range });
      if (v.status && finished[v.status]) {
        return offlineState(finished[v.status], v.status === 'ended' ? v.end : (v.endedAt || v.end));
      }
      if (schedule) {
        const isLive = schedule.status === 'active';
        return {
          label: isLive ? 'Live' : 'Scheduled',
          tone: isLive ? 'live' : 'scheduled',
          detail: isLive ? `Live until ${this._formatShortTime(v.end)}` : `Starts ${this._formatShortTime(v.start)}`,
          range,
          schedule
        };
      }
      return offlineState(v.end <= Date.now() ? 'Ended' : 'Cancelled', v.endedAt || Math.min(v.end, Date.now()));
    }

    // One line per version: a live/scheduled dot for date ranges, name · detail, then its action
    _buildMapVersionRow(v) {
      const state = this._mapVersionState(v);
      const name = this._mapVersionName(v);
      const row = document.createElement('div');
      row.className = `map-version-item tone-${state.tone}`;
      row.title = `${name} · ${state.label}\n${state.range || state.detail}`;
      const marker = (state.schedule || state.offline) ? `<span class="map-version-dot" aria-label="${B.esc(state.offline ? 'Offline' : state.label)}"></span>` : '';
      row.innerHTML = `
        ${marker}
        <span class="map-version-text"><span class="map-version-name">${B.esc(name)}</span><span class="map-version-detail"> · ${B.esc(state.detail)}</span></span>
      `;

      // Its map, as a review link
      if (this._versionProjectMap(v)) {
        const btnLink = document.createElement('button');
        btnLink.type = 'button';
        btnLink.className = 'btn-version-link';
        btnLink.title = `Copy review link for ${name}`;
        btnLink.setAttribute('aria-label', `Copy review link for ${name}`);
        btnLink.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>';
        btnLink.addEventListener('click', (e) => {
          e.stopPropagation();
          this._copyVersionReview(v, name);
        });
        row.appendChild(btnLink);
      }

      // Live or scheduled date ranges can be ended / cancelled from here
      if (state.schedule) {
        const isLive = state.tone === 'live';
        const btnCancel = document.createElement('button');
        btnCancel.type = 'button';
        btnCancel.className = 'btn-version-cancel';
        btnCancel.title = isLive ? 'End now and remove its changes from Current Map' : 'Cancel scheduled change';
        btnCancel.setAttribute('aria-label', `${isLive ? 'End' : 'Cancel'} ${name} date-range change`);
        btnCancel.textContent = '✕';
        // Like deleting a stop or a bus: type the project's name first
        btnCancel.addEventListener('click', (e) => {
          e.stopPropagation();
          this._confirmByTyping({
            title: isLive ? `End ${name}?` : `Remove ${name}?`,
            word: name,
            action: isLive ? 'End' : 'Remove',
            onConfirm: () => this._cancelScheduledChange(v.scheduleId),
          });
        });
        row.appendChild(btnCancel);
      }

      if (state.tone === 'current') {
        const tag = document.createElement('span');
        tag.className = 'map-version-badge tone-current';
        tag.textContent = 'Current';
        row.appendChild(tag);
      } else if (state.canRestore) {
        const btnRestore = document.createElement('button');
        btnRestore.type = 'button';
        btnRestore.className = 'btn-version-restore';
        btnRestore.title = 'Make the Current Map match this version again (recorded as a new version)';
        btnRestore.setAttribute('aria-label', `Restore ${name} from ${state.detail}`);
        btnRestore.textContent = 'Restore';
        btnRestore.addEventListener('click', (e) => {
          e.stopPropagation();
          this._promptRestoreMapVersion(v.id);
        });
        row.appendChild(btnRestore);
      }
      return row;
    }

    _renderMapVersions() {
      this._syncHistoryButton();
      if (this.historyOpen) this._renderMapHistory();
    }

    _getAppliedProjectsCount() {
      // Only count valid temporary changes during their chosen date range; permanent changes are not counted
      const now = Date.now();
      return (this.scheduledChanges || []).filter((sc) =>
        (sc.status === 'active' || now >= sc.start) && now < sc.end
      ).length;
    }

    // ------------------------------------------------------------- Version history in the right sidebar
    _syncHistoryButton() {
      const btn = document.getElementById('btn-current-map-history');
      if (!btn) return;
      const count = this._getAppliedProjectsCount();
      btn.classList.toggle('active', !!this.historyOpen);
      btn.classList.toggle('is-offline', count === 0);
      btn.setAttribute('aria-pressed', this.historyOpen ? 'true' : 'false');
      btn.title = `Live (${count})`;
      btn.setAttribute('aria-label', `Live (${count})`);
      const span = btn.querySelector('.btn-history-text') || btn.querySelector('span:not(.activity-online-dot)');
      if (span) {
        span.textContent = `Live (${count})`;
      }
    }

    _toggleMapHistory() {
      if (this.historyOpen) {
        this._hideInspector();
      } else {
        this._showMapHistory();
      }
    }

    _showMapHistory() {
      const panel = document.getElementById('inspector-panel');
      if (!panel) return;

      // The sidebar shows one thing at a time: history replaces the current selection
      this.showingDetourOptionsRouteId = null;
      if (this.renderer) {
        this.renderer.selected = null;
        this.renderer.previewDetourOption = null;
        this.renderer.requestRender();
      }
      this._hideFloatingLegActions();
      this._hideFloatingStopActions();

      panel.classList.remove('hidden', 'expanded-detour');
      document.body.classList.add('has-inspector');
      this._hideSegmentPanel();
      const btnEditPanel = document.getElementById('btn-edit-inspector');
      if (btnEditPanel) btnEditPanel.hidden = true;
      const titleEl = document.getElementById('inspector-header-title');
      if (titleEl) titleEl.textContent = 'Applied Project';

      this.historyOpen = true;
      this._renderMapVersions();
    }

    // Two tabs: temporary projects applying now or later, and the log of permanent changes
    _renderMapHistory() {
      const content = document.querySelector('#inspector-panel .inspector-body');
      if (!content) return;
      const newestFirst = this.mapVersions.slice().sort((a, b) => (b.version || 0) - (a.version || 0));
      // Live first, then scheduled (soonest first), then finished ones, offline, most recent first
      const temporaryStates = newestFirst
        .filter((v) => !this._isBaselineVersion(v))
        .map((v) => ({ v, state: this._mapVersionState(v) }));
      const applying = temporaryStates
        .filter((item) => item.state.schedule)
        .sort((a, b) => (b.state.tone === 'live') - (a.state.tone === 'live') || a.v.start - b.v.start);
      const offline = temporaryStates
        .filter((item) => !item.state.schedule)
        .sort((a, b) => b.state.offlineAt - a.state.offlineAt);
      // One line per project (by name, as users see it): the first entry kept is its most relevant one
      const keyOf = (v) => (v.type === 'start' || v.type === 'edits') ? v.type : (String(v.projectName || '').trim() || v.projectId || v.id);
      const onePerProject = (list) => {
        const seen = new Set();
        return list.filter((v) => !seen.has(keyOf(v)) && seen.add(keyOf(v)));
      };
      // Temporary: live, else its next scheduled, else its latest offline
      const temporary = onePerProject([...applying, ...offline].map((item) => item.v));
      // Permanent: its latest version (Current, or Restore)
      const permanent = onePerProject(newestFirst.filter((v) => this._isBaselineVersion(v)));
      const applyingCount = temporary.filter((v) => this._mapVersionState(v).schedule).length;
      const tab = this.historyTab === 'permanent' ? 'permanent' : 'temporary';
      const tabs = [
        { id: 'temporary', label: 'Temporary projects', count: applyingCount },
        { id: 'permanent', label: 'Permanent changes', count: permanent.length }
      ];
      const empty = {
        temporary: 'No temporary projects yet',
        permanent: 'No permanent changes yet'
      };

      content.innerHTML = `
        <div class="panel-section">
          <div class="history-tabs" role="tablist" aria-label="Applied Project">
            ${tabs.map((t) => `
              <button type="button" role="tab" class="history-tab ${t.id === tab ? 'active' : ''}" data-tab="${t.id}" aria-selected="${t.id === tab}">
                ${t.label}${t.id === 'permanent' ? '' : ` <span class="history-tab-count">${t.count}</span>`}
              </button>
            `).join('')}
          </div>
          <div class="map-versions-list history-list" role="tabpanel"></div>
        </div>
      `;
      content.querySelectorAll('.history-tab').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.historyTab = btn.dataset.tab;
          this._renderMapHistory();
        });
      });

      const list = content.querySelector('.history-list');
      const rows = tab === 'permanent' ? permanent : temporary;
      if (!rows.length) {
        list.innerHTML = `<div class="map-versions-empty">${empty[tab]}</div>`;
      }
      rows.forEach((v) => list.appendChild(this._buildMapVersionRow(v)));
    }

    // Bus numbers whose route pieces don't all join up: pieces join when they share a stop (branches count)
    _disconnectedBuses(doc) {
      const byNumber = new Map();
      for (const r of Object.values((doc && doc.routes) || {})) {
        const num = String(r.number).trim();
        if (!byNumber.has(num)) byNumber.set(num, []);
        byNumber.get(num).push(r);
      }

      const broken = [];
      for (const [num, pieces] of byNumber) {
        if (pieces.length < 2) continue;
        const stops = pieces.map((r) => new Set((r.anchors || []).filter((a) => a.t === 'stop').map((a) => a.id)));
        const group = pieces.map((_, i) => i);
        const root = (i) => (group[i] === i ? i : (group[i] = root(group[i])));
        for (let i = 0; i < pieces.length; i++) {
          for (let j = i + 1; j < pieces.length; j++) {
            if ([...stops[i]].some((id) => stops[j].has(id))) group[root(i)] = root(j);
          }
        }
        const parts = new Set(pieces.map((_, i) => root(i))).size;
        if (parts > 1) broken.push({ number: num, parts });
      }
      return broken.sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
    }

    // Saving or applying needs every bus to be one connected line; otherwise a toast says which bus to finish
    _checkBusesConnected(doc, action = 'save') {
      const broken = this._disconnectedBuses(doc);
      if (!broken.length) return true;
      const detail = broken.length === 1
        ? `Bus ${broken[0].number} isn't connected`
        : `Buses ${broken.map((b) => b.number).join(', ')} aren't connected`;
      if (this._showToast) this._showToast(`Can't ${action}: ${B.esc(detail)}`, 'warn');
      return false;
    }

    _saveProjectDraftById(projId, showFeedback = true) {
      const p = this.projects.find((item) => item.id === projId);
      const projName = p ? p.name : 'Project';
      const doc = (this.activeProjectId === projId) ? this.store.doc : this._loadProjectDraft(projId);
      if (showFeedback && !this._checkBusesConnected(doc)) return;

      if (this.activeProjectId === projId) {
        this.store.save();
        this._saveCurrentProjectDraft(showFeedback);
      } else {
        const draft = this._loadProjectDraft(projId);
        if (draft) {
          try {
            localStorage.setItem('brass_proj_doc_' + projId, JSON.stringify(draft));
          } catch (e) {}
          if (showFeedback && this._showToast) {
            this._showToast(`${projName} saved`, 'success');
          }
        }
      }
    }

    _applyProjectToCurrentMap(projId, period = { mode: 'permanent' }) {
      const p = this.projects.find((item) => item.id === projId);
      if (!p) return;

      const projDoc = (this.activeProjectId === projId)
        ? this.store.doc
        : this._loadProjectDraft(projId);

      if (!projDoc) return;

      const appliedDoc = JSON.parse(JSON.stringify(projDoc));

      if (period.mode === 'scheduled') {
        // Record what this draft changes now; it goes live at period.start and comes off at period.end
        const currentMap = (this.activeProjectId === 'main') ? this.store.doc : this._loadProjectDraft('main');
        const patch = this.scheduledBase
          ? this._diffDocs(this.scheduledBase, appliedDoc, currentMap)
          : this._diffDocs(currentMap, appliedDoc);
        const scheduleId = 'sched-' + Date.now();
        this.scheduledChanges.push({
          id: scheduleId,
          projectId: p.id,
          projectName: p.name,
          start: period.start,
          end: period.end,
          status: 'pending',
          patch,
          createdAt: Date.now()
        });
        this._saveScheduledChanges();
        const tempVersion = this._recordMapVersion({ type: 'temporary', scheduleId, projectId: p.id, projectName: p.name, start: period.start, end: period.end });
        if (this._saveProjectMap(tempVersion.id, appliedDoc)) {
          tempVersion.hasProjectMap = true;
          this._saveMapVersions();
        }

        // The range is now listed under Current Map, so the card starts a fresh Temporary range
        delete p.applyPeriod;
        this._saveProjects();

        if (period.start <= Date.now()) {
          this._processScheduledChanges();
        } else {
          this._renderProjects();
          if (this._showToast) {
            this._showToast(`"${B.esc(p.name)}" scheduled for ${B.esc(this._formatShortTime(period.start))}`, 'success');
          }
        }
        return;
      }

      this._ensureStartVersion();

      // A permanent apply becomes the new baseline, so live date-range changes end here
      const live = this._liveScheduledChanges();
      if (live.length) {
        this.scheduledChanges = this.scheduledChanges.filter((sc) => sc.status !== 'active');
        this.scheduledBase = null;
        this._saveScheduledChanges();
        live.forEach((sc) => this._setMapVersionStatus(sc.id, 'replaced'));
      }

      this._writeCurrentMapDoc(appliedDoc, `Apply ${p.name} to Current Map`);
      this._recordMapVersion({ type: 'permanent', projectId: p.id, projectName: p.name }, true, appliedDoc);

      if (this._showToast) {
        this._showToast(`"${B.esc(p.name)}" applied`, 'success');
        if (live.length) {
          const names = live.map((sc) => `"${B.esc(sc.projectName)}"`).join(', ');
          this._showToast(`Ended temporary ${names}`, 'info');
        }
      }

      this._renderProjects();
    }

    _renderProjects() {
      this._updateHeaderProjectDisplay();
      this._renderMapVersions();

      // Update Current Map (Main) Card active status
      const isMainActive = this.activeProjectId === 'main';
      const btnViewCurrentMap = document.getElementById('btn-view-current-map');
      if (btnViewCurrentMap) {
        btnViewCurrentMap.classList.toggle('active', isMainActive);
        btnViewCurrentMap.setAttribute('aria-pressed', isMainActive ? 'true' : 'false');
      }

      const container = document.getElementById('projects-list');
      if (!container) return;

      container.innerHTML = '';
      if (!this.projects.length) {
        return;
      }

      for (const p of this.projects) {
        const isActive = p.id === this.activeProjectId;
        const isEditing = p.id === this.editingProjectId;
        const isExpanded = this.expandedProjectIds.has(p.id);

        const wrapper = document.createElement('div');
        wrapper.className = `project-card-wrapper ${isActive ? 'active' : ''} ${isExpanded ? 'expanded' : ''}`;
        wrapper.dataset.projectId = p.id;

        const item = document.createElement('div');
        item.className = 'project-item';

        // Collapsible Component (Replacing the online dot)
        const btnCollapse = document.createElement('button');
        btnCollapse.type = 'button';
        btnCollapse.className = 'btn-project-collapse';
        btnCollapse.title = isExpanded ? 'Collapse project actions' : 'Expand project actions';
        btnCollapse.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
        btnCollapse.setAttribute('aria-label', `${isExpanded ? 'Collapse' : 'Expand'} actions for ${p.name}`);
        btnCollapse.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" class="project-chevron">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        `;
        btnCollapse.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.expandedProjectIds.has(p.id)) {
            this.expandedProjectIds.delete(p.id);
          } else {
            this.expandedProjectIds.add(p.id);
          }
          this._renderProjects();
        });
        item.appendChild(btnCollapse);

        if (isEditing) {
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'project-inline-input';
          input.value = p.name;
          input.maxLength = 40;
          input.title = 'Press Enter to save, Esc to cancel';

          let committed = false;
          const commit = () => {
            if (committed) return;
            committed = true;
            const val = input.value.trim();
            if (val) p.name = val;
            this.editingProjectId = null;
            this._saveProjects();
            this._renderProjects();
          };

          input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              committed = true;
              this.editingProjectId = null;
              this._renderProjects();
            }
          });

          input.addEventListener('click', (e) => e.stopPropagation());
          input.addEventListener('blur', commit);

          item.appendChild(input);
          setTimeout(() => {
            if (typeof input.focus === 'function') input.focus();
            if (typeof input.select === 'function') input.select();
          }, 20);
        } else {
          const nameSpan = document.createElement('span');
          nameSpan.className = 'project-name';
          nameSpan.textContent = p.name;
          if (this._drawUpdatePending(p)) {
            const dot = document.createElement('span');
            dot.className = 'project-update-dot';
            dot.title = 'New drawings from its link · Refresh to add them';
            dot.setAttribute('aria-label', 'New drawings');
            nameSpan.appendChild(dot);
          }
          nameSpan.title = 'Click to switch to this draft map, double-click to rename';
          nameSpan.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            this.editingProjectId = p.id;
            this._renderProjects();
          });
          item.appendChild(nameSpan);

          const actions = document.createElement('div');
          actions.className = 'project-actions';

          // View Mode (EYE ICON)
          const btnView = document.createElement('button');
          btnView.type = 'button';
          const isViewActive = isActive && this.mode === 'view';
          btnView.className = `btn-project-mode btn-project-view ${isViewActive ? 'active' : ''}`;
          btnView.title = `View mode (${p.name})`;
          btnView.setAttribute('aria-label', `View mode for ${p.name}`);
          btnView.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
          btnView.addEventListener('click', (e) => {
            e.stopPropagation();
            this._switchProject(p.id, 'view');
          });
          actions.appendChild(btnView);

          // Edit Mode (EDIT ICON)
          const btnEdit = document.createElement('button');
          btnEdit.type = 'button';
          const isEditActive = isActive && this.mode === 'edit';
          btnEdit.className = `btn-project-mode btn-project-edit ${isEditActive ? 'active' : ''}`;
          btnEdit.title = `Edit mode (${p.name})`;
          btnEdit.setAttribute('aria-label', `Edit mode for ${p.name}`);
          btnEdit.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>';
          btnEdit.addEventListener('click', (e) => {
            e.stopPropagation();
            this._switchProject(p.id, 'edit');
          });
          actions.appendChild(btnEdit);

          // Duplicate Draft button
          const btnDup = document.createElement('button');
          btnDup.type = 'button';
          btnDup.className = 'btn-project-action btn-project-duplicate';
          btnDup.title = `Duplicate ${p.name} draft map`;
          btnDup.setAttribute('aria-label', `Duplicate ${p.name} draft map`);
          btnDup.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
          btnDup.addEventListener('click', (e) => {
            e.stopPropagation();
            this._duplicateProject(p.id);
          });
          actions.appendChild(btnDup);

          // Share Draft button: copies a link that opens this draft as a new project
          const btnShare = document.createElement('button');
          btnShare.type = 'button';
          btnShare.className = 'btn-project-action btn-project-share';
          btnShare.title = `Share ${p.name}: copy a link or download a PDF`;
          btnShare.setAttribute('aria-label', `Share ${p.name}`);
          btnShare.setAttribute('aria-haspopup', 'menu');
          btnShare.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"></path><polyline points="16 6 12 2 8 6"></polyline><line x1="12" y1="2" x2="12" y2="15"></line></svg>';
          btnShare.addEventListener('click', (e) => {
            e.stopPropagation();
            this._openShareMenu(btnShare, p);
          });
          actions.appendChild(btnShare);

          // Delete Project
          const btnDel = document.createElement('button');
          btnDel.type = 'button';
          btnDel.className = 'btn-project-action btn-project-delete';
          btnDel.title = `Delete ${p.name}`;
          btnDel.innerHTML = '✕';
          btnDel.addEventListener('click', (e) => {
            e.stopPropagation();
            this._promptDeleteProject(p.id);
          });
          actions.appendChild(btnDel);

          item.appendChild(actions);

          // Clicking the project row switches to that project draft
          item.addEventListener('click', (e) => {
            if (e.target.closest('.project-actions') || e.target.closest('input') || e.target.closest('.btn-project-collapse')) return;
            this._switchProject(p.id);
          });
        }

        wrapper.appendChild(item);

        // Collapsible drawer under each project: effective period, then Save and Apply to Current Map buttons
        const drawer = document.createElement('div');
        drawer.className = 'project-drawer';
        const periodBox = this._buildProjectPeriod(p);
        // Temporary only: a link for someone to draw areas and closures, and Refresh to add them here
        const range = periodBox.querySelector('.project-period-range');
        if (range) range.appendChild(this._buildDrawLinkRow(p));
        drawer.appendChild(periodBox);
        drawer.appendChild(this._buildProjectAreas(p));

        const drawerInner = document.createElement('div');
        drawerInner.className = 'project-drawer-inner';

        // 1. Save button
        const btnSave = document.createElement('button');
        btnSave.type = 'button';
        btnSave.className = 'btn-drawer-action btn-drawer-save';
        btnSave.title = `Save draft for ${p.name}`;
        btnSave.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
            <polyline points="17 21 17 13 7 13 7 21"></polyline>
            <polyline points="7 3 7 8 15 8"></polyline>
          </svg>
          <span>Save</span>
        `;
        btnSave.addEventListener('click', (e) => {
          e.stopPropagation();
          this._saveProjectDraftById(p.id, true);
        });
        drawerInner.appendChild(btnSave);

        // 2. Apply to Current Map button
        const btnApply = document.createElement('button');
        btnApply.type = 'button';
        btnApply.className = 'btn-drawer-action btn-drawer-apply';
        btnApply.innerHTML = `<span>Apply to Current Map</span>`;
        btnApply.addEventListener('click', (e) => {
          e.stopPropagation();
          this._applyFromDrawer(p);
        });
        drawerInner.appendChild(btnApply);

        drawer.appendChild(drawerInner);
        this._updateProjectPeriodUI(p, drawer);
        wrapper.appendChild(drawer);

        container.appendChild(wrapper);
      }
    }
  }

  B.Controller = Controller;
})();
