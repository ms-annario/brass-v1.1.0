/* BRASS — documents attached to projects. Files are kept in this browser (IndexedDB), not in the map. */
(function () {
  const B = window.B;
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('brass_documents', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('docs', { keyPath: 'id' }).createIndex('projectId', 'projectId');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const run = (mode, fn) => open().then((db) => new Promise((res, rej) => {
    const tx = db.transaction('docs', mode), st = tx.objectStore('docs');
    const req = fn(st);
    tx.oncomplete = () => res(req && req.result);
    tx.onerror = () => rej(tx.error);
  }));

  B.docs = {
    all: () => run('readonly', (s) => s.getAll()).then((l) => (l || []).sort((a, b) => b.added - a.added)),
    add: (projectId, file) => run('readwrite', (s) => s.put({
      id: 'doc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      projectId, name: file.name, type: file.type, size: file.size, added: Date.now(), blob: file,
    })),
    remove: (id) => run('readwrite', (s) => s.delete(id)),
    removeProject: (projectId) => B.docs.all().then((l) => Promise.all(l.filter((d) => d.projectId === projectId).map((d) => B.docs.remove(d.id)))),
    download: (d) => {
      const url = URL.createObjectURL(d.blob), a = document.createElement('a');
      a.href = url; a.download = d.name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    },
    size: (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB'),
  };
})();
