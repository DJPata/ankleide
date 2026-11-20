// Gemeinsame Haushalte über Firebase (Firestore + anonyme Anmeldung).
// Ohne Firebase-Konfiguration oder ohne Haushalt passiert hier nichts, die App läuft dann rein lokal.
// Daten: households/{id} = { members: [uid], name, geminiKey, createdAt }
//        households/{id}/{liste}/{eintragId} = Eintrag + { deleted, updatedAt }
// Ein Gerät kann in mehreren Haushalten sein (z. B. „Patrick“ und „Lisa“). Aktiv ist immer einer:
// seine Listen liegen unter den normalen Schlüsseln, die anderen unter „hh-store:<id>:…“ (siehe common.js).
(() => {
  const FB = 'https://www.gstatic.com/firebasejs/11.0.2/';
  const HH = 'hh-household', LIST = 'hh-households';
  const col = key => key.replace(/^hh-/, '');
  const STORE_KEYS = [...SYNC_KEYS, DIRTY_KEY];
  let fb = null, db = null, user = null, hid = null, memberIds = [], seen = {}, seenTimer = null;
  const flushing = {}, again = {};
  const unsubs = [];
  const status = { state: 'off', members: 0, error: '' };
  const emit = () => window.dispatchEvent(new CustomEvent('hh-sync-status', { detail: { ...status } }));
  const setStatus = patch => { Object.assign(status, patch); emit(); };

  const configured = () => !!(window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey);
  const household = () => load(HH, null);
  function households() {
    let l = load(LIST, null);
    if (!l) { const h = household(); l = h ? [{ id: h.id, name: h.name || '' }] : []; save(LIST, l); }
    return l;
  }
  const setHouseholds = l => save(LIST, l);
  const nameOf = h => (h && h.name) || 'Unser Haushalt';

  async function boot() {
    if (fb) return;
    const [app, auth, fs] = await Promise.all([import(FB + 'firebase-app.js'), import(FB + 'firebase-auth.js'), import(FB + 'firebase-firestore.js')]);
    fb = { ...app, ...auth, ...fs };
    const a = fb.initializeApp(window.FIREBASE_CONFIG);
    const au = fb.getAuth(a);
    await au.authStateReady?.();
    user = au.currentUser || (await fb.signInAnonymously(au)).user;
    db = fb.getFirestore(a);
    try { localStorage.setItem('hh-uid', user.uid); } catch {}
  }

  function friendly(e) {
    const m = String(e?.code || e?.message || e);
    if (/configuration-not-found|CONFIGURATION_NOT_FOUND/i.test(m)) return 'In Firebase ist „Authentication“ noch nicht eingerichtet (Schritt 3).';
    if (/does not exist|NOT_FOUND|not-found/i.test(m)) return 'In Firebase fehlt noch die Firestore-Datenbank (Schritt 4).';
    if (/admin-restricted|operation-not-allowed/i.test(m)) return 'Anonyme Anmeldung ist in Firebase noch nicht eingeschaltet.';
    if (/permission/i.test(m)) return 'Keine Berechtigung. Sind die Firestore-Regeln veröffentlicht?';
    if (/unauthorized-domain/i.test(m)) return 'djpata.github.io fehlt in Firebase unter „Autorisierte Domains“.';
    if (/network|offline|unavailable|Failed to fetch|import/i.test(m)) return 'Keine Verbindung. Ich versuche es später nochmal.';
    return e?.message && e.message !== m ? `${m}: ${e.message}` : m;
  }

  // ---------- lokale Ablage pro Haushalt ----------
  const sk = (id, k) => `hh-store:${id}:${k}`;
  function stash(id) {
    for (const k of STORE_KEYS) { const v = localStorage.getItem(k); if (v != null) localStorage.setItem(sk(id, k), v); else localStorage.removeItem(sk(id, k)); localStorage.removeItem(k); }
  }
  function unstash(id) {
    for (const k of STORE_KEYS) { const v = localStorage.getItem(sk(id, k)); if (v != null) localStorage.setItem(k, v); else localStorage.removeItem(k); localStorage.removeItem(sk(id, k)); }
  }
  function dropStash(id) { for (const k of STORE_KEYS) localStorage.removeItem(sk(id, k)); }

  // Firestore mag kein undefined, keine Listen in Listen, keine Felder wie „__x__“ und keine kaputten Zeichen
  function clean(v, depth = 0) {
    if (v === undefined || typeof v === 'function') return undefined;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string') { const t = v.toWellFormed ? v.toWellFormed() : v.replace(/[\uD800-\uDFFF]/g, '�'); return t.length > 200000 ? t.slice(0, 200000) : t; }
    if (v === null || typeof v !== 'object') return v;
    if (depth > 15) return JSON.stringify(v).slice(0, 200000);
    if (Array.isArray(v)) return v.map(x => Array.isArray(x) ? JSON.stringify(x) : clean(x, depth + 1)).filter(x => x !== undefined);
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (!k || /^__.*__$/.test(k) || k.length > 1000) continue;
      const c = clean(x, depth + 1); if (c !== undefined) o[k] = c;
    }
    return o;
  }
  const validId = id => typeof id === 'string' && id && id !== '.' && id !== '..' && !id.includes('/') && !/^__.*__$/.test(id) && id.length < 1000;

  // Alle lokalen Einträge als „hochladen“ markieren (nur beim ersten Haushalt: vorhandene Daten ziehen mit um)
  function markAllDirty() {
    const dirty = load(DIRTY_KEY, {});
    for (const k of SYNC_KEYS) { const d = dirty[k] ||= {}; for (const it of load(k, [])) if (it?.id) { it.updatedAt ||= Date.now(); d[it.id] = d[it.id] || 1; } }
    localStorage.setItem(DIRTY_KEY, JSON.stringify(dirty));
  }

  async function flush(id = hid) {
    if (!id || !household()) return;
    if (id !== hid && !households().some(h => h.id === id)) return;
    if (!db) { if (configured()) { try { await boot(); } catch { return; } } else return; }
    if (flushing[id]) { again[id] = true; return; }
    flushing[id] = true;
    const get = k => { try { return JSON.parse(localStorage.getItem(id === hid ? k : sk(id, k))); } catch { return null; } };
    const put = (k, v) => localStorage.setItem(id === hid ? k : sk(id, k), JSON.stringify(v));
    const bad = [];
    try {
      do {
        again[id] = false;
        const dirty = get(DIRTY_KEY) || {};
        for (const k of Object.keys(dirty)) {
          const list = get(k) || [];
          for (const [eid, what] of Object.entries(dirty[k])) {
            const it = list.find(x => x.id === eid);
            try {
              if (!validId(eid)) throw Object.assign(new Error('ungültige id'), { code: 'invalid-argument' });
              const ref = fb.doc(db, 'households', id, col(k), eid);
              if (what === 'del' || !it) await fb.setDoc(ref, { id: eid, deleted: true, updatedAt: Date.now() });
              else await fb.setDoc(ref, { ...clean(it), deleted: false });
            } catch (e) {
              // Ein kaputter Eintrag soll nicht alles blockieren: merken und weitermachen
              if (!/invalid-argument|INVALID_ARGUMENT|invalid data|Unsupported field|not a valid/i.test(String(e.code) + ' ' + e.message)) throw e;
              console.warn('Eintrag übersprungen', k, eid, e);
              bad.push(`${col(k)}: ${(it && (it.title || it.text || it.name)) || eid} (${e.message})`);
            }
            const cur = get(DIRTY_KEY) || {}; if (cur[k]?.[eid] === what) { delete cur[k][eid]; put(DIRTY_KEY, cur); }
          }
        }
      } while (again[id]);
      if (id === hid) setStatus({ state: 'on', error: '' });
      if (bad.length) console.warn('Nicht synchronisiert:', bad);
    } catch (e) { console.warn('Sync-Fehler beim Hochladen', e); if (id === hid) setStatus({ state: 'error', error: `${friendly(e)} (Hochladen)` }); }
    flushing[id] = false;
  }
  const flushAll = () => households().forEach(h => flush(h.id));

  // Änderungen der anderen übernehmen: neuere Version gewinnt, eigene noch nicht hochgeladene Änderungen bleiben
  function applyRemote(k, docs, id = hid) {
    const key = x => (id === hid ? x : sk(id, x));
    const rd = (x, f) => { try { return JSON.parse(localStorage.getItem(key(x))) ?? f; } catch { return f; } };
    const list = rd(k, []); const dirty = rd(DIRTY_KEY, {})[k] || {};
    let changed = false;
    for (const r of docs) {
      if (dirty[r.id]) continue;
      const i = list.findIndex(x => x.id === r.id);
      if (r.deleted) { if (i >= 0) { list.splice(i, 1); changed = true; } continue; }
      const { deleted, ...item } = r;
      if (i < 0) { list.push(item); changed = true; }
      else if ((item.updatedAt || 0) > (list[i].updatedAt || 0)) { list[i] = item; changed = true; }
    }
    if (changed) { localStorage.setItem(key(k), JSON.stringify(list)); window.dispatchEvent(new CustomEvent('hh-sync', { detail: { key: k, hh: id } })); }
  }

  function listen() {
    unsubs.splice(0).forEach(u => u());
    const id = hid;
    unsubs.push(fb.onSnapshot(fb.doc(db, 'households', id), snap => {
      const d = snap.data() || {};
      if (d.members && !d.members.includes(user.uid)) return;
      memberIds = d.members || []; setStatus({ members: memberIds.length });
      const l = households(), h = l.find(x => x.id === id);
      if (h && d.name && h.name !== d.name) { h.name = d.name; setHouseholds(l); renderSwitcher(); setStatus({}); }
      if (d.geminiKey && !getCfg().key) { setCfg({ key: d.geminiKey }); window.dispatchEvent(new CustomEvent('hh-sync', { detail: { key: 'cfg' } })); }
    }, e => listenError(e, 'Haushalt')));
    // Lesebestätigung: households/{id}/seen/{uid} = { einkauf: Zeitpunkt, todo: …, putzplan: … }
    unsubs.push(fb.onSnapshot(fb.collection(db, 'households', id, 'seen'), snap => {
      snap.docChanges().forEach(c => { seen[c.doc.id] = c.doc.data(); });
      window.dispatchEvent(new CustomEvent('hh-sync', { detail: { key: 'seen' } }));
    }, () => {}));
    if (seenList) markSeen(seenList);
    for (const k of SYNC_KEYS) {
      unsubs.push(fb.onSnapshot(fb.collection(db, 'households', id, col(k)), snap => {
        const docs = snap.docChanges().filter(c => c.type !== 'removed' && !c.doc.metadata.hasPendingWrites).map(c => c.doc.data());
        if (docs.length) applyRemote(k, docs);
      }, e => listenError(e, col(k))));
    }
    // Kalender über alle Haushalte: Termine der anderen Haushalte ebenfalls mitlesen (getrennte Wohnungen, ein gemeinsamer Kalender)
    for (const h of households()) {
      if (h.id === id) continue;
      unsubs.push(fb.onSnapshot(fb.collection(db, 'households', h.id, col(TERM_KEY)), snap => {
        const docs = snap.docChanges().filter(c => c.type !== 'removed' && !c.doc.metadata.hasPendingWrites).map(c => c.doc.data());
        if (docs.length) applyRemote(TERM_KEY, docs, h.id);
      }, e => console.warn('Termine anderer Haushalt', h.id, e)));
    }
  }

  // Fehler beim Mitlesen: anzeigen, wo es hakt, und nach kurzer Pause neu verbinden
  let retries = 0, retryTimer = null;
  function listenError(e, where) {
    console.warn('Sync-Fehler', where, e);
    setStatus({ state: 'error', error: `${friendly(e)} (${where})` });
    if (retries < 3 && !retryTimer) retryTimer = setTimeout(() => { retryTimer = null; retries++; start(); }, 5000 * (retries + 1));
  }
  async function start() {
    renderSwitcher();
    const h = household(); if (!configured() || !h) { setStatus({ state: configured() ? 'off' : 'unconfigured' }); return; }
    setStatus({ state: 'connecting' });
    try {
      await boot(); hid = h.id;
      const ref = fb.doc(db, 'households', hid);
      const snap = await fb.getDoc(ref);
      if (!snap.exists()) throw new Error('Diesen Haushalt gibt es nicht (mehr).');
      // z. B. nach „Zum Home-Bildschirm“: neues Gerät, gleicher Haushalt → automatisch wieder beitreten
      if (!(snap.data().members || []).includes(user.uid)) await fb.updateDoc(ref, { members: fb.arrayUnion(user.uid) });
      listen(); await flush(hid); if (status.state !== 'error') retries = 0;
      households().filter(x => x.id !== hid).forEach(x => flush(x.id)); // Sprach-Einträge für andere Haushalte nachschicken
    } catch (e) { listenError(e, 'Verbinden'); }
  }

  // Zu einem anderen (oder neuen) Haushalt wechseln: aktuelle Listen wegpacken, die des anderen holen
  function activate(id, { fresh = false } = {}) {
    const cur = household();
    if (cur && cur.id !== id) stash(cur.id);
    if (cur && cur.id !== id && !fresh) unstash(id);
    if (fresh && cur) for (const k of STORE_KEYS) localStorage.removeItem(k);
    save(HH, { id, since: Date.now() });
  }

  // ---------- Umschalter oben auf jeder Seite ----------
  function renderSwitcher() {
    const l = households(), top = document.querySelector('header.top');
    let el = document.getElementById('hhSwitch');
    if (!top || l.length < 2) { el?.remove(); return; }
    if (!el) {
      el = document.createElement('div'); el.id = 'hhSwitch'; el.className = 'chips hh-switch';
      const h1 = top.querySelector('h1'); top.insertBefore(el, h1 ? h1.nextSibling : null);
    }
    const act = household()?.id;
    el.innerHTML = l.map(h => `<button type="button" class="chip" aria-pressed="${h.id === act}" data-hh="${h.id}">🏠 ${esc(nameOf(h))}</button>`).join('');
    el.querySelectorAll('[data-hh]').forEach(b => b.onclick = () => { if (b.dataset.hh !== act) hhSync.switchTo(b.dataset.hh); });
  }

  // Diese Seite zeigt eine Liste → als „gesehen“ melden (beim Öffnen und wenn Neues ankommt)
  let seenList = null;
  function markSeen(keys) {
    seenList = keys;
    if (!db || !hid || document.visibilityState === 'hidden') return;
    clearTimeout(seenTimer);
    seenTimer = setTimeout(() => {
      const now = Date.now(), patch = {}; [].concat(keys).forEach(k => patch[col(k)] = now);
      const me = localStorage.getItem('hh-me-name'); if (me) patch.name = me;
      seen[user.uid] = { ...(seen[user.uid] || {}), ...patch };
      fb.setDoc(fb.doc(db, 'households', hid, 'seen', user.uid), patch, { merge: true }).catch(() => {});
    }, 800);
  }
  document.addEventListener('visibilitychange', () => { if (seenList && document.visibilityState === 'visible') markSeen(seenList); });
  window.addEventListener('hh-sync', e => { if (seenList && e.detail?.key !== 'seen' && [].concat(seenList).includes(e.detail?.key)) markSeen(seenList); });
  // ✓ = einer hat es gesehen, ✓✓ = alle im Haushalt (wer es eingetragen hat, hat es natürlich gesehen)
  function ticks(item, key) {
    if (!hid || memberIds.length < 2 || !item) return '';
    const t = item.createdAt || item.updatedAt || 0;
    const n = memberIds.filter(u => u === item.by || ((seen[u] || {})[col(key)] || 0) >= t).length;
    if (!n) return '';
    const all = n >= memberIds.length;
    return `<span class="seen${all ? ' all' : ''}" title="${all ? 'Von allen gesehen' : `Von ${n} gesehen`}" aria-label="${all ? 'Von allen gesehen' : `Von ${n} von ${memberIds.length} gesehen`}">${all ? '✓✓' : '✓'}</span>`;
  }

  // Personen im Haushalt (Name kommt aus „Dein Name“ in den Einstellungen)
  const myId = () => user?.uid || localStorage.getItem('hh-uid') || 'me';
  function people() {
    const me = localStorage.getItem('hh-me-name') || '';
    const out = [];
    for (const u of memberIds) { const n = u === myId() ? me : (seen[u] || {}).name; if (n) out.push({ uid: u, name: n, me: u === myId() }); }
    if (!out.some(p => p.me) && me) out.unshift({ uid: myId(), name: me, me: true });
    return out;
  }
  async function setMyName(name) {
    localStorage.setItem('hh-me-name', name);
    if (!db) return;
    for (const h of households()) { try { await fb.setDoc(fb.doc(db, 'households', h.id, 'seen', user.uid), { name }, { merge: true }); } catch {} }
  }

  const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');

  window.hhSync = {
    status: () => ({ ...status }),
    configured, household, households, nameOf, flush, start, markSeen, ticks, people, myId, setMyName,
    active: () => households().find(h => h.id === household()?.id) || null,
    inviteLink(id = household()?.id) { return id ? new URL(`./?join=${id}`, location.href).href : ''; },
    async create(name) {
      await boot(); const id = newId(); const first = !household();
      await fb.setDoc(fb.doc(db, 'households', id), { members: [user.uid], name: name || '', geminiKey: getCfg().key || '', createdAt: Date.now() });
      activate(id, { fresh: !first });
      setHouseholds([...households().filter(h => h.id !== id), { id, name: name || '' }]);
      if (first) markAllDirty();
      await start(); return id;
    },
    parseId: idOrLink => String(idOrLink || '').trim().match(/(?:join=)?([a-z0-9]{20,})\s*$/i)?.[1] || '',
    // Einladung ansehen, ohne beizutreten (Name des Haushalts für den Willkommens-Dialog)
    async peek(idOrLink) {
      const id = this.parseId(idOrLink); if (!id) throw new Error('Das sieht nicht wie ein Einladungslink aus.');
      await boot();
      const snap = await fb.getDoc(fb.doc(db, 'households', id)).catch(e => { throw new Error(friendly(e)); });
      if (!snap.exists()) throw new Error('Diese Einladung gibt es nicht (mehr).');
      return { id, name: snap.data().name || '', members: (snap.data().members || []).length };
    },
    async join(idOrLink) {
      const id = this.parseId(idOrLink);
      if (!id) throw new Error('Das sieht nicht wie ein Einladungslink aus.');
      if (households().some(h => h.id === id)) { if (household()?.id !== id) await this.switchTo(id, { noReload: true }); return id; }
      await boot();
      const ref = fb.doc(db, 'households', id);
      const snap = await fb.getDoc(ref).catch(e => { throw new Error(friendly(e)); });
      if (!snap.exists()) throw new Error('Diese Einladung gibt es nicht (mehr).');
      if (!(snap.data().members || []).includes(user.uid)) await fb.updateDoc(ref, { members: fb.arrayUnion(user.uid) });
      const k = snap.data().geminiKey; if (k && !getCfg().key) setCfg({ key: k });
      const first = !household();
      activate(id, { fresh: !first });
      setHouseholds([...households().filter(h => h.id !== id), { id, name: snap.data().name || '' }]);
      if (first) markAllDirty();
      await start(); return id;
    },
    async switchTo(id, { noReload = false } = {}) {
      if (!households().some(h => h.id === id)) return;
      unsubs.splice(0).forEach(u => u()); seen = {}; memberIds = [];
      activate(id); hid = null;
      if (noReload) await start(); else location.reload();
    },
    async rename(name) {
      const h = household(); if (!h) return;
      const l = households(); const x = l.find(y => y.id === h.id); if (x) { x.name = name; setHouseholds(l); }
      renderSwitcher();
      try { await boot(); await fb.updateDoc(fb.doc(db, 'households', h.id), { name }); } catch (e) { setStatus({ state: 'error', error: friendly(e) }); }
    },
    async leave() {
      const h = household(); if (!h) return;
      try { await boot(); await fb.updateDoc(fb.doc(db, 'households', h.id), { members: fb.arrayRemove(user.uid) }); } catch {}
      unsubs.splice(0).forEach(u => u()); hid = null;
      const rest = households().filter(x => x.id !== h.id); setHouseholds(rest);
      if (rest.length) { localStorage.removeItem(HH); unstash(rest[0].id); save(HH, { id: rest[0].id, since: Date.now() }); await start(); }
      else { localStorage.removeItem(HH); localStorage.removeItem(DIRTY_KEY); renderSwitcher(); setStatus({ state: 'off', members: 0 }); }
    },
    async pushKey(key) {
      if (!db) return;
      for (const h of households()) { try { await fb.updateDoc(fb.doc(db, 'households', h.id), { geminiKey: key || '' }); } catch {} }
    },
  };
  window.addEventListener('online', flushAll);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
