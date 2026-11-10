/* BRASS — MRT stations
 * One station beside the main road at each town centre, plus stations halfway between neighbouring towns.
 * The city comes from a fixed seed and so do these, so every machine and every project sees the same stations.
 */
(function () {
  const B = window.B;

  // "Braddell Road" → "Braddell"
  const placeName = (road) => String(road || '').replace(/\s+(Road|Rd|Avenue|Ave|Street|St|Drive|Dr|Way|Lane|Boulevard|Crescent|Link|Expressway)\b.*$/i, '').trim();
  const firstWord = (name) => name.split(/\s+/)[0].toLowerCase();

  // Official Singapore MRT station codes for generated towns and corridors
  const MRT_CODES = {
    'downtown core': 'DT17',
    'tanjong pagar': 'EW15',
    'orchard': 'NS22 / TE14',
    'newton': 'NS21 / DT11',
    'novena': 'NS20',
    'kallang': 'EW10',
    'geylang': 'EW9',
    'marine parade': 'TE26',
    'bedok': 'EW5',
    'tampines': 'EW2 / DT32',
    'pasir ris': 'EW1',
    'changi': 'CG2',
    'loyang': 'CR3',
    'paya lebar': 'EW8 / CC9',
    'hougang': 'NE14',
    'sengkang': 'NE16',
    'punggol': 'NE17',
    'serangoon': 'NE12 / CC13',
    'ang mo kio': 'NS16',
    'bishan': 'NS17 / CC15',
    'toa payoh': 'NS19',
    'thomson': 'TE8',
    'yishun': 'NS13',
    'sembawang': 'NS11',
    'woodlands': 'NS9 / TE2',
    'seletar': 'TE4',
    'kranji': 'NS7',
    'lim chu kang': 'NS6',
    'bukit panjang': 'DT1',
    'choa chu kang': 'NS4',
    'tengah': 'JE1',
    'holland village': 'CC21',
    'tanglin': 'TE13',
    'queenstown': 'EW19',
    'clementi': 'EW23',
    'jurong east': 'NS1 / EW24',
    'pioneer': 'EW28',
    'tuas': 'EW33',
    'dunearn': 'DT7',
    'balestier': 'DT11',
    'upper paya lebar': 'CC11',
    'bukit timah': 'DT8',
    'bukit batok': 'NS2',
    'boon lay': 'EW27',
    'buona vista': 'EW21 / CC22',
    'harbourfront': 'NE1 / CC29',
    'dhoby ghaut': 'NS24 / NE6 / CC1',
    'city hall': 'NS25 / EW13',
    'raffles place': 'NS26 / EW14',
    'bugis': 'EW12 / DT14',
    'macpherson': 'CC10 / DT26',
  };

  B.placeMrtStations = (city, net) => {
    const stations = [];
    const usedCodes = new Set();
    const resolveCode = (name, idx) => {
      const key = String(name || '').trim().toLowerCase();
      let code = MRT_CODES[key];
      if (!code) {
        const matchKey = Object.keys(MRT_CODES).find((k) => key.startsWith(k) || k.startsWith(key));
        if (matchKey) code = MRT_CODES[matchKey];
      }
      if (!code || usedCodes.has(code)) {
        let n = idx;
        while (usedCodes.has(`MR${n}`)) n++;
        code = `MR${n}`;
      }
      usedCodes.add(code);
      return code;
    };

    const add = (t, name) => {
      const road = net.nearest(t, 420);
      if (!road) return;
      const e = net.edge(road.edge);
      name = name || placeName(e && e.name);
      if (!name || stations.some((s) => firstWord(s.name) === firstWord(name))) return;
      // Just off the road, on the side of the town centre
      const dx = t.x - road.x, dy = t.y - road.y;
      const d = Math.hypot(dx, dy);
      const off = (road.hw || 6) + 26;
      const p = d > 1 ? { x: road.x + (dx / d) * off, y: road.y + (dy / d) * off } : { x: road.x, y: road.y - off };
      if (stations.some((s) => Math.hypot(s.x - p.x, s.y - p.y) < 550)) return;
      const idx = stations.length + 1;
      const code = resolveCode(name, idx);
      stations.push({ id: `MRT${idx}`, code, name, x: p.x, y: p.y, edge: road.edge });
    };

    // Town centres
    const ds = city.districts;
    ds.forEach((d) => add(d, d.name));

    // Between towns: halfway along the closer pairs first, named after the road there
    const pairs = [];
    for (let i = 0; i < ds.length; i++) {
      for (let j = i + 1; j < ds.length; j++) {
        const d = Math.hypot(ds[i].x - ds[j].x, ds[i].y - ds[j].y);
        if (d > 900 && d < 3000) pairs.push({ d, x: (ds[i].x + ds[j].x) / 2, y: (ds[i].y + ds[j].y) / 2 });
      }
    }
    pairs.sort((a, b) => a.d - b.d).forEach((p) => add(p, null));
    return stations;
  };
})();
