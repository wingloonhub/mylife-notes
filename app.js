// ============================================================
//  MyLife Hub — app.js  (vanilla JS, no build step)
// ============================================================
import { FIREBASE } from './firebase-config.js';

/* ---------------- tiny DOM helper ---------------- */
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) for (const k in props) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v);
  }
  add(e, kids);
  return e;
}
function add(parent, kids) {
  for (const k of kids.flat()) {
    if (k == null || k === false) continue;
    parent.appendChild(typeof k === 'object' ? k : document.createTextNode(String(k)));
  }
}
const $app = () => document.getElementById('app');
function mount(node) { const a = $app(); a.innerHTML = ''; a.appendChild(node); window.scrollTo(0, 0); }

function toast(msg) {
  const t = h('div', { class: 'toast' }, msg);
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, 2200);
}

/* ---------------- image compression ---------------- */
function compressImage(file, maxDim = 1000, quality = 0.5) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) { height = Math.round(height * maxDim / width); width = maxDim; }
        else if (height > maxDim) { width = Math.round(width * maxDim / height); height = maxDim; }
        const c = document.createElement('canvas');
        c.width = width; c.height = height;
        c.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ============================================================
   STORAGE ADAPTER  —  Firebase mode OR Local mode
   ============================================================ */
let MODE = 'local';
let fb = null;            // firebase handles
let CURRENT = null;       // {uid, email}
const imgCache = new Map();

async function initStorage() {
  // On localhost we always use local mode (with auto-login) for easy testing —
  // so firebase-config.js can stay ENABLED:true and the deployed site still syncs.
  const isLocalhost = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  if (!isLocalhost && FIREBASE.ENABLED && FIREBASE.config && !String(FIREBASE.config.apiKey).startsWith('PASTE')) {
    try {
      const appMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
      const authMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
      const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const app = appMod.initializeApp(FIREBASE.config);
      fb = { auth: authMod.getAuth(app), db: fsMod.getFirestore(app), a: authMod, f: fsMod };
      MODE = 'firebase';
      return;
    } catch (e) {
      console.error('Firebase init failed, falling back to local mode', e);
    }
  }
  MODE = 'local';
}

/* ---- local helpers ---- */
const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
};
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

/* ---------------- AUTH ---------------- */
const Auth = {
  onChange(cb) {
    if (MODE === 'firebase') {
      fb.a.onAuthStateChanged(fb.auth, u => {
        CURRENT = u ? { uid: u.uid, email: u.email } : null;
        cb(CURRENT);
      });
    } else {
      const s = LS.get('mln_session', null);
      CURRENT = s;
      cb(CURRENT);
    }
  },
  async signUp(email, pass) {
    email = email.trim().toLowerCase();
    if (MODE === 'firebase') {
      await fb.a.createUserWithEmailAndPassword(fb.auth, email, pass);
      return;
    }
    const users = LS.get('mln_users', {});
    if (users[email]) throw new Error('An account with this email already exists.');
    users[email] = { hash: await sha256(email + '::' + pass) };
    LS.set('mln_users', users);
    CURRENT = { uid: 'local_' + (await sha256(email)).slice(0, 16), email };
    LS.set('mln_session', CURRENT);
    routeChanged();
  },
  async signIn(email, pass) {
    email = email.trim().toLowerCase();
    if (MODE === 'firebase') {
      await fb.a.signInWithEmailAndPassword(fb.auth, email, pass);
      return;
    }
    const users = LS.get('mln_users', {});
    const u = users[email];
    if (!u || u.hash !== await sha256(email + '::' + pass)) throw new Error('Wrong email or password.');
    CURRENT = { uid: 'local_' + (await sha256(email)).slice(0, 16), email };
    LS.set('mln_session', CURRENT);
    routeChanged();
  },
  async reset(email, newPass) {
    email = email.trim().toLowerCase();
    if (MODE === 'firebase') {
      await fb.a.sendPasswordResetEmail(fb.auth, email);
      return { emailed: true };
    }
    const users = LS.get('mln_users', {});
    if (!users[email]) throw new Error('No account found with this email on this device.');
    if (!newPass || newPass.length < 6) throw new Error('New password must be at least 6 characters.');
    users[email] = { hash: await sha256(email + '::' + newPass) };
    LS.set('mln_users', users);
    return { emailed: false };
  },
  async signOut() {
    if (MODE === 'firebase') { await fb.a.signOut(fb.auth); }
    else { localStorage.removeItem('mln_session'); CURRENT = null; routeChanged(); }
    imgCache.clear();
  }
};

/* ---------------- DATA ---------------- */
/* categories that can be shared live across accounts (via the top-level `shared` collection) */
const SHARE_CATS = ['party', 'trips'];
function myEmail() { return ((CURRENT && CURRENT.email) || '').trim().toLowerCase(); }
function cleanEmails(arr) { return Array.from(new Set((arr || []).map(e => String(e).trim().toLowerCase()).filter(Boolean))); }

const DB = {
  async listItems(cat) {
    if (MODE === 'firebase') {
      const { collection, getDocs, query, where } = fb.f;
      const snap = await getDocs(query(collection(fb.db, 'users', CURRENT.uid, 'items'), where('cat', '==', cat)));
      const byId = {};
      snap.forEach(d => byId[d.id] = { id: d.id, ...d.data() });
      // merge in shared items of this category (mine-and-shared, or shared with me)
      if (SHARE_CATS.includes(cat)) {
        try {
          const ss = await getDocs(query(collection(fb.db, 'shared'), where('participants', 'array-contains', myEmail())));
          ss.forEach(d => {
            const v = d.data();
            if (v.cat !== cat) return;
            byId[d.id] = { id: d.id, cat: v.cat, data: v.data, updatedAt: v.updatedAt, _shared: true, _ownerUid: v.ownerUid, _ownerEmail: v.ownerEmail, _amOwner: v.ownerUid === CURRENT.uid };
          });
        } catch (e) { /* shared collection may need its rule/index — fall back to private only */ }
      }
      return Object.values(byId).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }
    const all = LS.get('mln_items_' + CURRENT.uid, []);
    return all.filter(i => i.cat === cat).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  },
  async getItem(cat, id) {
    if (MODE === 'firebase') {
      const { doc, getDoc } = fb.f;
      const d = await getDoc(doc(fb.db, 'users', CURRENT.uid, 'items', id));
      if (d.exists()) return { id: d.id, ...d.data() };
      if (SHARE_CATS.includes(cat)) {
        try {
          const s = await getDoc(doc(fb.db, 'shared', id));
          if (s.exists()) { const v = s.data(); return { id: s.id, cat: v.cat, data: v.data, updatedAt: v.updatedAt, _shared: true, _ownerUid: v.ownerUid, _ownerEmail: v.ownerEmail, _amOwner: v.ownerUid === CURRENT.uid }; }
        } catch (e) {}
      }
      return null;
    }
    return LS.get('mln_items_' + CURRENT.uid, []).find(i => i.id === id) || null;
  },
  async saveItem(item) {
    item.updatedAt = Date.now();
    if (!item.id) item.id = uid();
    const sharedWith = (item.data && cleanEmails(item.data.sharedWith)) || [];
    const isShareable = SHARE_CATS.includes(item.cat);
    if (MODE === 'firebase') {
      const { doc, setDoc, deleteDoc } = fb.f;
      if (isShareable && sharedWith.length) {
        // live-shared: store in the top-level `shared` collection
        const ownerUid = item._ownerUid || CURRENT.uid;
        const ownerEmail = item._ownerEmail || myEmail();
        if (item.data) item.data.sharedWith = sharedWith;
        const participants = cleanEmails([ownerEmail, ...sharedWith]);
        await setDoc(doc(fb.db, 'shared', item.id), { cat: item.cat, data: item.data, ownerUid, ownerEmail, participants, updatedAt: item.updatedAt }, { merge: true });
        // if I own it and a private copy lingers, remove it
        if (ownerUid === CURRENT.uid) { try { await deleteDoc(doc(fb.db, 'users', CURRENT.uid, 'items', item.id)); } catch (e) {} }
      } else {
        // private
        const { id, _shared, _ownerUid, _ownerEmail, _amOwner, ...rest } = item;
        await setDoc(doc(fb.db, 'users', CURRENT.uid, 'items', id), rest, { merge: true });
        // if it used to be shared (now un-shared), remove the shared copy
        if (isShareable) { try { await deleteDoc(doc(fb.db, 'shared', id)); } catch (e) {} }
      }
    } else {
      const key = 'mln_items_' + CURRENT.uid;
      const all = LS.get(key, []);
      const idx = all.findIndex(i => i.id === item.id);
      if (idx >= 0) all[idx] = item; else all.push(item);
      LS.set(key, all);
    }
    return item;
  },
  async deleteItem(cat, id) {
    if (MODE === 'firebase') {
      const { doc, deleteDoc } = fb.f;
      try { await deleteDoc(doc(fb.db, 'users', CURRENT.uid, 'items', id)); } catch (e) {}
      if (SHARE_CATS.includes(cat)) { try { await deleteDoc(doc(fb.db, 'shared', id)); } catch (e) {} }
    } else {
      const key = 'mln_items_' + CURRENT.uid;
      LS.set(key, LS.get(key, []).filter(i => i.id !== id));
    }
  },
  /* live listener on shared items I'm part of — fires cb whenever any of them change */
  watchShared(cb) {
    if (MODE !== 'firebase') return () => {};
    try {
      const { collection, query, where, onSnapshot } = fb.f;
      return onSnapshot(query(collection(fb.db, 'shared'), where('participants', 'array-contains', myEmail())), () => cb(), () => {});
    } catch (e) { return () => {}; }
  },
  /* images stored separately to dodge document-size limits */
  async saveImage(dataUrl) {
    const id = uid();
    if (MODE === 'firebase') {
      const { doc, setDoc } = fb.f;
      await setDoc(doc(fb.db, 'users', CURRENT.uid, 'images', id), { d: dataUrl });
    } else {
      const imgs = LS.get('mln_images_' + CURRENT.uid, {});
      imgs[id] = dataUrl;
      LS.set('mln_images_' + CURRENT.uid, imgs);
    }
    imgCache.set(id, dataUrl);
    return id;
  },
  async getImage(id) {
    if (!id) return null;
    if (imgCache.has(id)) return imgCache.get(id);
    let d = null;
    if (MODE === 'firebase') {
      const { doc, getDoc } = fb.f;
      const s = await getDoc(doc(fb.db, 'users', CURRENT.uid, 'images', id));
      d = s.exists() ? s.data().d : null;
    } else {
      d = LS.get('mln_images_' + CURRENT.uid, {})[id] || null;
    }
    if (d) imgCache.set(id, d);
    return d;
  },
  /* shopping saved-items library (simple string list) */
  async getLibrary() {
    const it = await this.getItem('_library', '_shopping_lib');
    return it ? it.data.items : [];
  },
  async setLibrary(items) {
    await this.saveItem({ id: '_shopping_lib', cat: '_library', data: { items } });
  },
  /* app settings */
  async getSettings() {
    const it = await this.getItem('_settings', '_settings');
    return Object.assign({ leadMinutes: 60, notify: false, telegramChatId: '', telegramToken: '', todoLeadDays: 0, scheduleLeadMinutes: 60 }, it ? it.data : {});
  },
  async saveSettings(data) {
    await this.saveItem({ id: '_settings', cat: '_settings', data });
  },
  /* shopping categories (e.g. hotpot, bbq) */
  async getShopCats() {
    const it = await this.getItem('_shopcats', '_shopcats');
    return it ? (it.data.items || []) : [];
  },
  async setShopCats(items) {
    await this.saveItem({ id: '_shopcats', cat: '_shopcats', data: { items } });
  },
  /* shared cards: a public top-level "shares" collection anyone with the code can read */
  async createShare(payload) {
    const code = uid() + uid();
    if (MODE === 'firebase') {
      const { doc, setDoc } = fb.f;
      await setDoc(doc(fb.db, 'shares', code), Object.assign({ at: Date.now() }, payload));
    } else {
      const all = LS.get('mln_shares', {});
      all[code] = Object.assign({ at: Date.now() }, payload);
      LS.set('mln_shares', all);
    }
    return code;
  },
  async getShare(code) {
    if (MODE === 'firebase') {
      const { doc, getDoc } = fb.f;
      const s = await getDoc(doc(fb.db, 'shares', code));
      return s.exists() ? s.data() : null;
    }
    return LS.get('mln_shares', {})[code] || null;
  }
};

/* ============================================================
   CATEGORIES
   ============================================================ */
const CATS = [
  { key: 'quick', name: 'Quick Note', emoji: '📝' },
  { key: 'todo', name: 'To-Do List', emoji: '✅' },
  { key: 'events', name: 'Events', emoji: '📅' },
  { key: 'schedule', name: 'Weekly Schedule', emoji: '🕒' },
  { key: 'records', name: 'Personal Records', emoji: '🔐' },
  { key: 'memberships', name: 'Memberships', emoji: '💳' },
  { key: 'tax', name: 'Tax Receipts', emoji: '💵' },
  { key: 'party', name: 'Party Planner', emoji: '🎉' },
  { key: 'trips', name: 'Trip Planner', emoji: '🧳' },
  { key: 'shopping', name: 'Grocery Planner', emoji: '🛒' },
  { key: 'shopitem', name: 'Saved Item', emoji: '🏷️', hidden: true },
  { key: 'tripcat', name: 'Trip Area', emoji: '🏷️', hidden: true },
  { key: 'recipes', name: 'Recipes', emoji: '🍳' },
  { key: 'warranty', name: 'Warranty Tracker', emoji: '🧾' }
];
const catName = k => (CATS.find(c => c.key === k) || {}).name || k;

/* ---------------- generic form widgets ---------------- */
function field(label, obj, key, opts = {}) {
  const input = opts.type === 'textarea'
    ? h('textarea', { placeholder: opts.placeholder || '', oninput: e => obj[key] = e.target.value }, obj[key] || '')
    : h('input', {
        type: opts.type || 'text', placeholder: opts.placeholder || '',
        inputmode: opts.inputmode, step: opts.step,
        class: key === 'title' ? 'title-input' : null,
        autocapitalize: /^(email|url|tel|password)$/.test(opts.type || '') ? 'none' : (key === 'title' ? 'words' : null),
        value: obj[key] != null ? obj[key] : '',
        oninput: e => obj[key] = opts.type === 'number' ? e.target.value : e.target.value
      });
  return h('div', { class: 'field' },
    label && h('label', null, label),
    input,
    opts.hint && h('div', { class: 'hint' }, opts.hint));
}
function selectField(label, obj, key, options, onchange) {
  const sel = h('select', {
    onchange: e => { obj[key] = e.target.value; onchange && onchange(e.target.value); }
  }, options.map(o => h('option', { value: o.value, selected: obj[key] === o.value ? 'selected' : null }, o.label)));
  if (obj[key] == null) obj[key] = options[0].value;
  return h('div', { class: 'field' }, label && h('label', null, label), sel);
}
function toggleField(label, obj, key) {
  const btn = h('button', { class: 'btn small ' + (obj[key] ? '' : 'secondary'), type: 'button' },
    obj[key] ? '★ Favourite' : '☆ Mark favourite');
  btn.onclick = () => { obj[key] = !obj[key]; btn.className = 'btn small ' + (obj[key] ? '' : 'secondary'); btn.textContent = obj[key] ? '★ Favourite' : '☆ Mark favourite'; };
  return h('div', { class: 'field' }, btn);
}

/* editable list of simple strings */
function stringList(obj, key, placeholder) {
  if (!Array.isArray(obj[key])) obj[key] = [];
  const wrap = h('div');
  function draw() {
    wrap.innerHTML = '';
    obj[key].forEach((val, i) => {
      const inp = h('input', { value: val, placeholder, oninput: e => obj[key][i] = e.target.value });
      const row = h('div', { class: 'field', style: { marginBottom: '8px' } },
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          inp,
          h('button', { class: 'del-x', type: 'button', onclick: () => { if (!confirmDel('Remove this item?')) return; obj[key].splice(i, 1); draw(); } }, '✕')));
      wrap.appendChild(row);
    });
    wrap.appendChild(h('button', { class: 'btn ghost', type: 'button', onclick: () => { obj[key].push(''); draw(); } }, '+ Add'));
  }
  draw();
  return wrap;
}

/* "Share with" editor: a list of people's login emails. onChange (optional) fires after each change. */
function shareWithEditor(obj, onChange) {
  if (!Array.isArray(obj.sharedWith)) obj.sharedWith = [];
  const wrap = h('div');
  const changed = () => { if (onChange) onChange(); };
  function draw() {
    wrap.innerHTML = '';
    obj.sharedWith.forEach((em, i) => {
      wrap.appendChild(h('div', { class: 'field', style: { marginBottom: '8px' } },
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('input', { class: 'grow', type: 'email', autocapitalize: 'none', inputmode: 'email', placeholder: 'their login email (e.g. name@gmail.com)',
            value: em, oninput: e => { obj.sharedWith[i] = e.target.value.trim().toLowerCase(); changed(); } }),
          h('button', { class: 'del-x', type: 'button', onclick: () => { obj.sharedWith.splice(i, 1); draw(); changed(); } }, '✕'))));
    });
    wrap.appendChild(h('button', { class: 'btn ghost', type: 'button', onclick: () => { obj.sharedWith.push(''); draw(); changed(); } }, '+ Add person'));
  }
  draw();
  return wrap;
}

/* single image picker -> stores image id in obj[key] */
function imagePicker(obj, key) {
  if (!Array.isArray(obj[key])) obj[key] = obj[key] ? [obj[key]] : [];
  return imageMulti(obj, key, false);
}
function imageMulti(obj, key, multiple = true, opts = {}) {
  if (!Array.isArray(obj[key])) obj[key] = [];
  const box = h('div', { class: 'imgbox' + (opts.compact ? ' compact' : '') });
  function uploadTile(icon, capture) {
    const props = { type: 'file', accept: 'image/*',
      onchange: async e => {
        const f = e.target.files[0]; if (!f) return;
        const lbl = e.target.closest('.upload'); if (lbl) lbl.textContent = '…';
        const data = await compressImage(f);
        const imgId = await DB.saveImage(data);
        obj[key].push(imgId); draw();
      } };
    if (capture) props.capture = 'environment';
    return h('label', { class: 'upload' }, icon, h('input', props));
  }
  async function draw() {
    box.innerHTML = '';
    for (const id of obj[key]) {
      const src = await DB.getImage(id);
      box.appendChild(h('div', { class: 'img-wrap' },
        h('img', { src: src || '', onclick: () => src && openLightbox(src) }),
        h('button', { class: 'rm', type: 'button', onclick: () => { if (!confirmDel('Remove this photo?')) return; obj[key] = obj[key].filter(x => x !== id); draw(); } }, '✕')));
    }
    if (multiple || obj[key].length === 0) {
      box.appendChild(uploadTile('📷', true));  // take a photo (camera)
      box.appendChild(uploadTile('+', false));   // choose existing
    }
  }
  draw();
  return box;
}

/* ---------------- per-category EDITORS ----------------
   each returns a DOM fragment; inputs mutate `data` directly */
function buildEditor(cat, data, amOwner) {
  if (amOwner === undefined) amOwner = true;
  const F = h('div');
  const a = (...n) => add(F, n);
  switch (cat) {
    case 'recipes': {
      a(field('Recipe title', data, 'title', { placeholder: 'e.g. Chicken Rice' }));
      a(h('div', { class: 'section-title' }, 'Finished dish photo'));
      a(h('div', { class: 'hint', style: { margin: '2px 2px 8px' } }, 'Snap or add the ready dish — this is the photo shown on the Recipes page.'));
      a(imagePicker(data, 'images'));
      a(h('div', { class: 'section-title' }, 'Ingredients'));
      a(h('div', { class: 'hint', style: { margin: '2px 2px 10px' } }, 'Add a photo to each ingredient if you like — or leave it empty.'));
      a(ingredientsEditor(data));
      a(h('div', { class: 'section-title' }, 'Cooking steps'));
      a(stepsEditor(data));
      a(h('div', { class: 'section-title' }, 'Links'));
      a(field('Video URL', data, 'videoUrl', { type: 'url', placeholder: 'https://youtube.com/…' }));
      a(field('Reference URL', data, 'refUrl', { type: 'url', placeholder: 'https://…' }));
      a(h('div', { class: 'section-title' }, 'Where to buy'));
      a(whereToBuyEditor(data));
      a(h('div', { class: 'section-title' }, 'Notes'));
      a(field('My notes', data, 'notes', { type: 'textarea', placeholder: 'Anything you want to remember…' }));
      break;
    }
    case 'records': {
      a(selectField('Record type', data, 'recType',
        [{ value: 'bank', label: 'Bank account' }, { value: 'address', label: 'Address' }],
        () => rerenderEditor(cat, data)));
      a(field('Label', data, 'title', { placeholder: data.recType === 'address' ? 'e.g. Home address' : 'e.g. Maybank savings' }));
      if (data.recType === 'address') {
        a(field('Recipient name', data, 'recipient', {}));
        a(field('Full address', data, 'address', { type: 'textarea', placeholder: 'Street, city, postcode, country' }));
        a(field('Phone', data, 'phone', { type: 'tel' }));
      } else {
        a(field('Bank name', data, 'bank', {}));
        a(field('Account name', data, 'accName', {}));
        a(field('Account number', data, 'accNo', { inputmode: 'numeric' }));
        a(field('SWIFT / extra', data, 'swift', {}));
      }
      a(field('Notes', data, 'notes', { type: 'textarea' }));
      break;
    }
    case 'memberships': {
      a(field('Title', data, 'title', { placeholder: 'e.g. Golf Club / AIA' }));
      a(field('Member name', data, 'member', {}));
      a(field('Membership number', data, 'number', {}));
      a(h('div', { class: 'section-title' }, 'Card / screenshot'));
      a(imagePicker(data, 'images'));
      a(field('Notes', data, 'notes', { type: 'textarea' }));
      break;
    }
    case 'party': {
      a(field('Party event name', data, 'title', { placeholder: "e.g. Preston's birthday" }));
      if (amOwner) {
        a(h('div', { class: 'section-title' }, 'Share this party with (live)'));
        a(h('div', { class: 'hint', style: { margin: '2px 2px 8px' } }, 'Add the login email of anyone you want to see & edit this party in real time. Leave empty to keep it private.'));
        a(shareWithEditor(data));
      } else {
        a(h('div', { class: 'hint', style: { margin: '2px 2px 8px' } }, '👥 Shared with you — you can edit the details; only the owner can change who it\'s shared with.'));
      }
      a(h('div', { class: 'row2' },
        h('div', { class: 'field' }, h('label', null, 'Event date'), h('input', { type: 'date', value: data.eventDate || '', oninput: e => data.eventDate = e.target.value })),
        h('div', { class: 'field' }, h('label', null, 'Start time'), h('input', { type: 'time', value: data.startTime || '', oninput: e => data.startTime = e.target.value }))));
      a(selectField('Location', data, 'locType',
        [{ value: 'My house', label: 'My house' }, { value: 'Other', label: 'Other location' }],
        () => rerenderEditor(cat, data)));
      if (data.locType === 'Other') a(field('Where', data, 'location', { placeholder: 'Venue / address' }));
      const totalSpan = h('span');
      const updTotal = () => {
        const ad = parseInt(data.adults) || 0, kd = parseInt(data.kids) || 0;
        totalSpan.textContent = (ad + kd) + ' pax — ' + ad + ' adults; ' + kd + ' kids';
      };
      const numInput = (key) => h('input', { type: 'number', inputmode: 'numeric', placeholder: '0',
        value: data[key] != null ? data[key] : '', oninput: e => { data[key] = e.target.value; updTotal(); } });
      a(h('div', { class: 'row2' },
        h('div', { class: 'field' }, h('label', null, 'Adults'), numInput('adults')),
        h('div', { class: 'field' }, h('label', null, 'Kids'), numInput('kids'))));
      updTotal();
      a(h('div', { class: 'field' }, h('label', null, 'Total guests'), h('div', { class: 'total-box' }, totalSpan)));
      a(field('Budget', data, 'budget', { placeholder: 'RM' }));
      a(field('Theme', data, 'theme', {}));
      a(h('div', { class: 'section-title' }, 'Guest list'));
      a(stringList(data, 'guestList', 'Guest name'));
      a(h('div', { class: 'section-title' }, 'Food menu'));
      a(foodMenuEditor(data));
      a(h('div', { class: 'section-title' }, 'Drinks'));
      a(stringList(data, 'drinks', 'e.g. Orange juice'));
      a(h('div', { class: 'section-title' }, 'Items to prepare'));
      a(stringList(data, 'toPrepare', 'e.g. Balloons'));
      a(h('div', { class: 'section-title' }, 'Items to buy'));
      a(stringList(data, 'toBuy', 'e.g. Paper cups'));
      a(h('div', { class: 'section-title' }, 'Games'));
      a(stringList(data, 'games', 'e.g. Musical chairs'));
      break;
    }
    case 'warranty': {
      a(field('Item name', data, 'title', { placeholder: 'e.g. Samsung TV' }));
      a(field('Shop', data, 'shop', { placeholder: 'Where you bought it' }));
      a(h('div', { class: 'row2' },
        field('Purchased on', data, 'boughtDate', { type: 'date' }),
        field('Warranty expiry', data, 'expiry', { type: 'date' })));
      a(h('div', { class: 'section-title' }, 'Receipt / photo'));
      a(imagePicker(data, 'images'));
      a(field('Notes', data, 'notes', { type: 'textarea' }));
      break;
    }
    case 'tax': {
      a(field('Title', data, 'title', { placeholder: 'e.g. Dental — scaling' }));
      a(selectField('Category', data, 'taxCat',
        [{ value: '', label: '— Select —' }, { value: 'Dental', label: 'Dental' }, { value: 'Lifestyle', label: 'Lifestyle' }, { value: 'Other', label: 'Other' }]));
      a(field('Invoice date', data, 'invoiceDate', { type: 'date' }));
      a(h('div', { class: 'row2' },
        field('Year', data, 'year', { type: 'number', inputmode: 'numeric', placeholder: '2026' }),
        field('Amount (RM)', data, 'amount', { type: 'number', inputmode: 'decimal', placeholder: '0.00' })));
      a(h('div', { class: 'section-title' }, 'Receipt photo'));
      a(imagePicker(data, 'images'));
      a(field('Notes', data, 'notes', { type: 'textarea' }));
      break;
    }
    case 'todo': {
      a(field('List title', data, 'title', { placeholder: 'e.g. Today' }));
      a(h('div', { class: 'section-title' }, 'To-do items (each can have its own due date)'));
      a(h('div', { class: 'hint', style: { margin: '2px 2px 10px' } }, 'Set a reminder cadence in ⚙ Settings.'));
      a(todoItemsEditor(data));
      break;
    }
    case 'trips': {
      a(field('Trip name', data, 'title', { placeholder: 'e.g. Japan' }));
      a(tripDates(data));
      a(field('Notes', data, 'notes', { placeholder: 'e.g. flight & hotel details' }));
      if (amOwner) {
        a(h('div', { class: 'section-title' }, 'Share this trip with (live)'));
        a(h('div', { class: 'hint', style: { margin: '2px 2px 8px' } }, 'Add the login email of anyone you want to see & edit this trip in real time. Leave empty to keep it private.'));
        a(shareWithEditor(data));
      } else {
        a(h('div', { class: 'hint', style: { margin: '2px 2px 8px' } }, '👥 Shared with you — you can edit the details; only the owner can change who it\'s shared with.'));
      }
      a(h('div', { class: 'section-title' }, 'Which areas? (beach, city, camping…)'));
      a(tripCategoryPicker(data));
      a(h('div', { class: 'section-title' }, 'Packing list (tick when packed in the trip view)'));
      a(checklistEditor(data, 'items', 'Item to bring'));
      break;
    }
    case 'tripcat': {
      a(field('Area / type', data, 'title', { placeholder: 'e.g. Beach' }));
      a(h('div', { class: 'section-title' }, 'Items to bring for this area'));
      a(stringList(data, 'items', 'e.g. Sunscreen'));
      break;
    }
    case 'shopping': {
      a(field('List name', data, 'title', { placeholder: 'e.g. Weekly groceries' }));
      a(h('div', { class: 'section-title' }, 'Items'));
      a(shoppingEditor(data));
      break;
    }
    case 'shopitem': {
      a(field('Item name', data, 'title', { placeholder: 'e.g. Olive oil' }));
      a(field('Brand', data, 'brand', { placeholder: 'e.g. Bertolli' }));
      a(field('Sold per (unit)', data, 'unit', { placeholder: 'e.g. bottle, kg, 500g', hint: 'Prices below are compared per this unit.' }));
      a(shopCategoryField(data));
      a(field('Notes', data, 'notes', { type: 'textarea', placeholder: 'Any notes…' }));
      a(h('div', { class: 'section-title' }, 'Picture of item'));
      a(imagePicker(data, 'images'));
      a(h('div', { class: 'section-title' }, 'Price per unit, by shop (add as many as you like to compare)'));
      a(pricesEditor(data));
      break;
    }
    case 'quick': {
      a(field('Title', data, 'title', { placeholder: 'Title' }));
      a(h('div', { class: 'section-title' }, 'Note'));
      a(richTextEditor(data, 'bodyHtml', data.body));
      break;
    }
    case 'events': {
      a(field('Event title', data, 'title', { placeholder: 'e.g. Dentist appointment' }));
      a(field('Date & time', data, 'when', { type: 'datetime-local', hint: 'Moves to the Archive tab the day after.' }));
      a(field('Location name', data, 'location', { placeholder: 'e.g. Sunway Lagoon' }));
      a(mapFieldBlock(data));
      a(field('Notes', data, 'notes', { type: 'textarea' }));
      a(h('div', { class: 'section-title' }, 'Reminder'));
      a(field('Remind me at', data, 'remindAt', { type: 'datetime-local' }));
      a(h('div', { class: 'field' },
        (() => {
          const b = h('button', { class: 'btn small ' + (data.telegram ? '' : 'secondary'), type: 'button' },
            data.telegram ? '✓ Send to Telegram' : 'Send reminder to Telegram');
          b.onclick = () => { data.telegram = !data.telegram; b.className = 'btn small ' + (data.telegram ? '' : 'secondary'); b.textContent = data.telegram ? '✓ Send to Telegram' : 'Send reminder to Telegram'; };
          return b;
        })(),
        h('div', { class: 'hint' }, 'Telegram delivery is activated once the scheduler is connected (see README).')));
      break;
    }
    case 'schedule': {
      a(field('Title', data, 'title', { placeholder: 'e.g. Piano class' }));
      a(field('Location name', data, 'location', { placeholder: 'e.g. Armanee Terrace' }));
      a(mapFieldBlock(data));
      a(h('div', { class: 'section-title' }, 'Weekly sessions'));
      a(slotsEditor(data));
      a(h('div', { class: 'section-title' }, 'How long does this run?'));
      a(selectField('Repeat', data, 'repeatMode',
        [{ value: 'forever', label: 'Every week — no end date' }, { value: 'until', label: 'Until a specific date' }],
        () => rerenderEditor('schedule', data)));
      if (data.repeatMode === 'until') a(field('End date', data, 'until', { type: 'date', hint: 'Reminders stop after this date.' }));
      a(field('Notes', data, 'notes', { type: 'textarea' }));
      break;
    }
  }
  return F;
}

/* Google Maps field with live coordinate lookup (shared by Events + Weekly Schedule) */
function mapFieldBlock(data) {
  const frag = h('div');
  const mapStatus = h('div', { class: 'hint', style: { margin: '4px 2px 12px' } },
    (typeof data.lat === 'number') ? ('📍 Coordinates: ' + data.lat.toFixed(5) + ', ' + data.lng.toFixed(5)) : '');
  const mapInput = h('input', { type: 'url', inputmode: 'url', autocapitalize: 'none',
    placeholder: 'Paste Google Maps link / address / 3.05,101.69', value: data.map || '' });
  let mapTimer = null;
  const resolveMap = async () => {
    const q = (mapInput.value || '').trim();
    data.map = q;
    if (!q) { mapStatus.textContent = ''; delete data.lat; delete data.lng; delete data._coordSrc; return; }
    mapStatus.textContent = '📍 Looking up coordinates…';
    const c = await resolveCoords(q);
    if (c) { data.lat = c[0]; data.lng = c[1]; data._coordSrc = q; mapStatus.innerHTML = '📍 Coordinates: <b>' + c[0].toFixed(5) + ', ' + c[1].toFixed(5) + '</b>'; }
    else { delete data.lat; delete data.lng; delete data._coordSrc; mapStatus.textContent = "Couldn't read this. Try the full Google Maps URL, an address, or coordinates."; }
  };
  mapInput.addEventListener('input', () => { data.map = mapInput.value; clearTimeout(mapTimer); mapTimer = setTimeout(resolveMap, 700); });
  if (data.map && data.lat == null) setTimeout(resolveMap, 150);
  add(frag, [h('div', { class: 'field' }, h('label', null, 'Google Maps (link, address, or coordinates)'), mapInput), mapStatus]);
  return frag;
}

/* trip planner: pick categories (multi-select); ticking one auto-adds its items */
/* trip date range with live "X days, Y nights" */
function tripDates(data) {
  const dur = h('div', { class: 'hint', style: { marginTop: '2px', marginBottom: '14px' } });
  function calc() {
    if (data.startDate && data.endDate) {
      const nights = Math.round((new Date(data.endDate) - new Date(data.startDate)) / 86400000);
      dur.textContent = nights < 0 ? '⚠ End date is before the start date'
        : (nights === 0 ? 'Same-day trip' : ((nights + 1) + ' days, ' + nights + ' night' + (nights === 1 ? '' : 's')));
    } else dur.textContent = '';
  }
  const start = h('input', { type: 'date', value: data.startDate || '', oninput: e => { data.startDate = e.target.value; calc(); } });
  const end = h('input', { type: 'date', value: data.endDate || '', oninput: e => { data.endDate = e.target.value; calc(); } });
  calc();
  return h('div', null,
    h('div', { class: 'row2' },
      h('div', { class: 'field' }, h('label', null, 'From'), start),
      h('div', { class: 'field' }, h('label', null, 'To'), end)),
    dur);
}

function tripCategoryPicker(data) {
  if (!Array.isArray(data.categories)) data.categories = [];
  if (!Array.isArray(data.items)) data.items = [];
  const wrap = h('div');
  DB.listItems('tripcat').then(cats => {
    wrap.innerHTML = '';
    if (!cats.length) { wrap.appendChild(h('div', { class: 'hint' }, 'No areas yet — create them in the Areas tab of Trip Planner.')); return; }
    cats.forEach(c => {
      const cd = c.data || {};
      const on = data.categories.includes(c.id);
      const row = h('div', { class: 'check-row' },
        h('div', { class: 'cb' + (on ? ' on' : '') }),
        h('span', { class: 'ttl' }, cd.title || 'Area'));
      row.querySelector('.cb').onclick = () => {
        const i = data.categories.indexOf(c.id);
        const names = (cd.items || []).filter(Boolean);
        if (i >= 0) { data.categories.splice(i, 1); data.items = data.items.filter(it => !names.includes(it.name)); }
        else { data.categories.push(c.id); names.forEach(n => { if (!data.items.some(it => it.name === n)) data.items.push({ name: n, checked: false }); }); }
        rerenderEditor('trips', data);
      };
      wrap.appendChild(row);
    });
  });
  return wrap;
}

/* weekly schedule: list of day + start/end (24h) sessions */
function slotsEditor(data) {
  if (!Array.isArray(data.slots)) data.slots = [];
  // migrate old { date, time } -> { day, start, end }
  data.slots = data.slots.map(s => {
    if (s && s.day !== undefined) return s;
    const day = (s && s.date) ? new Date(s.date).getDay() : 1;
    return { day, start: (s && s.time) || '', end: '' };
  });
  const wrap = h('div');
  function draw() {
    wrap.innerHTML = '';
    data.slots.forEach((s, i) => {
      const daySel = h('select', { onchange: e => s.day = parseInt(e.target.value, 10) },
        ...DOW_ORDER.map(idx => h('option', { value: idx, selected: Number(s.day) === idx ? 'selected' : null }, DOW[idx])));
      wrap.appendChild(h('div', { class: 'sub-item' },
        h('div', { class: 'sub-head' },
          h('span', { class: 'num' }, 'SESSION ' + (i + 1)),
          h('span', { class: 'grow' }),
          h('button', { class: 'del-x', type: 'button', onclick: () => { if (!confirmDel('Remove this session?')) return; data.slots.splice(i, 1); draw(); } }, '✕')),
        h('div', { class: 'field', style: { margin: '0 0 8px' } }, h('label', { style: { fontSize: '12px' } }, 'Day'), daySel),
        h('div', { class: 'row2' },
          h('div', { class: 'field', style: { margin: 0 } }, h('label', { style: { fontSize: '12px' } }, 'Start (24h)'), h('input', { type: 'time', value: s.start || '', oninput: e => s.start = e.target.value })),
          h('div', { class: 'field', style: { margin: 0 } }, h('label', { style: { fontSize: '12px' } }, 'End (24h)'), h('input', { type: 'time', value: s.end || '', oninput: e => s.end = e.target.value })))));
    });
    wrap.appendChild(h('button', { class: 'btn ghost', type: 'button', onclick: () => { data.slots.push({ day: 1, start: '', end: '' }); draw(); } }, '+ Add a day & time'));
  }
  draw();
  return wrap;
}

/* recipe ingredients: name + optional photo each */
function ingredientsEditor(data) {
  if (!Array.isArray(data.ingredients)) data.ingredients = [];
  // migrate old string ingredients -> { name, imgs }
  data.ingredients = data.ingredients.map(x => typeof x === 'string' ? { name: x, imgs: [] } : (x || { name: '', imgs: [] }));
  const wrap = h('div');
  function draw() {
    wrap.innerHTML = '';
    data.ingredients.forEach((ing, i) => {
      if (!Array.isArray(ing.imgs)) ing.imgs = [];
      wrap.appendChild(h('div', { class: 'sub-item' },
        h('div', { class: 'sub-head' },
          h('input', { class: 'grow', placeholder: 'e.g. 2 cups rice', value: ing.name || '', oninput: e => ing.name = e.target.value }),
          h('button', { class: 'del-x', type: 'button', onclick: () => { if (!confirmDel('Remove this ingredient?')) return; data.ingredients.splice(i, 1); draw(); } }, '✕')),
        imageMulti(ing, 'imgs', true, { compact: true })));
    });
    wrap.appendChild(h('button', { class: 'btn ghost', type: 'button', onclick: () => { data.ingredients.push({ name: '', imgs: [] }); draw(); } }, '+ Add ingredient'));
  }
  draw();
  return wrap;
}

/* recipe steps: text + optional photo each */
function stepsEditor(data) {
  if (!Array.isArray(data.steps)) data.steps = [];
  // each step = { header, points:[string], imgs:[] }  (migrate old { text })
  data.steps = data.steps.map(s => {
    if (s && (s.header !== undefined || s.points !== undefined)) {
      if (!Array.isArray(s.points)) s.points = []; if (!Array.isArray(s.imgs)) s.imgs = []; return s;
    }
    return { header: '', points: (s && s.text) ? [s.text] : [], imgs: Array.isArray(s && s.imgs) ? s.imgs : [] };
  });
  const wrap = h('div');
  function draw() {
    wrap.innerHTML = '';
    data.steps.forEach((st, i) => {
      const ptWrap = h('div');
      function drawPts() {
        ptWrap.innerHTML = '';
        st.points.forEach((p, j) => {
          ptWrap.appendChild(h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '6px' } },
            h('span', { style: { color: 'var(--muted)' } }, '•'),
            h('input', { value: p, placeholder: 'Add a point', oninput: e => st.points[j] = e.target.value }),
            h('button', { class: 'del-x', type: 'button', onclick: () => { if (!confirmDel('Remove this point?')) return; st.points.splice(j, 1); drawPts(); } }, '✕')));
        });
        ptWrap.appendChild(h('button', { class: 'btn ghost', type: 'button', onclick: () => { st.points.push(''); drawPts(); } }, '+ Add point'));
      }
      drawPts();
      wrap.appendChild(h('div', { class: 'sub-item' },
        h('div', { class: 'sub-head' },
          h('span', { class: 'num' }, 'Step ' + (i + 1)),
          h('span', { class: 'grow' }),
          h('button', { class: 'del-x', type: 'button', onclick: () => { if (!confirmDel('Remove this step?')) return; data.steps.splice(i, 1); draw(); } }, '✕')),
        h('input', { class: 'step-header', placeholder: 'Step title (e.g. Make the broth)', value: st.header || '', oninput: e => st.header = e.target.value }),
        h('div', { style: { marginTop: '8px' } }, ptWrap),
        h('div', { style: { marginTop: '4px' } }, imageMulti(st, 'imgs', true, { compact: true }))));
    });
    wrap.appendChild(h('button', { class: 'btn ghost', type: 'button', onclick: () => { data.steps.push({ header: '', points: [''], imgs: [] }); draw(); } }, '+ Add step'));
  }
  draw();
  return wrap;
}

/* party food menu: name + cook/buy toggle + prep each */
function foodMenuEditor(data) {
  if (!Array.isArray(data.food)) data.food = [];
  const wrap = h('div');
  function draw() {
    wrap.innerHTML = '';
    data.food.forEach((f, i) => {
      if (!f.mode) f.mode = 'cook';
      const modeBtn = h('button', { class: 'btn small ' + (f.mode === 'cook' ? '' : 'secondary'), type: 'button' });
      const paint = () => modeBtn.textContent = f.mode === 'cook' ? '👨‍🍳 Cook' : '🛍️ Buy out';
      paint();
      modeBtn.onclick = () => { f.mode = f.mode === 'cook' ? 'buy' : 'cook'; modeBtn.className = 'btn small ' + (f.mode === 'cook' ? '' : 'secondary'); paint(); };
      wrap.appendChild(h('div', { class: 'sub-item' },
        h('div', { class: 'sub-head' },
          h('input', { class: 'grow', placeholder: 'Dish name', value: f.name || '', oninput: e => f.name = e.target.value }),
          h('button', { class: 'del-x', type: 'button', onclick: () => { if (!confirmDel('Remove this dish?')) return; data.food.splice(i, 1); draw(); } }, '✕')),
        h('div', { style: { marginBottom: '8px' } }, modeBtn),
        h('textarea', { placeholder: 'Cooking prep / notes', oninput: e => f.prep = e.target.value }, f.prep || '')));
    });
    wrap.appendChild(h('button', { class: 'btn ghost', type: 'button', onclick: () => { data.food.push({ name: '', prep: '', mode: 'cook' }); draw(); } }, '+ Add dish'));
  }
  draw();
  return wrap;
}

/* recipe "where to buy": item + shop + phone each */
function whereToBuyEditor(data) {
  if (!Array.isArray(data.buy)) data.buy = [];
  const wrap = h('div');
  function draw() {
    wrap.innerHTML = '';
    data.buy.forEach((b, i) => {
      wrap.appendChild(h('div', { class: 'sub-item' },
        h('div', { class: 'sub-head' },
          h('input', { class: 'grow', placeholder: 'Item', value: b.item || '', oninput: e => b.item = e.target.value }),
          h('button', { class: 'del-x', type: 'button', onclick: () => { if (!confirmDel('Remove this place?')) return; data.buy.splice(i, 1); draw(); } }, '✕')),
        h('div', { class: 'row2', style: { marginTop: '8px' } },
          h('input', { placeholder: 'Shop', value: b.shop || '', oninput: e => b.shop = e.target.value }),
          h('input', { placeholder: 'Contact name', value: b.contact || '', oninput: e => b.contact = e.target.value })),
        h('input', { type: 'tel', inputmode: 'tel', placeholder: 'Phone', value: b.phone || '', oninput: e => b.phone = e.target.value, style: { marginTop: '8px' } })));
    });
    wrap.appendChild(h('button', { class: 'btn ghost', type: 'button', onclick: () => { data.buy.push({ item: '', shop: '', contact: '', phone: '' }); draw(); } }, '+ Add place'));
  }
  draw();
  return wrap;
}

/* to-do items: name + optional due date each (checked toggled in detail view) */
function todoItemsEditor(data) {
  if (!Array.isArray(data.items)) data.items = [];
  const wrap = h('div');
  function draw() {
    wrap.innerHTML = '';
    data.items.forEach((it, i) => {
      wrap.appendChild(h('div', { class: 'sub-item' },
        h('div', { class: 'sub-head' },
          h('input', { class: 'grow', placeholder: 'To-do item', value: it.name || '', oninput: e => it.name = e.target.value }),
          h('button', { class: 'del-x', type: 'button', onclick: () => { if (!confirmDel('Remove this item?')) return; data.items.splice(i, 1); draw(); } }, '✕')),
        h('div', { class: 'field', style: { margin: '8px 0 0' } },
          h('label', { style: { fontSize: '12px' } }, 'Due date (optional)'),
          h('input', { type: 'date', value: it.eta || '', oninput: e => it.eta = e.target.value }))));
    });
    wrap.appendChild(h('button', { class: 'btn ghost', type: 'button', onclick: () => { data.items.push({ name: '', checked: false, eta: '' }); draw(); } }, '+ Add item'));
  }
  draw();
  return wrap;
}

/* generic checklist editor (name only; checked toggled in detail view) */
function checklistEditor(data, key, placeholder) {
  if (!Array.isArray(data[key])) data[key] = [];
  const wrap = h('div');
  function draw() {
    wrap.innerHTML = '';
    data[key].forEach((it, i) => {
      wrap.appendChild(h('div', { class: 'field', style: { marginBottom: '8px' } },
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('input', { value: it.name || '', placeholder, oninput: e => it.name = e.target.value }),
          h('button', { class: 'del-x', type: 'button', onclick: () => { if (!confirmDel('Remove this item?')) return; data[key].splice(i, 1); draw(); } }, '✕'))));
    });
    wrap.appendChild(h('button', { class: 'btn ghost', type: 'button', onclick: () => { data[key].push({ name: '', checked: false }); draw(); } }, '+ Add item'));
  }
  draw();
  return wrap;
}

/* saved-item: category tag select (populated from shopping categories) */
function shopCategoryField(data) {
  const sel = h('select', { onchange: e => data.category = e.target.value });
  sel.appendChild(h('option', { value: '' }, '— No category —'));
  DB.getShopCats().then(cats => {
    cats.forEach(c => sel.appendChild(h('option', { value: c }, c)));
    if (data.category && !cats.includes(data.category)) sel.appendChild(h('option', { value: data.category }, data.category));
    sel.value = data.category || '';
  });
  return h('div', { class: 'field' }, h('label', null, 'Category tag'), sel);
}

/* saved-item: repeatable price-by-shop rows */
function pricesEditor(data) {
  if (!Array.isArray(data.prices)) data.prices = [];
  if (!data.prices.length && data.shop) data.prices.push({ shop: data.shop, price: '' }); // migrate old single shop
  const wrap = h('div');
  function draw() {
    wrap.innerHTML = '';
    data.prices.forEach((p, i) => {
      wrap.appendChild(h('div', { class: 'sub-item' },
        h('div', { class: 'sub-head' },
          h('input', { placeholder: 'RM', inputmode: 'decimal', value: p.price || '', oninput: e => p.price = e.target.value, style: { maxWidth: '110px' } }),
          h('input', { class: 'grow', placeholder: 'Shop name', value: p.shop || '', oninput: e => p.shop = e.target.value }),
          h('button', { class: 'del-x', type: 'button', onclick: () => { if (!confirmDel('Remove this shop price?')) return; data.prices.splice(i, 1); draw(); } }, '✕'))));
    });
    wrap.appendChild(h('button', { class: 'btn ghost', type: 'button', onclick: () => { data.prices.push({ price: '', shop: '' }); draw(); } }, '+ Add shop'));
  }
  draw();
  return wrap;
}

/* shopping cart editor: every add = pick a saved item OR create new, enter only quantity */
function shoppingEditor(data) {
  if (!Array.isArray(data.items)) data.items = [];
  const cart = h('div');
  const addPanel = h('div');

  function drawCart() {
    cart.innerHTML = '';
    if (!data.items.length) { cart.appendChild(h('div', { class: 'hint' }, 'No items yet — add one above.')); return; }
    data.items.forEach((it, i) => {
      cart.appendChild(h('div', { class: 'sub-item' },
        h('div', { class: 'sub-head' },
          h('div', { class: 'grow', style: { fontWeight: '600' } }, it.name || 'Item'),
          h('input', { placeholder: 'Qty', value: it.qty || '', style: { maxWidth: '92px' }, oninput: e => it.qty = e.target.value }),
          h('button', { class: 'del-x', type: 'button', onclick: () => { if (!confirmDel('Remove this item?')) return; data.items.splice(i, 1); drawCart(); } }, '✕')),
        it.remarks ? h('div', { class: 'hint', style: { marginTop: '4px' } }, '💡 ' + it.remarks) : null));
    });
  }

  async function drawAddPanel(selectedCat) {
    addPanel.innerHTML = '';
    addPanel.appendChild(h('div', { class: 'hint' }, 'Loading…'));
    const [cats, saved] = await Promise.all([DB.getShopCats(), DB.listItems('shopitem')]);
    addPanel.innerHTML = '';
    // optional category filter to narrow the saved list
    if (cats.length) {
      const catSel = h('select', { onchange: e => drawAddPanel(e.target.value) },
        h('option', { value: '' }, 'All categories'),
        ...cats.map(c => h('option', { value: c }, c)));
      catSel.value = selectedCat || '';
      addPanel.appendChild(h('div', { class: 'field' }, h('label', null, 'Category'), catSel));
    }
    const filtered = saved.filter(s => !selectedCat || (s.data || {}).category === selectedCat);
    const itemSel = h('select', { class: 'grow', style: { minWidth: '0' } },
      h('option', { value: '' }, '— Choose an item —'),
      h('option', { value: '__new' }, '➕ Create new item'),
      ...filtered.map(s => { const d = s.data || {}; const c = cheapestPrice(d.prices); return h('option', { value: s.id }, (d.title || 'Item') + (c ? ('  —  ' + fmtMYR(c.price) + ' @ ' + c.shop) : '')); }));
    const nameField = h('div', { class: 'field', style: { display: 'none' } },
      h('input', { placeholder: 'New item name', autocapitalize: 'words' }));
    const nameInput = nameField.querySelector('input');
    const qtyInput = h('input', { placeholder: 'e.g. 2, 1kg, 500ml' });
    const info = h('div', { class: 'hint', style: { marginTop: '6px' } }, '');
    itemSel.onchange = () => {
      if (itemSel.value === '__new') { nameField.style.display = ''; info.textContent = ''; nameInput.focus(); return; }
      nameField.style.display = 'none';
      const s = filtered.find(x => x.id === itemSel.value); const c = s ? cheapestPrice(s.data.prices) : null;
      info.textContent = c ? ('Cheapest: ' + fmtMYR(c.price) + ' @ ' + c.shop) : (s ? 'No saved price for this item yet' : '');
    };
    const addBtn = h('button', { class: 'btn small', type: 'button', onclick: () => {
      if (itemSel.value === '__new') {
        const nm = (nameInput.value || '').trim();
        if (!nm) { toast('Enter the item name'); return; }
        data.items.push({ name: nm, qty: (qtyInput.value || '').trim(), category: selectedCat || '', remarks: '', checked: false });
        toast('Added');
      } else {
        const s = filtered.find(x => x.id === itemSel.value);
        if (!s) { toast('Choose an item or create a new one'); return; }
        const d = s.data || {}; const c = cheapestPrice(d.prices);
        const remark = c ? ('Cheapest at ' + c.shop + ' — ' + fmtMYR(c.price)) : '';
        data.items.push({ name: d.title || '', qty: (qtyInput.value || '').trim(), category: d.category || '', remarks: remark, checked: false });
        toast(c ? ('💡 Cheapest at ' + c.shop + ' — ' + fmtMYR(c.price)) : 'Added');
      }
      drawCart();
      itemSel.value = ''; nameInput.value = ''; nameField.style.display = 'none'; qtyInput.value = ''; info.textContent = '';
    } }, '+ Add');
    addPanel.appendChild(h('div', { class: 'field' }, h('label', null, 'Item'), itemSel));
    addPanel.appendChild(nameField);
    addPanel.appendChild(h('div', { class: 'field' }, h('label', null, 'Quantity'), qtyInput));
    addPanel.appendChild(h('div', null, addBtn, info));
  }

  drawCart();
  drawAddPanel('');
  return h('div', null,
    h('div', { class: 'section-title', style: { marginTop: '4px' } }, 'Add item'),
    addPanel,
    h('div', { class: 'section-title' }, 'Your list'),
    cart);
}

/* shared "add item" panel: pick a saved item or create new, enter only quantity. onAdd(itemObj). */
async function buildShoppingAddPanel(onAdd) {
  const panel = h('div');
  async function draw(selectedCat) {
    panel.innerHTML = '';
    panel.appendChild(h('div', { class: 'hint' }, 'Loading…'));
    const [cats, saved] = await Promise.all([DB.getShopCats(), DB.listItems('shopitem')]);
    panel.innerHTML = '';
    if (cats.length) {
      const catSel = h('select', { onchange: e => draw(e.target.value) },
        h('option', { value: '' }, 'All categories'),
        ...cats.map(c => h('option', { value: c }, c)));
      catSel.value = selectedCat || '';
      panel.appendChild(h('div', { class: 'field' }, h('label', null, 'Category'), catSel));
    }
    const filtered = saved.filter(s => !selectedCat || (s.data || {}).category === selectedCat);
    const itemSel = h('select', { class: 'grow', style: { minWidth: '0' } },
      h('option', { value: '' }, '— Choose an item —'),
      h('option', { value: '__new' }, '➕ Create new item'),
      ...filtered.map(s => { const d = s.data || {}; const c = cheapestPrice(d.prices); return h('option', { value: s.id }, (d.title || 'Item') + (c ? ('  —  ' + fmtMYR(c.price) + ' / ' + unitOf(d) + ' @ ' + c.shop) : '')); }));
    const nameField = h('div', { class: 'field', style: { display: 'none' } }, h('input', { placeholder: 'New item name', autocapitalize: 'words' }));
    const nameInput = nameField.querySelector('input');
    const qtyInput = h('input', { placeholder: 'e.g. 2, 1kg, 500ml' });
    const info = h('div', { class: 'hint', style: { marginTop: '6px' } }, '');
    itemSel.onchange = () => {
      if (itemSel.value === '__new') { nameField.style.display = ''; info.textContent = ''; nameInput.focus(); return; }
      nameField.style.display = 'none';
      const s = filtered.find(x => x.id === itemSel.value); const c = s ? cheapestPrice(s.data.prices) : null;
      info.textContent = c ? ('Cheapest: ' + fmtMYR(c.price) + ' / ' + unitOf(s.data) + ' @ ' + c.shop) : (s ? 'No saved price for this item yet' : '');
    };
    const addBtn = h('button', { class: 'btn small', type: 'button', onclick: async () => {
      let obj;
      if (itemSel.value === '__new') {
        const nm = (nameInput.value || '').trim();
        if (!nm) { toast('Enter the item name'); return; }
        obj = { name: nm, qty: (qtyInput.value || '').trim(), category: selectedCat || '', remarks: '', checked: false };
        toast('Added');
      } else {
        const s = filtered.find(x => x.id === itemSel.value);
        if (!s) { toast('Choose an item or create a new one'); return; }
        const d = s.data || {}; const c = cheapestPrice(d.prices);
        const cheapTxt = c ? ('Cheapest at ' + c.shop + ' — ' + fmtMYR(c.price) + ' / ' + unitOf(d)) : '';
        obj = { name: d.title || '', qty: (qtyInput.value || '').trim(), category: d.category || '', remarks: cheapTxt, savedId: s.id, savedImg: (d.images || [])[0] || '', checked: false };
        toast(c ? ('💡 ' + cheapTxt) : 'Added');
      }
      await onAdd(obj);
      itemSel.value = ''; nameInput.value = ''; nameField.style.display = 'none'; qtyInput.value = ''; info.textContent = '';
    } }, '+ Add');
    panel.appendChild(h('div', { class: 'field' }, h('label', null, 'Item'), itemSel));
    panel.appendChild(nameField);
    panel.appendChild(h('div', { class: 'field' }, h('label', null, 'Quantity'), qtyInput));
    panel.appendChild(h('div', null, addBtn, info));
  }
  await draw('');
  return panel;
}

/* the single, flat shopping list: add straight in, tick off as you buy */
async function renderShoppingItems(body) {
  let doc = await DB.getItem('shopping', '_shoplist');
  if (!doc) {
    doc = { id: '_shoplist', cat: 'shopping', data: { title: 'Shopping list', items: [] } };
    // one-time: fold any previously-created named lists into the single list
    const old = (await DB.listItems('shopping')).filter(x => x.id !== '_shoplist');
    for (const o of old) for (const t of ((o.data && o.data.items) || [])) doc.data.items.push(t);
    if (doc.data.items.length) await DB.saveItem(doc);
  }
  if (!Array.isArray(doc.data.items)) doc.data.items = [];
  const save = () => DB.saveItem(doc);
  // bought items disappear 2 hours after being ticked
  const TWO_H = 2 * 3600 * 1000;
  const purge = () => {
    const before = doc.data.items.length;
    doc.data.items = doc.data.items.filter(t => !(t.checked && t.boughtAt && (Date.now() - t.boughtAt > TWO_H)));
    return doc.data.items.length !== before;
  };
  if (purge()) await save();

  const listWrap = h('div', { class: 'detail-card' });
  function drawList() {
    if (purge()) save();
    listWrap.innerHTML = '';
    const its = doc.data.items;
    listWrap.appendChild(h('div', { class: 'hint', style: { marginBottom: '8px' } }, its.filter(i => i.checked).length + '/' + its.length + ' bought · bought items clear after 2h'));
    if (!its.length) { listWrap.appendChild(h('div', { class: 'hint' }, 'No items yet — tap “+ Add item”.')); return; }
    its.forEach((t, i) => {
      const ttl = h('div', { class: 'ttl' },
        (t.name || '') + (t.qty ? ('  × ' + t.qty) : ''),
        t.savedImg ? h('span', { class: 'pic-tap', title: 'View photo' }, ' 📷') : null,
        t.remarks ? h('div', { class: 'px' }, '💡 ' + t.remarks) : null);
      if (t.savedImg) {
        ttl.style.cursor = 'pointer';
        ttl.onclick = async () => { const src = await DB.getImage(t.savedImg); if (src) openLightbox(src); else toast('No photo saved for this item'); };
      }
      const row = h('div', { class: 'check-row' + (t.checked ? ' done' : '') },
        h('div', { class: 'cb' + (t.checked ? ' on' : '') }),
        ttl,
        h('button', { class: 'row-del', type: 'button', title: 'Remove', onclick: async (e) => { e.stopPropagation(); doc.data.items.splice(i, 1); await save(); drawList(); } }, '🗑'));
      row.querySelector('.cb').onclick = async () => { t.checked = !t.checked; t.boughtAt = t.checked ? Date.now() : null; await save(); drawList(); };
      listWrap.appendChild(row);
    });
  }

  // the add form stays hidden until you tap "+ Add item"
  const addPanel = await buildShoppingAddPanel(async (obj) => { doc.data.items.push(obj); await save(); drawList(); });
  const addWrap = h('div', { class: 'detail-card', style: { display: 'none' } }, addPanel);
  const addBtn = h('button', { class: 'btn', type: 'button', onclick: () => {
    const showing = addWrap.style.display !== 'none';
    addWrap.style.display = showing ? 'none' : '';
    addBtn.textContent = showing ? '+ Add item' : '✕ Close';
  } }, '+ Add item');
  // share-this-list control (collapsible)
  const shareWrap = h('div', { class: 'detail-card', style: { display: 'none' } },
    h('div', { class: 'hint', style: { marginBottom: '8px' } }, 'Add the login email of anyone you want to share this grocery list with — they can see & edit it live. Leave empty to keep it private.'),
    shareWithEditor(doc.data, () => save()));
  const shareBtn = h('button', { class: 'btn secondary', type: 'button', style: { marginTop: '8px' }, onclick: () => {
    const showing = shareWrap.style.display !== 'none';
    shareWrap.style.display = showing ? 'none' : '';
    shareBtn.textContent = showing ? '👥 Share this list' : '✕ Close sharing';
  } }, '👥 Share this list');

  body.appendChild(addBtn);
  body.appendChild(addWrap);
  body.appendChild(shareBtn);
  body.appendChild(shareWrap);
  body.appendChild(h('div', { class: 'section-title' }, 'Your list'));
  body.appendChild(listWrap);
  drawList();
}

let _rerender = null;
function rerenderEditor(cat, data) { if (_rerender) _rerender(); }

/* ---------------- DETAIL renderers ---------------- */
async function renderDetail(cat, item) {
  const data = item.data || {};
  const F = h('div');
  const a = (...n) => add(F, n);
  const kv = (k, v) => v ? h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)) : null;
  const linkKv = (k, v) => v ? h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('a', { class: 'v link-a', href: v, target: '_blank' }, 'Open ↗')) : null;
  async function imgs(ids) {
    const out = [];
    for (const id of (ids || [])) { const s = await DB.getImage(id); if (s) out.push(h('img', { class: 'detail-img', src: s, onclick: () => openLightbox(s) })); }
    return out;
  }

  switch (cat) {
    case 'recipes': {
      const favBtn = h('button', { class: 'fav-toggle' + (data.fav ? ' on' : ''),
        onclick: async () => { data.fav = !data.fav; await DB.saveItem(item); navigate('#/view/recipes/' + item.id); } }, data.fav ? '★' : '☆');
      const rcard = h('div', { class: 'detail-card' },
        h('div', { class: 'fav-head' }, favBtn, h('h3', { style: { margin: 0 } }, data.title || 'Recipe')));
      for (const im of await imgs(data.images)) rcard.appendChild(im);
      const ingList = (data.ingredients || []).map(x => typeof x === 'string' ? { name: x, imgs: [] } : (x || {}))
        .filter(x => (x.name && x.name.trim()) || (x.imgs && x.imgs.length));
      if (ingList.length || (data.ingredientImgs || []).length) {
        rcard.appendChild(h('div', { class: 'section-title' }, 'Ingredients'));
        for (const ing of ingList) {
          const row = h('div', { style: { marginBottom: '10px' } }, h('div', null, '• ' + (ing.name || '')));
          if (ing.imgs && ing.imgs.length) {
            const strip = h('div', { class: 'imgbox', style: { marginTop: '6px' } });
            for (const id of ing.imgs) { const s = await DB.getImage(id); if (s) strip.appendChild(h('img', { src: s, onclick: () => openLightbox(s) })); }
            row.appendChild(strip);
          }
          rcard.appendChild(row);
        }
        if ((data.ingredientImgs || []).length) {
          const strip = h('div', { class: 'imgbox', style: { marginTop: '8px' } });
          for (const id of data.ingredientImgs) { const s = await DB.getImage(id); if (s) strip.appendChild(h('img', { src: s, onclick: () => openLightbox(s) })); }
          rcard.appendChild(strip);
        }
      }
      a(rcard);
      if ((data.steps || []).length) {
        const card = h('div', { class: 'detail-card' }, h('div', { class: 'section-title' }, 'Steps'));
        for (let si = 0; si < data.steps.length; si++) {
          const st = data.steps[si];
          const pts = Array.isArray(st.points) ? st.points.filter(Boolean) : (st.text ? [st.text] : []);
          const block = h('div', { style: { marginBottom: '12px' } });
          block.appendChild(h('div', { class: 'step-h' },
            h('span', { class: 'step-num' }, String(si + 1)),
            h('span', { class: 'step-t' }, st.header || ('Step ' + (si + 1)))));
          if (pts.length) block.appendChild(h('ul', { class: 'bullets' }, pts.map(p => h('li', null, p))));
          for (const im of await imgs(st.imgs)) block.appendChild(im);
          card.appendChild(block);
        }
        a(card);
      }
      const links = h('div', { class: 'detail-card' }, linkKv('Video', data.videoUrl), linkKv('Reference', data.refUrl));
      if (links.children.length) a(links);
      const buys = (data.buy || []).filter(b => b.item || b.shop || b.phone);
      if (buys.length) {
        const c = h('div', { class: 'detail-card' }, h('div', { class: 'section-title' }, 'Where to buy'));
        buys.forEach(b => {
          const info = [b.shop, b.contact].filter(Boolean).join(' · ');
          c.appendChild(h('div', { class: 'kv' },
            h('span', { class: 'k' }, b.item || ''),
            h('span', { class: 'v' },
              info ? h('span', null, info) : null,
              b.phone ? h('a', { class: 'call-icon', href: 'tel:' + b.phone.replace(/[^\d+]/g, ''), title: 'Call ' + b.phone, style: { marginLeft: info ? '10px' : '0' } }, '📞') : null)));
        });
        a(c);
      }
      if (data.notes) a(h('div', { class: 'detail-card' },
        h('div', { class: 'section-title' }, 'Notes'),
        h('div', { style: { whiteSpace: 'pre-wrap', lineHeight: '1.5' } }, data.notes)));
      a(h('button', { class: 'btn secondary', style: { marginTop: '4px' }, onclick: async () => {
        await duplicateItem('recipes', item); toast('Recipe duplicated'); navigate('#/cat/recipes');
      } }, '⧉ Duplicate this recipe'));
      break;
    }
    case 'records': {
      const lines = data.recType === 'address'
        ? [['Name', data.recipient], ['Address', data.address], ['Phone', data.phone]]
        : [['Bank', data.bank], ['Account name', data.accName], ['Account no.', data.accNo], ['SWIFT/extra', data.swift]];
      const card = h('div', { class: 'detail-card' }, h('h3', null, data.title || 'Record'),
        ...lines.map(([k, v]) => kv(k, v)).filter(Boolean), kv('Notes', data.notes));
      a(card);
      const text = recordToText(data);
      a(h('div', { class: 'detail-card' },
        h('div', { class: 'section-title' }, 'Share'),
        h('div', { class: 'copy-block' }, text),
        h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px' } },
          h('button', { class: 'btn small', onclick: () => copyText(text) }, '📋 Copy'),
          h('a', { class: 'btn small secondary', href: 'https://wa.me/?text=' + encodeURIComponent(text), target: '_blank' }, 'WhatsApp'))));
      break;
    }
    case 'memberships': {
      const card = h('div', { class: 'detail-card' }, h('h3', null, data.title || 'Membership'),
        kv('Member', data.member),
        data.number ? h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Number'),
          h('span', { class: 'v' }, data.number, ' ',
            h('button', { class: 'btn small secondary', style: { marginLeft: '8px' }, onclick: () => copyText(data.number) }, 'Copy'))) : null,
        kv('Notes', data.notes));
      for (const im of await imgs(data.images)) card.appendChild(im);
      a(card);
      break;
    }
    case 'party': {
      const loc = data.locType === 'Other' ? data.location : (data.locType || data.location);
      const ad = parseInt(data.adults) || 0, kd = parseInt(data.kids) || 0;
      const totalStr = (ad + kd) + ' (' + ad + ' adults; ' + kd + ' kids)';
      a(h('div', { class: 'detail-card' }, h('h3', null, data.title || 'Party'),
        kv('Event date', data.eventDate ? fmtDate(data.eventDate) : null),
        kv('Start time', data.startTime ? fmtHM(data.startTime) : null),
        kv('Location', loc), kv('Theme', data.theme), kv('Budget', data.budget ? fmtMoneyMaybe(data.budget) : null),
        kv('Total guests', totalStr)));
      const sec = (title, arr) => (arr || []).filter(Boolean).length ? h('div', { class: 'detail-card' },
        h('div', { class: 'section-title' }, title), h('ul', { class: 'bullets' }, arr.filter(Boolean).map(x => h('li', null, x)))) : null;
      a(sec('Guest list', data.guestList));
      if ((data.food || []).length) {
        const c = h('div', { class: 'detail-card' }, h('div', { class: 'section-title' }, 'Food menu'));
        data.food.forEach(f => c.appendChild(h('div', { class: 'kv' },
          h('span', { class: 'k' }, (f.mode === 'buy' ? '🛍️ ' : '👨‍🍳 ') + (f.name || '')),
          h('span', { class: 'v' }, f.prep || ''))));
        a(c);
      }
      a(sec('Drinks', data.drinks));
      a(sec('To prepare', data.toPrepare));
      a(sec('To buy', data.toBuy));
      a(sec('Games', data.games));
      break;
    }
    case 'warranty': {
      const card = h('div', { class: 'detail-card' }, h('h3', null, data.title || 'Item'),
        kv('Shop', data.shop),
        kv('Purchased', data.boughtDate ? fmtDate(data.boughtDate) : null),
        kv('Warranty expiry', data.expiry ? fmtDate(data.expiry) : null),
        warrantyStatus(data.expiry),
        kv('Notes', data.notes));
      for (const im of await imgs(data.images)) card.appendChild(im);
      a(card);
      break;
    }
    case 'tax': {
      const card = h('div', { class: 'detail-card' }, h('h3', null, data.title || 'Receipt'),
        kv('Category', data.taxCat),
        kv('Invoice date', data.invoiceDate ? fmtDate(data.invoiceDate) : null),
        kv('Year', data.year),
        (data.amount != null && data.amount !== '') ? kv('Amount', fmtMYR(data.amount)) : null,
        kv('Notes', data.notes));
      for (const im of await imgs(data.images)) card.appendChild(im);
      a(card);
      break;
    }
    case 'todo': {
      a(h('div', { class: 'detail-card' }, h('h3', null, data.title || 'To-Do')));
      a(checklistView(item, 'items', cat, 'To-do'));
      break;
    }
    case 'trips': {
      let dates = '';
      if (data.startDate && data.endDate) {
        const nights = Math.round((new Date(data.endDate) - new Date(data.startDate)) / 86400000);
        dates = fmtDate(data.startDate) + ' → ' + fmtDate(data.endDate) + (nights >= 0 ? ('  (' + (nights + 1) + ' days, ' + nights + ' night' + (nights === 1 ? '' : 's') + ')') : '');
      }
      a(h('div', { class: 'detail-card' }, h('h3', null, data.title || 'Trip'),
        dates ? kv('Dates', dates) : null, kv('Notes', data.notes)));
      a(checklistView(item, 'items', cat, 'Packing list'));
      break;
    }
    case 'tripcat': {
      const its = (data.items || []).filter(Boolean);
      const card = h('div', { class: 'detail-card' }, h('h3', null, data.title || 'Area'));
      if (its.length) card.appendChild(h('ul', { class: 'bullets' }, its.map(x => h('li', null, x))));
      a(card);
      break;
    }
    case 'shopping': {
      a(shoppingView(item, cat));
      break;
    }
    case 'shopitem': {
      const cheap = cheapestPrice(data.prices);
      const card = h('div', { class: 'detail-card' }, h('h3', null, data.title || 'Item'),
        kv('Brand', data.brand),
        kv('Category', data.category),
        kv('Sold per', data.unit),
        cheap ? h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Cheapest'), h('span', { class: 'v', style: { color: 'var(--green)' } }, fmtMYR(cheap.price) + ' / ' + unitOf(data) + ' @ ' + cheap.shop)) : null,
        kv('Notes', data.notes));
      for (const im of await imgs(data.images)) card.appendChild(im);
      a(card);
      const priced = (data.prices || []).filter(p => p.shop || p.price);
      if (priced.length) {
        const pc = h('div', { class: 'detail-card' }, h('div', { class: 'section-title' }, 'Price per ' + unitOf(data) + ', by shop'));
        priced.forEach(p => pc.appendChild(h('div', { class: 'kv' },
          h('span', { class: 'k' }, p.shop || '—'),
          h('span', { class: 'v' }, (p.price !== '' && p.price != null) ? (fmtMYR(p.price) + ' / ' + unitOf(data)) : '—'))));
        a(pc);
      }
      break;
    }
    case 'quick': {
      const html = data.bodyHtml != null ? data.bodyHtml : escapeHtml(data.body || '').replace(/\n/g, '<br>');
      a(h('div', { class: 'detail-card' }, h('h3', null, data.title || 'Note'),
        h('div', { class: 'rte-view', style: { marginTop: '6px' }, html: html })));
      break;
    }
    case 'events': {
      a(h('div', { class: 'detail-card' }, h('h3', null, data.title || 'Event'),
        kv('When', fmtDT(data.when)), kv('Location', data.location), kv('Notes', data.notes),
        kv('Reminder', data.remindAt ? fmtDT(data.remindAt) : null),
        data.telegram ? h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Telegram'), h('span', { class: 'v' }, h('span', { class: 'pill' }, 'reminder on'))) : null));
      if (data.map || data.location) a(mapCard(item));
      break;
    }
    case 'schedule': {
      a(h('div', { class: 'detail-card' }, h('h3', null, data.title || 'Schedule'),
        kv('Location', data.location),
        kv('Repeat', (data.repeatMode === 'until' && data.until) ? ('Until ' + fmtDate(data.until)) : 'Every week'),
        kv('Notes', data.notes)));
      const slots = (data.slots || []).filter(s => s.day !== undefined && s.start).slice()
        .sort((a, b) => (DOW_ORDER.indexOf(Number(a.day)) - DOW_ORDER.indexOf(Number(b.day))) || (a.start || '').localeCompare(b.start || ''));
      if (slots.length) {
        const c = h('div', { class: 'detail-card' }, h('div', { class: 'section-title' }, 'Weekly sessions'));
        slots.forEach(s => c.appendChild(h('div', { class: 'kv' },
          h('span', { class: 'k' }, DOW[Number(s.day)] || ''),
          h('span', { class: 'v' }, s.start + (s.end ? ' – ' + s.end : '')))));
        a(c);
      }
      if (data.map || data.location) a(mapCard(item));
      break;
    }
  }
  return F;
}

/* interactive checklist in detail view (saves on toggle) */
function checklistView(item, key, cat, title) {
  const data = item.data || {};
  const items = data[key] || [];
  const card = h('div', { class: 'detail-card' }, h('div', { class: 'section-title' }, title + ' (' + items.filter(i => i.checked).length + '/' + items.length + ')'));
  items.forEach(it => {
    const row = h('div', { class: 'check-row' + (it.checked ? ' done' : '') },
      h('div', { class: 'cb' + (it.checked ? ' on' : '') }),
      h('div', { class: 'ttl' }, it.name || '', it.eta ? h('div', { class: 'px' }, 'Due ' + fmtDate(it.eta)) : null));
    row.querySelector('.cb').onclick = async () => {
      it.checked = !it.checked;
      await DB.saveItem(item);
      navigate('#/view/' + cat + '/' + item.id);
    };
    card.appendChild(row);
  });
  return card;
}

function shoppingView(item, cat) {
  const data = item.data || {};
  const items = data.items || [];
  const card = h('div', { class: 'detail-card' },
    h('h3', null, data.title || 'Shopping list'),
    h('div', { class: 'hint', style: { marginBottom: '10px' } }, items.filter(i => i.checked).length + '/' + items.length + ' picked'));
  items.forEach(it => {
    const meta = [it.qty && ('×' + it.qty), it.category, it.remarks].filter(Boolean).join(' · ');
    const row = h('div', { class: 'check-row' + (it.checked ? ' done' : '') },
      h('div', { class: 'cb' + (it.checked ? ' on' : '') }),
      h('div', { class: 'ttl' }, it.name || '', meta ? h('div', { class: 'px' }, meta) : null));
    row.querySelector('.cb').onclick = async () => {
      it.checked = !it.checked;
      await DB.saveItem(item);
      navigate('#/view/' + cat + '/' + item.id);
    };
    card.appendChild(row);
  });
  return card;
}

/* ---------------- list-row summaries ---------------- */
function summary(cat, data) {
  switch (cat) {
    case 'recipes': {
      const ingArr = (data.ingredients || []).map(x => typeof x === 'string' ? { name: x } : (x || {}));
      const ingCount = ingArr.filter(x => x.name && x.name.trim()).length;
      const thumb = (data.images || [])[0]; // only the finished-dish photo, never ingredient/step photos
      return { title: data.title || 'Recipe', meta: ingCount + ' ingredients · ' + (data.steps || []).length + ' steps', thumb, fav: data.fav };
    }
    case 'records': return { title: data.title || 'Record', meta: data.recType === 'address' ? (data.recipient || 'Address') : (data.bank || 'Bank account') };
    case 'memberships': return { title: data.title || 'Membership', meta: data.member || data.number || '', thumb: (data.images || [])[0] };
    case 'warranty': return { title: data.title || 'Item', meta: [data.shop, data.expiry && ('exp ' + fmtDate(data.expiry))].filter(Boolean).join(' · '), thumb: (data.images || [])[0] };
    case 'tax': return { title: data.title || 'Receipt', meta: [data.taxCat, data.year, (data.amount != null && data.amount !== '') && fmtMYR(data.amount)].filter(Boolean).join(' · '), thumb: (data.images || [])[0] };
    case 'todo': {
      const its = data.items || [];
      const next = its.filter(i => !i.checked && i.eta).map(i => i.eta).sort()[0];
      return { title: data.title || 'To-Do', meta: [(next && ('next due ' + fmtDate(next))), its.filter(i => i.checked).length + '/' + its.length + ' done'].filter(Boolean).join(' · ') };
    }
    case 'party': return { title: data.title || 'Party', meta: [data.eventDate && fmtDate(data.eventDate), data.theme].filter(Boolean).join(' · ') };
    case 'trips': {
      const its = data.items || [];
      let range = '';
      if (data.startDate && data.endDate) {
        const nights = Math.round((new Date(data.endDate) - new Date(data.startDate)) / 86400000);
        range = fmtDate(data.startDate) + ' → ' + fmtDate(data.endDate) + (nights >= 0 ? (' · ' + (nights + 1) + 'D' + nights + 'N') : '');
      }
      return { title: data.title || 'Trip', meta: [range, its.filter(i => i.checked).length + '/' + its.length + ' packed'].filter(Boolean).join(' · ') };
    }
    case 'tripcat': return { title: data.title || 'Area', meta: (data.items || []).filter(Boolean).length + ' items' };
    case 'shopping': return { title: data.title || 'Shopping list', meta: (data.items || []).filter(i => i.checked).length + '/' + (data.items || []).length + ' picked' };
    case 'shopitem': {
      const c = cheapestPrice(data.prices);
      return { title: data.title || 'Item', meta: [data.category, data.brand, c && (fmtMYR(c.price) + ' / ' + unitOf(data) + ' @ ' + c.shop)].filter(Boolean).join(' · '), thumb: (data.images || [])[0] };
    }
    case 'quick': return { title: data.title || 'Note', meta: ((data.bodyHtml || '').replace(/<[^>]+>/g, ' ').trim() || data.body || '').slice(0, 60) };
    case 'events': return { title: data.title || 'Event', meta: [fmtDT(data.when), data.location].filter(Boolean).join(' · ') };
    case 'schedule': {
      const slots = (data.slots || []).filter(s => s.day !== undefined);
      const days = [...new Set(slots.slice().sort((a, b) => DOW_ORDER.indexOf(Number(a.day)) - DOW_ORDER.indexOf(Number(b.day))).map(s => DOW_SHORT[Number(s.day)]))].join(', ');
      return { title: data.title || 'Schedule', meta: [data.location, days].filter(Boolean).join(' · ') };
    }
    default: return { title: data.title || 'Item', meta: '' };
  }
}

/* ---------------- text/format utils ---------------- */
function recordToText(d) {
  if (d.recType === 'address') {
    return [d.title, d.recipient, d.address, d.phone && ('Tel: ' + d.phone), d.notes].filter(Boolean).join('\n');
  }
  return [d.title, d.bank && ('Bank: ' + d.bank), d.accName && ('Name: ' + d.accName),
    d.accNo && ('Acc No: ' + d.accNo), d.swift && ('SWIFT: ' + d.swift)].filter(Boolean).join('\n');
}
function fmtDT(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtTimeOnly(s) {
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function fmtHM(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ap = h < 12 ? 'AM' : 'PM';
  return (h % 12 || 12) + ':' + String(m).padStart(2, '0') + ' ' + ap;
}
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon … Sun for menus/sorting
/* next future Date that falls on weekday dayIdx (0=Sun..6=Sat) at "HH:MM" local time */
function nextWeekdayOccurrence(dayIdx, startHM) {
  const now = new Date();
  const [h, m] = startHM.split(':').map(Number);
  const occ = new Date(now);
  occ.setHours(h, m, 0, 0);
  occ.setDate(occ.getDate() + ((dayIdx - now.getDay() + 7) % 7));
  if (occ.getTime() <= now.getTime()) occ.setDate(occ.getDate() + 7);
  return occ;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function fmtMYR(n) {
  const num = Number(n) || 0;
  const parts = Math.abs(num).toFixed(2).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); // thousands separators
  return (num < 0 ? '-RM ' : 'RM ') + parts[0] + '.' + parts[1];
}
/* format as MYR only if the value is purely numeric, else leave the text as-is */
function fmtMoneyMaybe(v) {
  if (v == null || v === '') return '';
  const cleaned = String(v).replace(/[,\s]/g, '').replace(/^RM/i, '');
  return /^\d*\.?\d+$/.test(cleaned) ? fmtMYR(cleaned) : String(v);
}
/* the unit a saved item is priced per (e.g. bottle, kg); defaults to "unit" */
function unitOf(d) { return (d && d.unit && String(d.unit).trim()) || 'unit'; }
/* cheapest {shop, price} from a prices array (migrates an old single `shop`) */
function cheapestPrice(prices) {
  const valid = (prices || []).filter(p => p && p.price !== '' && p.price != null && !isNaN(parseFloat(p.price)));
  if (!valid.length) return null;
  return valid.reduce((m, p) => parseFloat(p.price) < parseFloat(m.price) ? p : m);
}
function mapCard(item) {
  const d = item.data || {};
  const q = (d.map || d.location || '').trim();
  const enc = encodeURIComponent(q);
  const isUrl = /^https?:\/\//i.test(q);
  const openHref = isUrl ? q : 'https://www.google.com/maps/search/?api=1&query=' + enc;
  const dirHref = 'https://www.google.com/maps/dir/?api=1&destination=' + enc;
  const card = h('div', { class: 'detail-card' }, h('div', { class: 'section-title' }, 'Getting there'));
  if (d.location) card.appendChild(h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Location'), h('span', { class: 'v' }, d.location)));
  const info = h('div');
  card.appendChild(info);
  card.appendChild(h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' } },
    h('a', { class: 'btn small secondary', href: openHref, target: '_blank' }, '📍 Open in Google Maps'),
    h('a', { class: 'btn small', href: dirHref, target: '_blank' }, '🧭 Directions')));
  computeDistance(item, info);
  return card;
}

/* pull lat,lng out of a coordinate string or a full Google Maps URL */
function parseLatLng(q) {
  q = (q || '').trim();
  let m = q.match(/^(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)$/);          // "3.07,101.6"
  if (m) return [parseFloat(m[1]), parseFloat(m[2])];
  m = q.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);                      // .../@3.07,101.6,17z
  if (m) return [parseFloat(m[1]), parseFloat(m[2])];
  m = q.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/);                  // !3d..!4d..
  if (m) return [parseFloat(m[1]), parseFloat(m[2])];
  m = q.match(/[?&](?:q|query|destination)=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/); // ?q=lat,lng
  if (m) return [parseFloat(m[1]), parseFloat(m[2])];
  return null;
}

/* resolve free text / coords / google link -> [lat,lng] (uses /api/resolve for share links) */
async function resolveCoords(q) {
  q = (q || '').trim();
  if (!q) return null;
  const direct = parseLatLng(q);
  if (direct) return direct;
  if (/^https?:\/\//i.test(q)) {
    try {
      const r = await fetch('/api/resolve?url=' + encodeURIComponent(q)).then(x => x.ok ? x.json() : null);
      if (r && typeof r.lat === 'number') return [r.lat, r.lng];
    } catch (e) { /* /api not available (e.g. localhost) — fall through */ }
  }
  try {
    const g = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q)).then(x => x.json());
    if (g && g.length) return [parseFloat(g[0].lat), parseFloat(g[0].lon)];
  } catch (e) {}
  return null;
}

/* resolve once and cache coords onto the event so the list can show distance fast */
async function placeCoords(item) {
  const d = item.data || {};
  const src = (d.map || d.location || '').trim();
  if (typeof d.lat === 'number' && typeof d.lng === 'number' && d._coordSrc === src) return [d.lat, d.lng];
  const c = await resolveCoords(src);
  if (c) { d.lat = c[0]; d.lng = c[1]; d._coordSrc = src; try { await DB.saveItem(item); } catch (e) {} }
  return c;
}

function haversineKm(la1, lo1, la2, lo2) {
  const R = 6371, toR = x => x * Math.PI / 180;
  const dLa = toR(la2 - la1), dLo = toR(lo2 - lo1);
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(toR(la1)) * Math.cos(toR(la2)) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function currentPosition() {
  return new Promise(res => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(
      p => res({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => res(null), { timeout: 10000, enableHighAccuracy: true });
  });
}
/* save last-known location (throttled) so the closed-app scheduler can estimate distance */
let _lastLocSavedAt = 0;
async function saveLastLocation(pos) {
  if (!pos || !CURRENT) return;
  if (Date.now() - _lastLocSavedAt < 10 * 60000) return;
  _lastLocSavedAt = Date.now();
  try { await DB.saveItem({ id: '_lastloc', cat: '_lastloc', data: { lat: pos.lat, lon: pos.lon, at: Date.now() } }); } catch (e) {}
}

/* Free, no-API rush-hour approximation. OSRM gives an ideal no-traffic time;
   we scale it by time of day so it changes like real traffic (heavier at peak
   hours). It's an estimate, not live data — the Directions button has the real one. */
function trafficFactor() {
  const d = new Date();
  const weekday = d.getDay() >= 1 && d.getDay() <= 5;
  const h = d.getHours() + d.getMinutes() / 60;
  if (weekday && h >= 7 && h < 9.5) return 1.6;   // morning rush
  if (weekday && h >= 17 && h < 20) return 1.7;   // evening rush
  if (h >= 22 || h < 6) return 1.1;               // late night / early — light
  return 1.3;                                     // normal daytime
}
async function drivingMetrics(pos, dest) {
  const f = trafficFactor();
  try {
    const r = await fetch('https://router.project-osrm.org/route/v1/driving/' + pos.lon + ',' + pos.lat + ';' + dest[1] + ',' + dest[0] + '?overview=false').then(x => x.json());
    const route = r.routes && r.routes[0];
    if (route) return { km: route.distance / 1000, mins: Math.max(1, Math.round(route.duration / 60 * f)) };
  } catch (e) {}
  const km = haversineKm(pos.lat, pos.lon, dest[0], dest[1]);
  return { km, mins: Math.max(1, Math.round(km / 35 * 60 * (f / 1.3))) };
}

/* accurate driving distance/time for the event detail card */
async function computeDistance(item, info) {
  info.innerHTML = '';
  info.appendChild(h('div', { class: 'hint' }, 'Calculating distance from you…'));
  try {
    const pos = await currentPosition();
    if (!pos) throw new Error('geo');
    const dest = await placeCoords(item);
    if (!dest) throw new Error('place-not-found');
    const { km, mins } = await drivingMetrics(pos, dest);
    info.innerHTML = '';
    info.appendChild(h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Distance'), h('span', { class: 'v' }, km.toFixed(1) + ' km')));
    info.appendChild(h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Drive time'), h('span', { class: 'v' }, '~' + mins + ' min')));
  } catch (e) {
    info.innerHTML = '';
    info.appendChild(h('button', { class: 'btn small secondary', type: 'button', onclick: () => computeDistance(item, info) }, '📏 Show distance & time from me'));
    info.appendChild(h('div', { class: 'hint', style: { marginTop: '6px' } },
      e.message === 'place-not-found'
        ? "Couldn't read the location. Paste a Google Maps link, a plain address, or coordinates in the event."
        : 'Allow location access, then tap to retry.'));
  }
}
function warrantyStatus(expiry) {
  if (!expiry) return null;
  const e = new Date(expiry); e.setHours(0, 0, 0, 0);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const days = Math.round((e - now) / 86400000);
  const txt = days < 0 ? 'Expired' : days === 0 ? 'Expires today' : days + ' days left';
  const color = days < 0 ? 'var(--red)' : days <= 30 ? 'var(--amber)' : 'var(--green)';
  return h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Status'), h('span', { class: 'v', style: { color } }, txt));
}
/* rich-text editor for Quick Notes (bold / italic / underline / bullets) */
function richTextEditor(data, key, legacyPlain) {
  if ((data[key] == null || data[key] === '') && legacyPlain) data[key] = escapeHtml(legacyPlain).replace(/\n/g, '<br>');
  const ed = h('div', { class: 'rte', contenteditable: 'true', autocapitalize: 'sentences' });
  ed.innerHTML = data[key] || '';
  const sync = () => { data[key] = ed.innerHTML; ed.dispatchEvent(new Event('input', { bubbles: true })); };
  ed.addEventListener('input', () => data[key] = ed.innerHTML);
  const exec = (c, val) => { document.execCommand(c, false, val == null ? null : val); ed.focus(); data[key] = ed.innerHTML; };
  const btn = (content, c) => h('button', { class: 'rte-btn', type: 'button', onmousedown: e => { e.preventDefault(); exec(c); } }, content);
  // highlight swatches (and a "clear highlight")
  const hilite = (color) => h('button', { class: 'rte-btn hl' + (color ? '' : ' none'), type: 'button',
    style: color ? { background: color } : {}, title: color ? 'Highlight' : 'No highlight',
    onmousedown: e => {
      e.preventDefault();
      document.execCommand('styleWithCSS', false, true);
      if (!document.execCommand('hiliteColor', false, color || 'transparent')) document.execCommand('backColor', false, color || 'transparent');
      ed.focus(); data[key] = ed.innerHTML;
    } }, color ? '' : '⌫');
  // stylus / finger drawing -> inserted as an image
  const drawBtn = h('button', { class: 'rte-btn', type: 'button', title: 'Draw / write with pen',
    onmousedown: e => e.preventDefault(),
    onclick: () => openDrawingPad((url) => { ed.focus(); document.execCommand('insertHTML', false, '<img src="' + url + '" class="note-img"><br>'); sync(); }) }, '✍️');
  const toolbar = h('div', { class: 'rte-toolbar' },
    btn(h('b', null, 'B'), 'bold'),
    btn(h('i', null, 'I'), 'italic'),
    btn(h('u', null, 'U'), 'underline'),
    btn('• List', 'insertUnorderedList'),
    drawBtn);
  const hiBar = h('div', { class: 'rte-toolbar hilites' },
    h('span', { class: 'hl-label' }, 'Highlight:'),
    hilite('#fff59d'), hilite('#a5d6a7'), hilite('#f48fb1'), hilite('#90caf9'), hilite(''));
  return h('div', null, toolbar, hiBar, ed);
}

/* full-screen pad: draw with a stylus (pressure-aware) or finger, then insert into the note */
function openDrawingPad(onInsert) {
  const canvas = h('canvas', { class: 'draw-canvas' });
  const bar = h('div', { class: 'draw-bar' });
  const overlay = h('div', { class: 'draw-overlay' }, bar, canvas);
  let open = true;
  const cleanup = () => { if (!open) return; open = false; overlay.remove(); window.removeEventListener('popstate', onPop); };
  const onPop = () => cleanup();
  const closeAndPop = () => { if (!open) return; cleanup(); history.back(); };
  window.addEventListener('popstate', onPop);
  history.pushState({ overlay: 'draw' }, '');
  document.body.appendChild(overlay);
  // size the canvas to the available area (retina-aware)
  const ctx = canvas.getContext('2d');
  function sizeCanvas() {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#15151c';
  }
  setTimeout(sizeCanvas, 0);
  let drawing = false, lx = 0, ly = 0;
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', e => { drawing = true;[lx, ly] = pos(e); try { canvas.setPointerCapture(e.pointerId); } catch (x) {} });
  canvas.addEventListener('pointermove', e => {
    if (!drawing) return; e.preventDefault();
    const [x, y] = pos(e);
    ctx.lineWidth = e.pressure && e.pressure > 0 ? (0.5 + e.pressure * 4) : 2.4;
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(x, y); ctx.stroke();
    [lx, ly] = [x, y];
  });
  const stop = () => { drawing = false; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  bar.appendChild(h('button', { class: 'btn secondary small', type: 'button', onclick: closeAndPop }, 'Cancel'));
  bar.appendChild(h('button', { class: 'btn secondary small', type: 'button', onclick: () => sizeCanvas() }, 'Clear'));
  bar.appendChild(h('button', { class: 'btn small', type: 'button', onclick: () => { const url = canvas.toDataURL('image/jpeg', 0.6); cleanup(); history.back(); onInsert(url); } }, 'Insert'));
}
function openLightbox(src) {
  const ov = h('div', { class: 'lightbox' }, h('img', { src }), h('div', { class: 'lightbox-close' }, '✕'));
  let open = true;
  const cleanup = () => { if (!open) return; open = false; ov.remove(); window.removeEventListener('popstate', onPop); };
  const onPop = () => cleanup();                              // phone/browser Back closes it
  const closeByTap = () => { if (!open) return; cleanup(); history.back(); }; // remove the state we pushed
  ov.onclick = closeByTap;
  window.addEventListener('popstate', onPop);
  history.pushState({ overlay: 'lightbox' }, '');
  document.body.appendChild(ov);
}
function confirmDel(msg) { return window.confirm(msg || 'Delete this?'); }
/* send a message via the Telegram Bot API (works from the browser — Telegram allows CORS) */
async function sendTelegram(token, chatId, text) {
  const r = await fetch('https://api.telegram.org/bot' + token.trim() + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId.trim(), text })
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.description || 'Telegram error');
  return j;
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('Copied'); }
}

/* ============================================================
   SCREENS
   ============================================================ */
function appbar(title, sub, { back, action } = {}) {
  return h('div', { class: 'appbar' },
    back ? h('button', { class: 'iconbtn back', onclick: back }, '‹') : null,
    h('div', { style: { flex: 1 } }, h('h1', null, title), sub ? h('div', { class: 'sub' }, sub) : null),
    action || null);
}
function screen(bar, body) {
  return h('div', null, bar, h('div', { class: 'content' }, body));
}

/* ----- AUTH screen ----- */
function authScreen(view = 'login') {
  const state = { email: '', pass: '', pass2: '', newpass: '' };
  const msgBox = h('div');
  const showMsg = (text, kind = 'err') => { msgBox.innerHTML = ''; msgBox.appendChild(h('div', { class: 'msg ' + kind }, text)); };

  function go(v) { mount(authScreen(v)); }

  let card;
  if (view === 'login' || view === 'signup') {
    const isSignup = view === 'signup';
    card = h('div', { class: 'auth-card' },
      h('h2', null, isSignup ? 'Create your account' : 'Welcome back'),
      msgBox,
      field('Email', state, 'email', { type: 'email', placeholder: 'you@email.com' }),
      field('Password', state, 'pass', { type: 'password', placeholder: '••••••••' }),
      isSignup ? field('Confirm password', state, 'pass2', { type: 'password', placeholder: '••••••••' }) : null,
      h('button', { class: 'btn', onclick: async () => {
        try {
          if (!state.email) return showMsg('Enter your email.');
          if (isSignup) {
            if (state.pass.length < 6) return showMsg('Password must be at least 6 characters.');
            if (state.pass !== state.pass2) return showMsg('Passwords do not match.');
            await Auth.signUp(state.email, state.pass);
          } else {
            await Auth.signIn(state.email, state.pass);
          }
        } catch (e) { showMsg(friendlyErr(e)); }
      } }, isSignup ? 'Create account' : 'Log in'),
      !isSignup ? h('div', { class: 'auth-switch' }, h('a', { onclick: () => go('forgot') }, 'Forgot password?')) : null,
      h('div', { class: 'auth-switch' },
        isSignup ? 'Already have an account? ' : "Don't have an account? ",
        h('a', { onclick: () => go(isSignup ? 'login' : 'signup') }, isSignup ? 'Log in' : 'Sign up')));
  } else { // forgot
    card = h('div', { class: 'auth-card' },
      h('h2', null, 'Reset password'),
      msgBox,
      field('Email', state, 'email', { type: 'email', placeholder: 'you@email.com' }),
      MODE === 'firebase'
        ? h('div', { class: 'hint', style: { marginBottom: '14px' } }, "We'll email you a reset link.")
        : field('New password', state, 'newpass', { type: 'password', placeholder: 'New password (min 6 chars)', hint: 'Local mode: reset happens on this device.' }),
      h('button', { class: 'btn', onclick: async () => {
        try {
          if (!state.email) return showMsg('Enter your email.');
          const r = await Auth.reset(state.email, state.newpass);
          showMsg(r.emailed ? 'Reset link sent — check your inbox.' : 'Password updated. You can log in now.', 'ok');
        } catch (e) { showMsg(friendlyErr(e)); }
      } }, MODE === 'firebase' ? 'Send reset link' : 'Reset password'),
      h('div', { class: 'auth-switch' }, h('a', { onclick: () => go('login') }, '‹ Back to log in')));
  }

  return h('div', { class: 'auth-wrap' },
    h('div', { class: 'brand' },
      h('img', { src: 'icons/icon.svg' }),
      h('h1', null, 'MyLife Hub'),
      h('p', null, 'Everything that matters, in one place.')),
    card,
    h('div', { class: 'mode-badge' }, MODE === 'firebase' ? '☁︎ Synced account' : '⛁ Local mode — data stays on this device'));
}
function friendlyErr(e) {
  const m = (e && (e.code || e.message)) || '';
  if (m.includes('email-already-in-use')) return 'That email is already registered.';
  if (m.includes('invalid-email')) return 'That email looks invalid.';
  if (m.includes('weak-password')) return 'Password must be at least 6 characters.';
  if (m.includes('user-not-found') || m.includes('wrong-password') || m.includes('invalid-credential')) return 'Wrong email or password.';
  if (m.includes('too-many-requests')) return 'Too many attempts. Try again later.';
  return (e && e.message) || 'Something went wrong.';
}

/* ----- HOME ----- */
async function homeScreen() {
  const grid = h('div', { class: 'grid' });
  const bar = appbar('MyLife Hub', CURRENT && CURRENT.email, {
    action: h('div', { style: { display: 'flex', gap: '8px' } },
      h('button', { class: 'iconbtn', title: 'Settings', onclick: () => navigate('#/settings') }, '⚙'),
      h('button', { class: 'iconbtn', title: 'Log out', onclick: () => Auth.signOut() }, '⎋'))
  });
  const body = h('div', null,
    h('div', { class: 'hello' }, h('h2', null, 'Hello 👋'), h('p', null, 'Pick a notebook to open.')),
    grid);
  mount(screen(bar, body));
  // counts
  for (const c of CATS.filter(c => !c.hidden)) {
    const card = h('div', { class: 'cat-card', onclick: () => navigate('#/cat/' + c.key) },
      h('div', { class: 'emoji' }, c.emoji),
      h('div', null, h('div', { class: 'name' }, c.name), h('div', { class: 'count' }, '…')));
    grid.appendChild(card);
    DB.listItems(c.key).then(items => { card.querySelector('.count').textContent = items.length + (items.length === 1 ? ' note' : ' notes'); });
  }
}

/* ----- CATEGORY LIST ----- */
async function listScreen(cat, sub) {
  // saved items / trip categories live under their parent screen, not their own
  if (cat === 'shopitem') { navigate('#/cat/shopping/items'); return; }
  if (cat === 'tripcat') { navigate('#/cat/trips/cats'); return; }
  const bar = appbar(catName(cat), null, { back: () => goBack() });
  const listEl = h('div', { class: 'list' }, h('div', { class: 'spinner' }));
  mount(screen(bar, listEl));
  const fab = h('button', { class: 'fab', onclick: () => navigate('#/edit/' + cat) }, '+');
  $app().appendChild(fab);

  const items = await DB.listItems(cat);
  listEl.innerHTML = '';

  if (cat === 'party') { renderArchiveList(listEl, 'party', items, partyIsArchived, { duplicate: true }); startLive(() => listScreen(cat, sub)); return; }
  if (cat === 'events') { renderArchiveList(listEl, 'events', items, eventIsArchived, { distance: true, archiveLabel: 'Past Events' }); return; }
  if (cat === 'schedule') { renderArchiveList(listEl, 'schedule', items, scheduleIsCompleted, { distance: true, upcomingLabel: 'Upcoming', archiveLabel: 'Completed' }); return; }
  if (cat === 'tax') { renderTaxList(listEl, items); return; }
  if (cat === 'trips') { renderTripScreen(listEl, items, fab, sub === 'cats' ? 'cats' : 'trips'); startLive(() => listScreen(cat, sub)); return; }
  if (cat === 'shopping') { renderShoppingScreen(listEl, items, fab, sub === 'items' ? 'items' : 'lists'); return; }

  if (!items.length) {
    listEl.appendChild(emptyState(cat));
    return;
  }
  const posP = cat === 'schedule' ? currentPosition() : null; // ask location once for distance
  for (const it of items) {
    if (cat === 'todo') { listEl.appendChild(buildTodoRow(it)); continue; }
    const canDelete = cat === 'todo' || cat === 'quick';
    const del = canDelete
      ? h('button', { class: 'row-del', type: 'button', title: 'Delete', onclick: async (e) => {
          e.stopPropagation();
          if (!confirmDel('Delete this ' + (cat === 'quick' ? 'note' : 'to-do list') + '?')) return;
          await DB.deleteItem(cat, it.id); toast('Deleted'); navigate('#/cat/' + cat);
        } }, '🗑')
      : null;
    const target = (cat === 'quick' || cat === 'todo') ? ('#/edit/' + cat + '/' + it.id) : undefined;
    const row = buildRow(cat, it, { action: del, target });
    listEl.appendChild(row);
    if (posP) enrichRowDistance(it, row, posP);
  }
}

async function renderTripScreen(listEl, trips, fab, initialTab) {
  const cats = await DB.listItems('tripcat');
  let tab = initialTab || 'trips';
  const tabsEl = h('div', { class: 'tabs' });
  const body = h('div', { class: 'list' });
  function render() {
    tabsEl.innerHTML = '';
    [['trips', 'Trips (' + trips.length + ')'], ['cats', 'Areas (' + cats.length + ')']].forEach(([k, label]) =>
      tabsEl.appendChild(h('div', { class: 'tab' + (tab === k ? ' active' : ''), onclick: () => { tab = k; render(); } }, label)));
    body.innerHTML = '';
    if (tab === 'trips') {
      if (fab) fab.onclick = () => navigate('#/edit/trips');
      if (!trips.length) { body.appendChild(emptyState('trips', 'No trips yet. Tap + to plan one.')); return; }
      for (const it of trips) body.appendChild(buildRow('trips', it));
    } else {
      if (fab) fab.onclick = () => navigate('#/edit/tripcat');
      if (!cats.length) { body.appendChild(emptyState('trips', 'No categories yet. Tap + to add one (e.g. Beach, City).')); return; }
      for (const it of cats) {
        const del = h('button', { class: 'row-del', type: 'button', title: 'Delete', onclick: async (e) => {
          e.stopPropagation(); if (!confirmDel('Delete this category?')) return;
          await DB.deleteItem('tripcat', it.id); toast('Deleted'); navigate('#/cat/trips/cats');
        } }, '🗑');
        body.appendChild(buildRow('tripcat', it, { action: del }));
      }
    }
  }
  listEl.appendChild(tabsEl);
  listEl.appendChild(body);
  render();
}

async function renderShoppingScreen(listEl, lists, fab, initialTab) {
  const items = await DB.listItems('shopitem');
  let tab = initialTab || 'lists';
  const tabsEl = h('div', { class: 'tabs' });
  const body = h('div', { class: 'list' });
  function render() {
    tabsEl.innerHTML = '';
    [['lists', 'Grocery list'], ['items', 'Saved items (' + items.length + ')'], ['cats', 'Categories']].forEach(([k, label]) =>
      tabsEl.appendChild(h('div', { class: 'tab' + (tab === k ? ' active' : ''), onclick: () => { tab = k; render(); } }, label)));
    body.innerHTML = '';
    if (tab === 'cats') {
      if (fab) fab.style.display = 'none';
      renderCategoryManager(body);
      return;
    }
    if (tab === 'lists') {
      if (fab) fab.style.display = 'none'; // adding happens inline, no separate list cards
      renderShoppingItems(body);
      return;
    }
    if (fab) fab.style.display = '';
    {
      if (fab) fab.onclick = () => navigate('#/edit/shopitem');
      if (!items.length) { body.appendChild(emptyState('shopping', 'No saved items yet. Tap + to add one.')); return; }
      for (const it of items) {
        const del = h('button', { class: 'row-del', type: 'button', title: 'Delete', onclick: async (e) => {
          e.stopPropagation(); if (!confirmDel('Delete this saved item?')) return;
          await DB.deleteItem('shopitem', it.id); toast('Deleted'); navigate('#/cat/shopping/items');
        } }, '🗑');
        body.appendChild(buildRow('shopitem', it, { action: del }));
      }
    }
  }
  listEl.appendChild(tabsEl);
  listEl.appendChild(body);
  render();
}

function renderCategoryManager(container) {
  DB.getShopCats().then(cats => {
    container.innerHTML = '';
    const input = h('input', { placeholder: 'New category (e.g. hotpot)' });
    const add = async () => {
      const v = (input.value || '').trim(); if (!v) return;
      if (!cats.includes(v)) { cats.push(v); await DB.setShopCats(cats); }
      renderCategoryManager(container);
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
    container.appendChild(h('div', { class: 'field' }, h('label', null, 'Add a category'),
      h('div', { class: 'sub-head' }, input, h('button', { class: 'btn small', type: 'button', onclick: add }, 'Add'))));
    if (!cats.length) { container.appendChild(h('div', { class: 'hint' }, 'No categories yet. Add ones like hotpot, bbq…')); return; }
    cats.forEach(c => container.appendChild(h('div', { class: 'check-row' },
      h('span', { class: 'ttl' }, c),
      h('button', { class: 'row-del', type: 'button', title: 'Delete', onclick: async () => {
        if (!confirmDel('Delete category “' + c + '”?')) return;
        await DB.setShopCats(cats.filter(x => x !== c)); renderCategoryManager(container);
      } }, '🗑'))));
  });
}

function renderTaxList(listEl, items) {
  if (!items.length) { listEl.appendChild(emptyState('tax')); return; }
  const byYear = {};
  items.forEach(it => {
    const d = it.data || {};
    const y = d.year || 'No year';
    const c = d.taxCat || 'Uncategorised';
    const amt = parseFloat(d.amount) || 0;
    if (!byYear[y]) byYear[y] = { total: 0, cats: {} };
    byYear[y].total += amt;
    byYear[y].cats[c] = (byYear[y].cats[c] || 0) + amt;
  });
  const years = Object.keys(byYear).sort().reverse();
  const card = h('div', { class: 'detail-card' }, h('div', { class: 'section-title' }, 'Yearly totals (MYR)'));
  years.forEach(y => {
    card.appendChild(h('div', { class: 'kv' },
      h('span', { class: 'k', style: { fontWeight: '700', color: 'var(--text)' } }, y),
      h('span', { class: 'v' }, fmtMYR(byYear[y].total))));
    Object.keys(byYear[y].cats).sort().forEach(c => card.appendChild(h('div', { class: 'kv', style: { paddingLeft: '14px' } },
      h('span', { class: 'k', style: { fontSize: '12.5px' } }, c),
      h('span', { class: 'v', style: { fontWeight: '500' } }, fmtMYR(byYear[y].cats[c])))));
  });
  listEl.appendChild(card);
  for (const it of items) listEl.appendChild(buildRow('tax', it));
}

function emptyState(cat, msg) {
  return h('div', { class: 'empty' },
    h('div', { class: 'big' }, (CATS.find(c => c.key === cat) || {}).emoji),
    h('div', null, msg || 'No notes yet.'),
    h('div', { style: { marginTop: '6px', fontSize: '13px' } }, 'Tap + to add your first one.'));
}

function buildRow(cat, it, opts = {}) {
  const s = summary(cat, it.data || {});
  const target = opts.target || ('#/view/' + cat + '/' + it.id);
  // to-do cards show a short preview of their items
  let preview = null;
  if (cat === 'todo') {
    const its = (it.data && it.data.items) || [];
    if (its.length) {
      const show = its.slice(0, 6);
      preview = h('ul', { class: 'row-items' }, show.map(t =>
        h('li', { class: t.checked ? 'done' : '' }, t.name || '',
          t.eta ? h('span', { class: 'eta' }, ' · ' + fmtDate(t.eta)) : null)));
      if (its.length > show.length) preview.appendChild(h('li', { class: 'more' }, '+' + (its.length - show.length) + ' more'));
    }
  }
  const sharedBadge = it._shared
    ? h('div', { class: 'meta', style: { color: 'var(--accent)' } }, it._amOwner ? '👥 Shared by you' : ('👥 Shared by ' + (it._ownerEmail || 'someone')))
    : null;
  const row = h('div', { class: 'row', onclick: () => navigate(target) },
    s.thumb ? h('img', { class: 'thumb', src: '' }) : null,
    h('div', { class: 'main' },
      h('div', { class: 'title' }, s.fav ? h('span', { class: 'fav-star' }, '★ ') : null, s.title),
      s.meta ? h('div', { class: 'meta' }, s.meta) : null,
      sharedBadge,
      preview),
    opts.action || h('div', { class: 'chev' }, '›'));
  if (s.thumb) DB.getImage(s.thumb).then(src => { const img = row.querySelector('.thumb'); if (img && src) img.src = src; });
  return row;
}

/* to-do card: tap an item to strike it out; pencil opens the editor to add/remove */
function buildTodoRow(item) {
  const d = item.data || {};
  const its = d.items || [];
  const meta = h('div', { class: 'meta' });
  function setMeta() {
    const done = its.filter(i => i.checked).length;
    const next = its.filter(i => !i.checked && i.eta).map(i => i.eta).sort()[0];
    meta.textContent = [(next && ('next due ' + fmtDate(next))), done + '/' + its.length + ' done'].filter(Boolean).join(' · ');
  }
  const editBtn = h('button', { class: 'iconbtn small', title: 'Edit', onclick: (e) => { e.stopPropagation(); navigate('#/edit/todo/' + item.id); } }, '✎');
  const delBtn = h('button', { class: 'iconbtn small', title: 'Delete', onclick: async (e) => {
    e.stopPropagation();
    if (!confirmDel('Delete this to-do list?')) return;
    await DB.deleteItem('todo', item.id); toast('Deleted'); navigate('#/cat/todo');
  } }, '🗑');
  const head = h('div', { class: 'todo-head' },
    h('div', { class: 'title' }, d.title || 'To-Do'),
    h('div', { class: 'todo-actions' }, editBtn, delBtn));
  const ul = h('ul', { class: 'row-items tappable' });
  its.forEach((t) => {
    const li = h('li', { class: t.checked ? 'done' : '' },
      t.name || '', t.eta ? h('span', { class: 'eta' }, ' · ' + fmtDate(t.eta)) : null);
    li.onclick = async () => {
      t.checked = !t.checked;
      li.classList.toggle('done', t.checked);
      setMeta();
      try { await DB.saveItem(item); } catch (e) {}
    };
    ul.appendChild(li);
  });
  setMeta();
  return h('div', { class: 'row todo-row' },
    h('div', { class: 'main' }, head, meta,
      its.length ? ul : h('div', { class: 'hint', style: { marginTop: '6px' } }, 'No items yet — tap ✎ to add.')));
}

function dayPassed(dateStr) {
  if (!dateStr) return false;
  const e = new Date(dateStr); e.setHours(0, 0, 0, 0);
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return e < t;
}
function partyIsArchived(it) {
  const d = it.data || {};
  return d.archived || dayPassed(d.eventDate);
}
function scheduleIsCompleted(it) {
  const d = it.data || {};
  // Only schedules with a fixed end date can ever finish; perpetual ones never do.
  if (d.repeatMode !== 'until' || !d.until) return false;
  const end = new Date(d.until + 'T23:59:59').getTime();
  if (isNaN(end)) return false;
  return Date.now() > end;
}
function eventIsArchived(it) {
  const d = it.data || {};
  if (d.archived) return true;
  const w = d.when || d.eventDate;
  if (!w) return false;
  const t = new Date(w).getTime();
  if (isNaN(t)) return false;
  return Date.now() > t + 3600000; // 1 hour after the event time
}

async function duplicateItem(cat, it) {
  const data = JSON.parse(JSON.stringify(it.data || {}));
  data.archived = false;
  data.eventDate = '';
  data.when = '';
  data.title = (data.title || 'Item') + ' (copy)';
  await DB.saveItem({ cat, data });
}

function renderArchiveList(listEl, cat, items, isArchivedFn, opts = {}) {
  const upcoming = items.filter(it => !isArchivedFn(it));
  const archived = items.filter(isArchivedFn);
  let tab = 'upcoming';
  const tabsEl = h('div', { class: 'tabs' });
  const body = h('div', { class: 'list' });
  const posP = opts.distance ? currentPosition() : null;  // ask location once
  const upLabel = opts.upcomingLabel || 'Upcoming';
  const arLabel = opts.archiveLabel || 'Archive';
  function render() {
    tabsEl.innerHTML = '';
    [['upcoming', upLabel + ' (' + upcoming.length + ')'], ['archive', arLabel + ' (' + archived.length + ')']].forEach(([k, label]) =>
      tabsEl.appendChild(h('div', { class: 'tab' + (tab === k ? ' active' : ''), onclick: () => { tab = k; render(); } }, label)));
    body.innerHTML = '';
    const list = tab === 'upcoming' ? upcoming : archived;
    if (!list.length) { body.appendChild(emptyState(cat, tab === 'upcoming' ? ('Nothing in ' + upLabel.toLowerCase() + '.') : ('Nothing in ' + arLabel.toLowerCase() + ' yet.'))); return; }
    for (const it of list) {
      const dup = (tab === 'archive' && opts.duplicate)
        ? h('button', { class: 'btn small secondary', onclick: async (e) => { e.stopPropagation(); await duplicateItem(cat, it); toast('Duplicated to Upcoming'); navigate('#/cat/' + cat); } }, 'Duplicate')
        : null;
      const row = buildRow(cat, it, { action: dup });
      body.appendChild(row);
      if (posP) enrichRowDistance(it, row, posP);
    }
  }
  listEl.appendChild(tabsEl);
  listEl.appendChild(body);
  render();
}

/* add "x km · ~y min" to an event row (rough straight-line estimate) */
async function enrichRowDistance(it, row, posP) {
  const d = it.data || {};
  if (!d.map && !d.location) return;
  const pos = await posP;
  if (!pos) return;
  const dest = await placeCoords(it);
  if (!dest) return;
  const { km, mins } = await drivingMetrics(pos, dest);
  const txt = km.toFixed(1) + ' km · ~' + mins + ' min';
  const meta = row.querySelector('.meta');
  if (meta) meta.textContent = meta.textContent + ' · ' + txt;
  else { const main = row.querySelector('.main'); if (main) main.appendChild(h('div', { class: 'meta' }, txt)); }
}

/* ----- EDITOR ----- */
async function editScreen(cat, id) {
  let item = id ? await DB.getItem(cat, id) : null;
  let currentId = id;
  const data = item ? JSON.parse(JSON.stringify(item.data || {})) : {};
  // ownership of a shared item (members can edit content but not the share list)
  const amOwner = !item || !item._shared || item._amOwner === true;
  const ownerUid = item ? item._ownerUid : undefined;
  const ownerEmail = item ? item._ownerEmail : undefined;
  const formHost = h('div');
  function renderForm() { formHost.innerHTML = ''; formHost.appendChild(buildEditor(cat, data, amOwner)); }
  _rerender = renderForm;
  renderForm();

  const isQuick = cat === 'quick';
  const hasContent = () => {
    if (cat === 'records') return true;
    if (isQuick) return !!(data.title || (data.bodyHtml || '').replace(/<[^>]+>/g, '').trim());
    return !!data.title;
  };
  async function saveNow() {
    if (!hasContent()) return null;
    const saved = await DB.saveItem({ id: currentId || undefined, cat, data, _ownerUid: ownerUid, _ownerEmail: ownerEmail });
    currentId = saved.id;
    return saved;
  }

  let controls;
  if (isQuick) {
    // auto-save: no Save button needed
    const status = h('div', { class: 'autosave-status' }, 'Auto-saves as you type');
    let timer = null;
    formHost.addEventListener('input', () => {
      status.textContent = 'Saving…';
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const saved = await saveNow();
        status.textContent = saved ? 'Saved ✓' : 'Auto-saves as you type';
        if (saved) history.replaceState(null, '', '#/edit/quick/' + currentId);
      }, 600);
    });
    controls = h('div', { style: { marginTop: '18px' } }, status);
  } else {
    const saveBtn = h('button', { class: 'btn', onclick: async () => {
      if (!hasContent()) { toast('Add a title first'); return; }
      await saveNow(); toast('Saved'); goBack();
    } }, id ? 'Save changes' : 'Save');
    const delBtn = currentId ? h('button', { class: 'btn danger', style: { marginTop: '10px' }, onclick: async () => {
      if (confirm('Delete this note?')) { await DB.deleteItem(cat, currentId); toast('Deleted'); navigate('#/cat/' + cat); }
    } }, 'Delete') : null;
    controls = h('div', { style: { marginTop: '18px' } }, saveBtn, delBtn);
  }

  const bar = appbar((id ? 'Edit ' : 'New ') + catName(cat).replace(/s$/, ''), null, {
    back: async () => { if (isQuick) await saveNow(); goBack(); }
  });
  mount(screen(bar, h('div', null, formHost, controls)));
}

/* ----- DETAIL ----- */
async function viewScreen(cat, id) {
  const item = await DB.getItem(cat, id);
  if (!item) { navigate('#/cat/' + cat); return; }
  const bar = appbar(catName(cat).replace(/s$/, ''), null, {
    back: () => goBack(),
    action: h('div', { style: { display: 'flex', gap: '6px' } },
      h('button', { class: 'iconbtn', title: 'Share', onclick: () => shareCard(cat, item) }, '⤴'),
      h('button', { class: 'iconbtn', title: 'Edit', onclick: () => navigate('#/edit/' + cat + '/' + id) }, '✎'))
  });
  const host = h('div', null, h('div', { class: 'spinner' }));
  mount(screen(bar, host));
  const detail = await renderDetail(cat, item);
  host.innerHTML = '';
  host.appendChild(detail);
  // live-refresh shared trips/parties when the other person edits (e.g. ticks a packing item)
  if (SHARE_CATS.includes(cat) && item._shared) startLive(() => viewScreen(cat, id));
}

/* keys that hold arrays of image ids anywhere in a card's data */
const IMG_KEYS = ['imgs', 'images', 'ingredientImgs'];

/* deep-clone a card's data and strip private flags (image references are kept so photos can travel) */
function sanitizeForShare(obj) {
  const clone = JSON.parse(JSON.stringify(obj || {}));
  (function walk(o) {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        if (k.startsWith('_') || k === 'fav' || k === 'archived' || k === 'checked') { delete o[k]; continue; }
        walk(o[k]);
      }
    }
  })(clone);
  return clone;
}

/* gather every image id referenced inside a data tree */
function collectImageIds(data) {
  const ids = [];
  (function walk(o) {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        if (IMG_KEYS.includes(k) && Array.isArray(o[k])) { for (const v of o[k]) if (typeof v === 'string') ids.push(v); }
        else walk(o[k]);
      }
    }
  })(data);
  return ids;
}

/* swap old image ids for new ones (recipient re-saves the photos under their own account) */
function remapImageIds(data, map) {
  (function walk(o) {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        if (IMG_KEYS.includes(k) && Array.isArray(o[k])) o[k] = o[k].map(v => map[v] || v).filter(Boolean);
        else walk(o[k]);
      }
    }
  })(data);
}

/* tap Share on a card -> create a link the recipient opens in the app to add it */
async function shareCard(cat, item) {
  const data = sanitizeForShare(item.data || {});
  const name = summary(cat, data).title || 'a card';
  // bundle the actual photo data so it travels with the card
  const images = {};
  for (const id of collectImageIds(data)) {
    if (images[id]) continue;
    try { const d = await DB.getImage(id); if (d) images[id] = d; } catch (e) {}
  }
  let code;
  try { code = await DB.createShare({ cat, data, title: name, images }); }
  catch (e) { toast('Could not create the share link — the photos may be too large.'); return; }
  const url = location.origin + location.pathname + '?s=' + code;
  const text = 'I shared "' + name + '" with you from MyLife Hub. Open this link in the app to add it to yours:';
  if (navigator.share) {
    try { await navigator.share({ title: name, text, url }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('Share link copied — paste it on WhatsApp'); }
  catch (e) { toast(url); }
}

/* opening a #/import/<code> link: confirm, then add the shared card to the signed-in user's app */
async function importScreen(code) {
  const bar = appbar('Shared card', null, { back: () => navigate('#/') });
  const host = h('div', null, h('div', { class: 'spinner' }));
  mount(screen(bar, host));
  let share = null;
  try { share = await DB.getShare(code); } catch (e) { share = null; }
  host.innerHTML = '';
  if (!share || !share.cat) {
    host.appendChild(h('div', { class: 'detail-card' },
      h('h3', null, 'Card not found'),
      h('div', { class: 'hint' }, 'This shared link is invalid or has been removed.')));
    return;
  }
  const where = catName(share.cat);
  const card = h('div', { class: 'detail-card' },
    h('h3', null, 'Add to your app?'),
    h('div', { class: 'hint', style: { margin: '6px 0 14px' } },
      '"' + (share.title || 'A card') + '" was shared with you. Add it to your ' + where + '?'),
    h('button', { class: 'btn', onclick: async () => {
      const btn = card.querySelector('.btn');
      btn.disabled = true; btn.textContent = 'Adding…';
      try {
        const data = sanitizeForShare(share.data || {});
        // re-save each bundled photo under MY account, then point the card at the new ids
        const incoming = share.images || {};
        const map = {};
        for (const oldId of collectImageIds(data)) {
          if (map[oldId] || !incoming[oldId]) continue;
          try { map[oldId] = await DB.saveImage(incoming[oldId]); } catch (e) {}
        }
        remapImageIds(data, map);
        await DB.saveItem({ cat: share.cat, data });
        toast('Added to your ' + where);
        navigate('#/cat/' + share.cat);
      } catch (e) { btn.disabled = false; btn.textContent = '✓ Add to my app'; toast('Could not add it. Try again.'); }
    } }, '✓ Add to my app'),
    h('button', { class: 'btn secondary', style: { marginTop: '8px' }, onclick: () => navigate('#/') }, 'No thanks'));
  host.appendChild(card);
}

/* ---- prefer Chrome for shared links (WhatsApp's in-app browser handles login/PWA poorly) ---- */
function isInAppBrowser() {
  const ua = navigator.userAgent || '';
  return /WhatsApp|FBAN|FBAV|FB_IAB|Instagram|Line\/|Twitter|MicroMessenger|; wv\)/i.test(ua);
}
function isChrome() {
  const ua = navigator.userAgent || '';
  if (isInAppBrowser()) return false; // in-app webviews embed "Chrome/…" but aren't real Chrome
  if (/CriOS/i.test(ua)) return true; // Chrome on iOS
  return /Chrome\//i.test(ua) && !/; wv\)|Edg|EdgA|OPR|SamsungBrowser/i.test(ua);
}
function openInChrome(code) {
  const target = location.origin + location.pathname + '?s=' + code + '&here=1';
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) {
    const u = new URL(target);
    location.href = 'intent://' + u.host + u.pathname + u.search +
      '#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=' + encodeURIComponent(target) + ';end';
  } else if (/iPhone|iPad|iPod/i.test(ua)) {
    location.href = target.replace(/^https/, 'googlechromes');
  } else {
    location.href = target;
  }
}
function showOpenInChrome(code) {
  const cont = () => { location.href = location.origin + location.pathname + '?s=' + code + '&here=1'; };
  mount(h('div', { class: 'auth-wrap' },
    h('div', { class: 'brand' },
      h('img', { src: 'icons/icon.svg' }),
      h('h1', null, 'MyLife Hub'),
      h('p', null, 'A card was shared with you.')),
    h('div', { class: 'auth-card' },
      h('h2', null, 'Open in Chrome'),
      h('div', { class: 'hint', style: { margin: '6px 0 16px' } },
        'For sign-in and adding the card to work, open this in Chrome rather than the in-app browser.'),
      h('button', { class: 'btn', onclick: () => openInChrome(code) }, 'Open in Chrome'),
      h('div', { class: 'auth-switch', style: { marginTop: '12px' } },
        h('a', { onclick: cont }, 'Continue in this browser')))));
  // Android intents carry a safe fallback URL, so auto-attempting won't strand the user
  if (/Android/i.test(navigator.userAgent || '')) setTimeout(() => openInChrome(code), 500);
}

/* ============================================================
   ROUTER
   ============================================================ */
function navigate(hash) { if (location.hash === hash) routeChanged(); else location.hash = hash; }
/* deterministic "back": go to the logical parent screen — never leaves the app */
function goBack() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const type = parts[0], cat = parts[1], id = parts[2];
  if (type === 'view' && cat) return void navigate('#/cat/' + cat);
  if (type === 'edit' && cat) {
    // recipes/events/etc. were opened from their detail view; to-dos & notes open straight to edit
    if (id && cat !== 'todo' && cat !== 'quick') return void navigate('#/view/' + cat + '/' + id);
    return void navigate('#/cat/' + cat);
  }
  navigate('#/'); // cat list, settings, import, anything else -> home
}

/* live re-render: re-run the current screen when shared data changes (skips while you're typing) */
let _liveUnsub = null;
function stopLive() { if (_liveUnsub) { try { _liveUnsub(); } catch (e) {} _liveUnsub = null; } }
function startLive(renderFn) {
  stopLive();
  let first = true;
  _liveUnsub = DB.watchShared(() => {
    if (first) { first = false; return; } // initial snapshot is the data we just rendered
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return; // don't clobber active typing
    renderFn();
  });
}

function routeChanged() {
  stopLive(); // drop any live listener from the previous screen
  if (!CURRENT) {
    const v = location.hash.includes('signup') ? 'signup' : location.hash.includes('forgot') ? 'forgot' : 'login';
    mount(authScreen(v));
    return;
  }
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  // remove any stray FAB from previous screen
  const stale = $app().querySelector('.fab'); if (stale) stale.remove();

  if (parts.length === 0) return void homeScreen();
  if (parts[0] === 'import') return void importScreen(parts[1]);
  if (parts[0] === 'settings') return void settingsScreen();
  if (parts[0] === 'cat') return void listScreen(parts[1], parts[2]);
  if (parts[0] === 'edit') return void editScreen(parts[1], parts[2]);
  if (parts[0] === 'view') return void viewScreen(parts[1], parts[2]);
  homeScreen();
}

/* Telegram setup block for Settings: token, find-chat-id, test */
function telegramSection(form) {
  const chatInput = h('input', { value: form.telegramChatId, placeholder: 'e.g. 123456789', oninput: e => form.telegramChatId = e.target.value, autocapitalize: 'none' });
  const findBtn = h('button', { class: 'btn small secondary', type: 'button', onclick: async () => {
    if (!form.telegramToken.trim()) { toast('Enter the bot token first'); return; }
    findBtn.textContent = 'Looking…';
    try {
      const r = await fetch('https://api.telegram.org/bot' + form.telegramToken.trim() + '/getUpdates').then(x => x.json());
      const upd = (r.result || []).reverse().find(u => (u.message && u.message.chat) || (u.channel_post && u.channel_post.chat));
      const chat = upd && ((upd.message && upd.message.chat) || (upd.channel_post && upd.channel_post.chat));
      if (!chat) { toast('Send any message to your bot first, then tap again'); }
      else { form.telegramChatId = String(chat.id); chatInput.value = form.telegramChatId; toast('Found chat ID: ' + form.telegramChatId); }
    } catch (e) { toast('Failed: ' + e.message); }
    findBtn.textContent = 'Find my chat ID';
  } }, 'Find my chat ID');
  const testBtn = h('button', { class: 'btn small', type: 'button', onclick: async () => {
    if (!form.telegramToken.trim() || !form.telegramChatId.trim()) { toast('Enter token and chat ID'); return; }
    try { await sendTelegram(form.telegramToken, form.telegramChatId, '✅ MyLife Hub — Telegram reminders are connected.'); toast('Sent! Check Telegram'); }
    catch (e) { toast('Failed: ' + e.message); }
  } }, 'Send test message');
  const help = h('details', { class: 'tg-help' },
    h('summary', null, 'How do I get a bot token & chat ID?'),
    h('ol', { class: 'help-list' },
      h('li', null, 'In Telegram, search for the user @BotFather (blue tick) and open the chat.'),
      h('li', null, 'Send the message /newbot, then follow its prompts: type a name, then a username that ends in “bot” (e.g. wing_reminders_bot).'),
      h('li', null, 'BotFather replies with a token that looks like 123456789:ABCdefGhIJ… — copy it and paste it in “Bot token” above.'),
      h('li', null, 'Already have a bot? Send /mybots to BotFather → pick your bot → API Token.'),
      h('li', null, 'Now open YOUR new bot and send it any message (e.g. “hi”) — this is needed before the next step.'),
      h('li', null, 'Come back here and tap “Find my chat ID”, then “Send test message” to confirm.')));
  return h('div', null,
    h('div', { class: 'section-title' }, 'Telegram reminders'),
    help,
    h('div', { class: 'field' }, h('label', null, 'Bot token'),
      h('input', { value: form.telegramToken, placeholder: '123456:ABC-DEF…', oninput: e => form.telegramToken = e.target.value, autocapitalize: 'none' }),
      h('div', { class: 'hint' }, 'From @BotFather (see guide above). Saved in your account only.')),
    h('div', { class: 'field' }, h('label', null, 'Chat ID'), chatInput,
      h('div', { class: 'hint' }, 'Message your bot once, then tap “Find my chat ID”.')),
    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, findBtn, testBtn),
    h('div', { class: 'hint', style: { marginTop: '8px' } }, 'When set, due reminders are sent to Telegram (delivered to your phone even after you close the app, as long as the app was open when the reminder came due).'));
}

/* ----- SETTINGS ----- */
async function settingsScreen() {
  const s = await DB.getSettings();
  // present lead time as value + unit
  let unit = (s.leadMinutes % 60 === 0 && s.leadMinutes >= 60) ? 'hours' : 'minutes';
  let amount = unit === 'hours' ? s.leadMinutes / 60 : s.leadMinutes;
  const sLM = s.scheduleLeadMinutes != null ? s.scheduleLeadMinutes : 60;
  let schedUnit = (sLM % 60 === 0 && sLM >= 60) ? 'hours' : 'minutes';
  let schedAmount = schedUnit === 'hours' ? sLM / 60 : sLM;
  const form = { amount: String(amount), unit, telegramChatId: s.telegramChatId || '', telegramToken: s.telegramToken || '', todoDays: String(s.todoLeadDays != null ? s.todoLeadDays : 0), schedAmount: String(schedAmount), schedUnit };

  const body = h('div', null,
    h('div', { class: 'hint', style: { margin: '2px 2px 14px' } }, 'All reminders are sent to your Telegram. Set it up below.'),
    h('div', { class: 'section-title' }, 'Event reminders'),
    h('div', { class: 'field' }, h('label', null, 'Remind me before each event'),
      h('div', { class: 'row2' },
        h('input', { type: 'number', inputmode: 'numeric', min: '1', value: form.amount, oninput: e => form.amount = e.target.value }),
        h('select', { onchange: e => form.unit = e.target.value },
          h('option', { value: 'minutes', selected: form.unit === 'minutes' ? 'selected' : null }, 'minutes before'),
          h('option', { value: 'hours', selected: form.unit === 'hours' ? 'selected' : null }, 'hours before')))),
    h('div', { class: 'section-title' }, 'To-do reminders'),
    h('div', { class: 'field' }, h('label', null, 'Start reminding me before the due date'),
      h('div', { class: 'row2' },
        h('input', { type: 'number', inputmode: 'numeric', min: '0', value: form.todoDays, oninput: e => form.todoDays = e.target.value }),
        h('div', { class: 'total-box' }, 'days before')),
      h('div', { class: 'hint' }, 'Set 0 to remind only on the due date. It nudges once a day until the list is done.')),
    h('div', { class: 'section-title' }, 'Weekly schedule reminders'),
    h('div', { class: 'field' }, h('label', null, 'Remind me before each session'),
      h('div', { class: 'row2' },
        h('input', { type: 'number', inputmode: 'numeric', min: '1', value: form.schedAmount, oninput: e => form.schedAmount = e.target.value }),
        h('select', { onchange: e => form.schedUnit = e.target.value },
          h('option', { value: 'minutes', selected: form.schedUnit === 'minutes' ? 'selected' : null }, 'minutes before'),
          h('option', { value: 'hours', selected: form.schedUnit === 'hours' ? 'selected' : null }, 'hours before')))),
    telegramSection(form),
    h('button', { class: 'btn', style: { marginTop: '18px' }, onclick: async () => {
      const n = Math.max(1, parseInt(form.amount) || 1);
      const leadMinutes = form.unit === 'hours' ? n * 60 : n;
      const todoLeadDays = Math.max(0, parseInt(form.todoDays) || 0);
      const sn = Math.max(1, parseInt(form.schedAmount) || 1);
      const scheduleLeadMinutes = form.schedUnit === 'hours' ? sn * 60 : sn;
      await DB.saveSettings({ leadMinutes, telegramChatId: form.telegramChatId.trim(), telegramToken: form.telegramToken.trim(), todoLeadDays, scheduleLeadMinutes });
      toast('Settings saved');
      startReminders();
      navigate('#/');
    } }, 'Save settings'));

  const bar = appbar('Settings', null, { back: () => goBack() });
  mount(screen(bar, body));
}

/* ---------- in-app reminder engine ---------- */
let reminderTimer = null;
function startReminders() {
  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = setInterval(checkReminders, 60000);
  currentPosition().then(p => saveLastLocation(p)); // capture location for the closed-app scheduler
  checkReminders();
}
async function checkReminders() {
  try {
    if (!CURRENT) return;
    const s = await DB.getSettings();
    if (!s.telegramToken || !s.telegramChatId) return; // reminders go to Telegram only
    const fire = (title, body) => {
      sendTelegram(s.telegramToken, s.telegramChatId, title + (body ? '\n' + body : '')).catch(() => {});
    };
    let _pos;
    const getMyPos = async () => (_pos !== undefined ? _pos : (_pos = await currentPosition()));
    const travelFor = async (d) => {
      if (typeof d.lat !== 'number' || typeof d.lng !== 'number') return '';
      const pos = await getMyPos();
      if (!pos) return '';
      saveLastLocation(pos);
      const m = await drivingMetrics(pos, [d.lat, d.lng]);
      return ` You're about ${m.km.toFixed(1)} km away — roughly ${m.mins} min to get there.`;
    };
    const lead = (s.leadMinutes || 60) * 60000;
    const now = Date.now();
    const events = await DB.listItems('events');
    for (const ev of events) {
      const d = ev.data || {};
      if (!d.when) continue;
      const t = new Date(d.when).getTime();
      if (isNaN(t) || now >= t) continue;
      const mins = Math.round((t - now) / 60000);
      const at = fmtTimeOnly(d.when);
      const title = d.title || 'your event';
      if (now >= t - lead && d._notifiedFor !== d.when) {
        const msg = mins > 0
          ? (`Hey, ${title} is coming up in ${mins} minute${mins === 1 ? '' : 's'}. ` + (d.location ? `Don't forget to be at ${d.location} by ${at}.` : `It starts at ${at}.`))
          : (`Hey, ${title} is starting now${d.location ? ` at ${d.location}` : ''}.`);
        fire(msg + (await travelFor(d)), '', 'ev-' + ev.id);
        d._notifiedFor = d.when;
        await DB.saveItem(ev);
      } else if (now >= t - lead / 2 && d._notifiedHalf !== d.when) {
        fire(`Hey, are you on your way to ${title}? It's at ${at}.` + (await travelFor(d)), '', 'evh-' + ev.id);
        d._notifiedHalf = d.when;
        await DB.saveItem(ev);
      }
    }
    // to-do due dates: nudge once a day from (eta - todoLeadDays) through the due date
    const todoLeadDays = Math.max(0, s.todoLeadDays || 0);
    const todayStr = localDateStr(new Date());
    const todayMid = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
    const todos = await DB.listItems('todo');
    for (const td of todos) {
      const items = (td.data || {}).items || [];
      let changed = false;
      items.forEach((it, idx) => {
        if (!it.eta || it.checked) return;
        const startStr = etaMinusDays(it.eta, todoLeadDays);
        if (todayStr >= startStr && todayStr <= it.eta && it._notified !== todayStr) {
          const [y, m, dd] = it.eta.split('-').map(Number);
          const daysLeft = Math.round((new Date(y, m - 1, dd) - todayMid) / 86400000);
          const due = daysLeft > 0 ? ('due in ' + daysLeft + ' day' + (daysLeft > 1 ? 's' : '')) : 'due today';
        fire(`Hey, don't forget: ${it.name || 'your to-do'} is ${due} (${fmtDate(it.eta)}).`, '', 'todo-' + td.id + '-' + idx);
          it._notified = todayStr;
          changed = true;
        }
      });
      if (changed) await DB.saveItem(td);
    }
    // weekly schedule sessions (each date+time, like events)
    const schedLead = (s.scheduleLeadMinutes || 60) * 60000;
    const schedules = await DB.listItems('schedule');
    for (const sc of schedules) {
      const d = sc.data || {};
      let changed = false;
      const slots = d.slots || [];
      for (let idx = 0; idx < slots.length; idx++) {
        const slot = slots[idx];
        if (slot.day === undefined || !slot.start) continue;
        const occ = nextWeekdayOccurrence(Number(slot.day), slot.start);
        const t = occ.getTime();
        const occKey = localDateStr(occ);
        if (d.repeatMode === 'until' && d.until && occKey > d.until) continue; // schedule has ended
        if (now >= t) continue;
        const mins = Math.round((t - now) / 60000);
        const at = fmtHM(slot.start); // AM/PM
        const title = d.title || 'your schedule';
        if (now >= t - schedLead && slot._notifiedFor !== occKey) {
          const msg = mins > 0
            ? (`Hey, ${title} is coming up in ${mins} minute${mins === 1 ? '' : 's'}. ` + (d.location ? `Don't forget to be at ${d.location} by ${at}.` : `It starts at ${at}.`))
            : (`Hey, ${title} is starting now${d.location ? ` at ${d.location}` : ''}.`);
          fire(msg + (await travelFor(d)), '', 'sched-' + sc.id + '-' + idx);
          slot._notifiedFor = occKey;
          changed = true;
        } else if (now >= t - schedLead / 2 && slot._notifiedHalf !== occKey) {
          fire(`Hey, are you on your way to ${title}? It's at ${at}.` + (await travelFor(d)), '', 'schedh-' + sc.id + '-' + idx);
          slot._notifiedHalf = occKey;
          changed = true;
        }
      }
      if (changed) await DB.saveItem(sc);
    }
  } catch (e) { /* ignore */ }
}
function localDateStr(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function etaMinusDays(etaStr, days) {
  const [y, m, dd] = etaStr.split('-').map(Number);
  const d = new Date(y, m - 1, dd); d.setDate(d.getDate() - days);
  return localDateStr(d);
}

/* ============================================================
   BOOT
   ============================================================ */
export async function startApp() {
  await initStorage();
  // Convenience: on localhost in local mode, auto-sign-in a test user so the
  // developer/tester skips the login screen. Never triggers on the deployed site.
  if (MODE === 'local' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && !LS.get('mln_session', null)) {
    const email = 'test@local';
    LS.set('mln_session', { uid: 'local_' + (await sha256(email)).slice(0, 16), email });
  }
  // Shared-card links arrive as ?s=<code>. Try to hand off to Chrome unless we're already
  // in Chrome / a normal browser (?here=1 means the user chose to stay put).
  const sp = new URLSearchParams(location.search);
  const shareCode = sp.get('s');
  if (shareCode) {
    if (!sp.get('here') && isInAppBrowser() && !isChrome()) { showOpenInChrome(shareCode); return; }
    history.replaceState(null, '', location.pathname + '#/import/' + shareCode);
  }
  Auth.onChange(() => { routeChanged(); if (CURRENT) startReminders(); });
  window.addEventListener('hashchange', routeChanged);
  // register service worker (PWA install) + auto-update to newest deploy
  if ('serviceWorker' in navigator) {
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js').then((reg) => reg.update()).catch(() => {});
  }
}
