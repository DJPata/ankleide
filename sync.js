// Gemeinsamer Haushalt über Firebase (Firestore + anonyme Anmeldung).
// Ohne Firebase-Konfiguration oder ohne Haushalt passiert hier nichts, die App läuft dann rein lokal.
// Daten: households/{id} = { members: [uid], geminiKey, createdAt }
//        households/{id}/{liste}/{eintragId} = Eintrag + { deleted, updatedAt }
(() => {
  const FB = 'https://www.gstatic.com/firebasejs/11.0.2/';
  const HH = 'hh-household';
  const col = key => key.replace(/^hh-/, '');
  let fb = null, db = null, user = null, hid = null, flushing = false, again = false, readyP = null;
  const unsubs = [];
  const status = { state: 'off', members: 0, error: '' };
  const emit = () => window.dispatchEvent(new CustomEvent('hh-sync-status', { detail: { ...status } }));
  const setStatus = patch => { Object.assign(status, patch); emit(); };

  const configured = () => !!(window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey);
  const household = () => load(HH, null);

  async function boot() {
    if (fb) return;
    const [app, auth, fs] = await Promise.all([import(FB + 'firebase-app.js'), import(FB + 'firebase-auth.js'), import(FB + 'firebase-firestore.js')]);
    fb = { ...app, ...auth, ...fs };
    const a = fb.initializeApp(window.FIREBASE_CONFIG);
    const au = fb.getAuth(a);
    await au.authStateReady?.();
    user = au.currentUser || (await fb.signInAnonymously(au)).user;
    db = fb.getFirestore(a);
  }

  function friendly(e) {
    const m = String(e?.code || e?.message || e);
    if (/permission/i.test(m)) return 'Keine Berechtigung. Sind die Firestore-Regeln veröffentlicht?';
    if (/configuration-not-found|CONFIGURATION_NOT_FOUND/i.test(m)) return 'In Firebase ist „Authentication“ noch nicht eingerichtet (Schritt 3).';
    if (/does not exist|NOT_FOUND|not-found/i.test(m)) return 'In Firebase fehlt noch die Firestore-Datenbank (Schritt 4).';
    if (/admin-restricted|operation-not-allowed/i.test(m)) return 'Anonyme Anmeldung ist in Firebase noch nicht eingeschaltet.';
    if (/unauthorized-domain/i.test(m)) return 'djpata.github.io fehlt in Firebase unter „Autorisierte Domains“.';
    if (/network|offline|unavailable|Failed to fetch|import/i.test(m)) return 'Keine Verbindung. Ich versuche es später nochmal.';
    return m;
  }

  // Alle lokalen Einträge als „zu hochladen“ markieren (beim Erstellen/Beitreten)
  function markAllDirty() {
    const dirty = load(DIRTY_KEY, {});
    for (const k of SYNC_KEYS) { const d = dirty[k] ||= {}; for (const it of load(k, [])) if (it?.id) { it.updatedAt ||= Date.now(); d[it.id] = d[it.id] || 1; } }
    localStorage.setItem(DIRTY_KEY, JSON.stringify(dirty));
  }

  async function flush() {
    if (!db || !hid) return;
    if (flushing) { again = true; return; }
    flushing = true;
    try {
      do {
        again = false;
        const dirty = load(DIRTY_KEY, {});
        for (const k of Object.keys(dirty)) {
          const list = load(k, []);
          for (const [id, what] of Object.entries(dirty[k])) {
            const ref = fb.doc(db, 'households', hid, col(k), id);
            const it = list.find(x => x.id === id);
            if (what === 'del' || !it) await fb.setDoc(ref, { id, deleted: true, updatedAt: Date.now() });
            else await fb.setDoc(ref, { ...JSON.parse(JSON.stringify(it)), deleted: false });
            const cur = load(DIRTY_KEY, {}); if (cur[k]?.[id] === what) { delete cur[k][id]; localStorage.setItem(DIRTY_KEY, JSON.stringify(cur)); }
          }
        }
      } while (again);
      setStatus({ state: 'on', error: '' });
    } catch (e) { setStatus({ state: 'error', error: friendly(e) }); }
    flushing = false;
  }

  // Änderungen der anderen übernehmen: neuere Version gewinnt, eigene noch nicht hochgeladene Änderungen bleiben
  function applyRemote(k, docs) {
    const list = load(k, []); const dirty = load(DIRTY_KEY, {})[k] || {};
    let changed = false;
    for (const r of docs) {
      if (dirty[r.id]) continue;
      const i = list.findIndex(x => x.id === r.id);
      if (r.deleted) { if (i >= 0) { list.splice(i, 1); changed = true; } continue; }
      const { deleted, ...item } = r;
      if (i < 0) { list.push(item); changed = true; }
      else if ((item.updatedAt || 0) > (list[i].updatedAt || 0)) { list[i] = item; changed = true; }
    }
    if (changed) { localStorage.setItem(k, JSON.stringify(list)); window.dispatchEvent(new CustomEvent('hh-sync', { detail: { key: k } })); }
  }

  function listen() {
    unsubs.splice(0).forEach(u => u());
    unsubs.push(fb.onSnapshot(fb.doc(db, 'households', hid), snap => {
      const d = snap.data() || {};
      if (d.members && !d.members.includes(user.uid)) return; // wurde entfernt
      setStatus({ members: (d.members || []).length });
      if (d.geminiKey && !getCfg().key) { setCfg({ key: d.geminiKey }); window.dispatchEvent(new CustomEvent('hh-sync', { detail: { key: 'cfg' } })); }
    }, e => setStatus({ state: 'error', error: friendly(e) })));
    for (const k of SYNC_KEYS) {
      unsubs.push(fb.onSnapshot(fb.collection(db, 'households', hid, col(k)), snap => {
        const docs = snap.docChanges().filter(c => c.type !== 'removed' && !c.doc.metadata.hasPendingWrites).map(c => c.doc.data());
        if (docs.length) applyRemote(k, docs);
      }, e => setStatus({ state: 'error', error: friendly(e) })));
    }
  }

  async function start() {
    const h = household(); if (!configured() || !h) { setStatus({ state: configured() ? 'off' : 'unconfigured' }); return; }
    setStatus({ state: 'connecting' });
    try {
      await boot(); hid = h.id;
      const ref = fb.doc(db, 'households', hid);
      const snap = await fb.getDoc(ref);
      if (!snap.exists()) throw new Error('Diesen Haushalt gibt es nicht (mehr).');
      // z. B. nach „Zum Home-Bildschirm“: neues Gerät, gleicher Haushalt → automatisch wieder beitreten
      if (!(snap.data().members || []).includes(user.uid)) await fb.updateDoc(ref, { members: fb.arrayUnion(user.uid) });
      listen(); await flush();
    } catch (e) { setStatus({ state: 'error', error: friendly(e) }); }
  }

  const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');

  window.hhSync = {
    status: () => ({ ...status }),
    configured, household, flush, start,
    inviteLink() { const h = household(); return h ? new URL(`./?join=${h.id}`, location.href).href : ''; },
    async create() {
      await boot(); const id = newId();
      await fb.setDoc(fb.doc(db, 'households', id), { members: [user.uid], geminiKey: getCfg().key || '', createdAt: Date.now() });
      save(HH, { id, since: Date.now() }); markAllDirty(); await start(); return id;
    },
    async join(idOrLink) {
      const id = String(idOrLink || '').trim().match(/(?:join=)?([a-z0-9]{20,})\s*$/i)?.[1];
      if (!id) throw new Error('Das sieht nicht wie ein Einladungslink aus.');
      await boot();
      const ref = fb.doc(db, 'households', id);
      const snap = await fb.getDoc(ref).catch(e => { throw new Error(friendly(e)); });
      if (!snap.exists()) throw new Error('Diese Einladung gibt es nicht (mehr).');
      if (!(snap.data().members || []).includes(user.uid)) await fb.updateDoc(ref, { members: fb.arrayUnion(user.uid) });
      const k = snap.data().geminiKey; if (k && !getCfg().key) setCfg({ key: k });
      save(HH, { id, since: Date.now() }); markAllDirty(); await start(); return id;
    },
    async leave() {
      const h = household(); if (!h) return;
      try { await boot(); await fb.updateDoc(fb.doc(db, 'households', h.id), { members: fb.arrayRemove(user.uid) }); } catch {}
      unsubs.splice(0).forEach(u => u()); hid = null;
      localStorage.removeItem(HH); localStorage.removeItem(DIRTY_KEY); setStatus({ state: 'off', members: 0 });
    },
    async pushKey(key) {
      if (!db || !hid) return;
      try { await fb.updateDoc(fb.doc(db, 'households', hid), { geminiKey: key || '' }); } catch {}
    },
  };
  window.addEventListener('online', () => flush());
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
