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
function compressImage(file, maxDim = 1200, quality = 0.62) {
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
const DB = {
  async listItems(cat) {
    if (MODE === 'firebase') {
      const { collection, getDocs, query, where } = fb.f;
      const snap = await getDocs(query(collection(fb.db, 'users', CURRENT.uid, 'items'), where('cat', '==', cat)));
      const out = [];
      snap.forEach(d => out.push({ id: d.id, ...d.data() }));
      return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }
    const all = LS.get('mln_items_' + CURRENT.uid, []);
    return all.filter(i => i.cat === cat).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  },
  async getItem(cat, id) {
    if (MODE === 'firebase') {
      const { doc, getDoc } = fb.f;
      const d = await getDoc(doc(fb.db, 'users', CURRENT.uid, 'items', id));
      return d.exists() ? { id: d.id, ...d.data() } : null;
    }
    return LS.get('mln_items_' + CURRENT.uid, []).find(i => i.id === id) || null;
  },
  async saveItem(item) {
    item.updatedAt = Date.now();
    if (!item.id) item.id = uid();
    if (MODE === 'firebase') {
      const { doc, setDoc } = fb.f;
      const { id, ...rest } = item;
      await setDoc(doc(fb.db, 'users', CURRENT.uid, 'items', id), rest, { merge: true });
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
      await deleteDoc(doc(fb.db, 'users', CURRENT.uid, 'items', id));
    } else {
      const key = 'mln_items_' + CURRENT.uid;
      LS.set(key, LS.get(key, []).filter(i => i.id !== id));
    }
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
    return Object.assign({ leadMinutes: 60, notify: false, telegramChatId: '', todoLeadDays: 0 }, it ? it.data : {});
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
  }
};

/* ============================================================
   CATEGORIES
   ============================================================ */
const CATS = [
  { key: 'recipes', name: 'Recipes', emoji: '🍳' },
  { key: 'records', name: 'Personal Records', emoji: '🔐' },
  { key: 'memberships', name: 'Memberships', emoji: '💳' },
  { key: 'warranty', name: 'Warranty Tracker', emoji: '🧾' },
  { key: 'tax', name: 'Tax Receipts', emoji: '💵' },
  { key: 'party', name: 'Party Planner', emoji: '🎉' },
  { key: 'trips', name: 'Trip Planner', emoji: '🧳' },
  { key: 'shopping', name: 'Shopping List', emoji: '🛒' },
  { key: 'shopitem', name: 'Saved Item', emoji: '🏷️', hidden: true },
  { key: 'todo', name: 'To-Do List', emoji: '✅' },
  { key: 'quick', name: 'Quick Note', emoji: '📝' },
  { key: 'events', name: 'Events', emoji: '📅' }
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

/* single image picker -> stores image id in obj[key] */
function imagePicker(obj, key) {
  if (!Array.isArray(obj[key])) obj[key] = obj[key] ? [obj[key]] : [];
  return imageMulti(obj, key, false);
}
function imageMulti(obj, key, multiple = true) {
  if (!Array.isArray(obj[key])) obj[key] = [];
  const box = h('div', { class: 'imgbox' });
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
function buildEditor(cat, data) {
  const F = h('div');
  const a = (...n) => add(F, n);
  switch (cat) {
    case 'recipes': {
      a(field('Recipe title', data, 'title', { placeholder: 'e.g. Chicken Rice' }));
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
      a(field('Event date', data, 'eventDate', { type: 'date', hint: 'After this date it moves to the Archive tab.' }));
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
      a(field('Due date / ETA (optional)', data, 'eta', { type: 'date', hint: 'Set a reminder cadence in ⚙ Settings.' }));
      a(h('div', { class: 'section-title' }, 'To-do items (tick them off in the list view)'));
      a(checklistEditor(data, 'items', 'To-do item'));
      break;
    }
    case 'trips': {
      a(field('Trip name', data, 'title', { placeholder: 'e.g. Langkawi June' }));
      a(selectField('Trip type', data, 'tripType',
        [{ value: 'City trip', label: 'City trip' }, { value: 'Beach trip', label: 'Beach trip' }, { value: 'Other', label: 'Other' }]));
      a(field('Dates / notes', data, 'notes', { placeholder: 'e.g. 12–15 June' }));
      a(h('div', { class: 'section-title' }, 'Packing list (tick when packed in the trip view)'));
      a(checklistEditor(data, 'items', 'Item to bring'));
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
      a(shopCategoryField(data));
      a(field('Notes', data, 'notes', { type: 'textarea', placeholder: 'Any notes…' }));
      a(h('div', { class: 'section-title' }, 'Picture of item'));
      a(imagePicker(data, 'images'));
      a(h('div', { class: 'section-title' }, 'Price by shop (add as many as you like to compare)'));
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
      {
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
        a(h('div', { class: 'field' }, h('label', null, 'Google Maps (link, address, or coordinates)'), mapInput));
        a(mapStatus);
      }
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
  }
  return F;
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
        imageMulti(ing, 'imgs', true)));
    });
    wrap.appendChild(h('button', { class: 'btn ghost', type: 'button', onclick: () => { data.ingredients.push({ name: '', imgs: [] }); draw(); } }, '+ Add ingredient'));
  }
  draw();
  return wrap;
}

/* recipe steps: text + optional photo each */
function stepsEditor(data) {
  if (!Array.isArray(data.steps)) data.steps = [];
  const wrap = h('div');
  function draw() {
    wrap.innerHTML = '';
    data.steps.forEach((st, i) => {
      const block = h('div', { class: 'sub-item' },
        h('div', { class: 'sub-head' },
          h('span', { class: 'num' }, 'STEP ' + (i + 1)),
          h('span', { class: 'grow' }),
          h('button', { class: 'del-x', type: 'button', onclick: () => { if (!confirmDel('Remove this step?')) return; data.steps.splice(i, 1); draw(); } }, '✕')),
        h('textarea', { placeholder: 'Describe this step…', oninput: e => st.text = e.target.value }, st.text || ''),
        h('div', { style: { marginTop: '10px' } }, imagePicker(st, 'imgs')));
      wrap.appendChild(block);
    });
    wrap.appendChild(h('button', { class: 'btn ghost', type: 'button', onclick: () => { data.steps.push({ text: '', imgs: [] }); draw(); } }, '+ Add step'));
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

/* shopping cart editor: add new item / add saved / pick by category */
function shoppingEditor(data) {
  if (!Array.isArray(data.items)) data.items = [];
  const cart = h('div');
  const addPanel = h('div');

  function drawCart() {
    cart.innerHTML = '';
    data.items.forEach((it, i) => {
      cart.appendChild(h('div', { class: 'sub-item' },
        h('div', { class: 'sub-head' },
          h('input', { class: 'grow', placeholder: 'Item name', value: it.name || '', oninput: e => it.name = e.target.value }),
          h('button', { class: 'del-x', type: 'button', onclick: () => { if (!confirmDel('Remove this item?')) return; data.items.splice(i, 1); drawCart(); } }, '✕')),
        h('div', { class: 'row2' },
          h('input', { placeholder: 'Qty', value: it.qty || '', oninput: e => it.qty = e.target.value }),
          h('input', { placeholder: 'Price', inputmode: 'decimal', value: it.price || '', oninput: e => it.price = e.target.value })),
        h('div', { class: 'row2', style: { marginTop: '8px' } },
          h('input', { placeholder: 'Store', value: it.store || '', oninput: e => it.store = e.target.value }),
          h('input', { placeholder: 'Category', value: it.category || '', oninput: e => it.category = e.target.value }))));
    });
    cart.appendChild(h('button', { class: 'btn ghost', type: 'button', onclick: () => { data.items.push({ name: '', qty: '', store: '', category: '', price: '', checked: false }); drawCart(); } }, '+ Key in a new item'));
  }

  async function drawAddPanel(selectedCat) {
    addPanel.innerHTML = '';
    addPanel.appendChild(h('div', { class: 'hint' }, 'Loading…'));
    const [cats, saved] = await Promise.all([DB.getShopCats(), DB.listItems('shopitem')]);
    addPanel.innerHTML = '';
    const catSel = h('select', { onchange: e => drawAddPanel(e.target.value) },
      h('option', { value: '' }, 'All categories'),
      ...cats.map(c => h('option', { value: c }, c)));
    catSel.value = selectedCat || '';
    addPanel.appendChild(h('div', { class: 'field' }, h('label', null, 'Category'), catSel));
    const filtered = saved.filter(s => !selectedCat || (s.data || {}).category === selectedCat);
    if (!filtered.length) { addPanel.appendChild(h('div', { class: 'hint' }, saved.length ? 'No saved items in this category.' : 'No saved items yet — add some in the Saved items tab.')); return; }
    const itemSel = h('select', { class: 'grow', style: { minWidth: '0' } },
      h('option', { value: '' }, '— Choose a saved item —'),
      ...filtered.map(s => { const d = s.data || {}; const c = cheapestPrice(d.prices); return h('option', { value: s.id }, (d.title || 'Item') + (c ? ('  —  ' + fmtMYR(c.price) + ' @ ' + c.shop) : '')); }));
    const info = h('div', { class: 'hint', style: { marginTop: '6px' } }, '');
    itemSel.onchange = () => { const s = filtered.find(x => x.id === itemSel.value); const c = s ? cheapestPrice(s.data.prices) : null; info.textContent = c ? ('Cheapest: ' + fmtMYR(c.price) + ' @ ' + c.shop) : (s ? 'No price saved yet' : ''); };
    const addBtn = h('button', { class: 'btn small', type: 'button', onclick: () => {
      const s = filtered.find(x => x.id === itemSel.value);
      if (!s) { toast('Pick an item first'); return; }
      const d = s.data || {}; const c = cheapestPrice(d.prices);
      data.items.push({ name: d.title || '', qty: '', store: c ? c.shop : '', category: d.category || '', price: c ? c.price : '', checked: false });
      drawCart(); toast('Added to cart'); itemSel.value = ''; info.textContent = '';
    } }, '+ Add');
    addPanel.appendChild(h('div', { class: 'field' }, h('label', null, 'Add a saved item'),
      h('div', { class: 'sub-head' }, itemSel, addBtn), info));
  }

  drawCart();
  drawAddPanel('');
  return h('div', null,
    h('div', { class: 'section-title', style: { marginTop: '4px' } }, 'Add items'),
    addPanel,
    h('div', { class: 'section-title' }, 'Your cart'),
    cart);
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
        const ol = h('ol', { class: 'steps' });
        for (const st of data.steps) {
          const li = h('li', null, st.text || '');
          for (const im of await imgs(st.imgs)) li.appendChild(im);
          ol.appendChild(li);
        }
        card.appendChild(ol); a(card);
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
              b.phone ? h('a', { class: 'link-a', href: 'tel:' + b.phone.replace(/[^\d+]/g, ''), style: { marginLeft: info ? '10px' : '0' } }, '📞 ' + b.phone) : null)));
        });
        a(c);
      }
      if (data.notes) a(h('div', { class: 'detail-card' },
        h('div', { class: 'section-title' }, 'Notes'),
        h('div', { style: { whiteSpace: 'pre-wrap', lineHeight: '1.5' } }, data.notes)));
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
      a(h('div', { class: 'detail-card' }, h('h3', null, data.title || 'To-Do'),
        data.eta ? kv('Due', fmtDate(data.eta)) : null));
      a(checklistView(item, 'items', cat, 'To-do'));
      break;
    }
    case 'trips': {
      a(h('div', { class: 'detail-card' }, h('h3', null, data.title || 'Trip'),
        kv('Type', data.tripType), kv('Notes', data.notes)));
      a(checklistView(item, 'items', cat, 'Packing list'));
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
        cheap ? h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Cheapest'), h('span', { class: 'v', style: { color: 'var(--green)' } }, fmtMYR(cheap.price) + ' @ ' + cheap.shop)) : null,
        kv('Notes', data.notes));
      for (const im of await imgs(data.images)) card.appendChild(im);
      a(card);
      const priced = (data.prices || []).filter(p => p.shop || p.price);
      if (priced.length) {
        const pc = h('div', { class: 'detail-card' }, h('div', { class: 'section-title' }, 'Prices by shop'));
        priced.forEach(p => pc.appendChild(h('div', { class: 'kv' },
          h('span', { class: 'k' }, p.shop || '—'),
          h('span', { class: 'v' }, (p.price !== '' && p.price != null) ? fmtMYR(p.price) : '—'))));
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
      h('span', { class: 'ttl' }, it.name || ''));
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
  const total = items.reduce((s, i) => s + (parseFloat(i.price) || 0), 0);
  const card = h('div', { class: 'detail-card' },
    h('h3', null, data.title || 'Shopping list'),
    h('div', { class: 'hint', style: { marginBottom: '10px' } }, items.filter(i => i.checked).length + '/' + items.length + ' picked · est. ' + (total ? fmtMYR(total) : '—')));
  items.forEach(it => {
    const meta = [it.qty && ('×' + it.qty), it.store, it.category].filter(Boolean).join(' · ');
    const row = h('div', { class: 'check-row' + (it.checked ? ' done' : '') },
      h('div', { class: 'cb' + (it.checked ? ' on' : '') }),
      h('div', { class: 'ttl' }, it.name || '', meta ? h('div', { class: 'px' }, meta) : null),
      (it.price !== '' && it.price != null) ? h('span', { class: 'px' }, fmtMYR(it.price)) : null);
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
      const thumb = ingArr.flatMap(x => x.imgs || [])[0] || (data.steps || []).flatMap(s => s.imgs || [])[0] || (data.ingredientImgs || [])[0];
      return { title: data.title || 'Recipe', meta: ingCount + ' ingredients · ' + (data.steps || []).length + ' steps', thumb, fav: data.fav };
    }
    case 'records': return { title: data.title || 'Record', meta: data.recType === 'address' ? (data.recipient || 'Address') : (data.bank || 'Bank account') };
    case 'memberships': return { title: data.title || 'Membership', meta: data.member || data.number || '', thumb: (data.images || [])[0] };
    case 'warranty': return { title: data.title || 'Item', meta: [data.shop, data.expiry && ('exp ' + fmtDate(data.expiry))].filter(Boolean).join(' · '), thumb: (data.images || [])[0] };
    case 'tax': return { title: data.title || 'Receipt', meta: [data.taxCat, data.year, (data.amount != null && data.amount !== '') && fmtMYR(data.amount)].filter(Boolean).join(' · '), thumb: (data.images || [])[0] };
    case 'todo': return { title: data.title || 'To-Do', meta: [(data.eta && ('due ' + fmtDate(data.eta))), (data.items || []).filter(i => i.checked).length + '/' + (data.items || []).length + ' done'].filter(Boolean).join(' · ') };
    case 'party': return { title: data.title || 'Party', meta: [data.eventDate && fmtDate(data.eventDate), data.theme].filter(Boolean).join(' · ') };
    case 'trips': return { title: data.title || 'Trip', meta: (data.tripType || '') + ' · ' + (data.items || []).filter(i => i.checked).length + '/' + (data.items || []).length + ' packed' };
    case 'shopping': return { title: data.title || 'Shopping list', meta: (data.items || []).filter(i => i.checked).length + '/' + (data.items || []).length + ' picked' };
    case 'shopitem': {
      const c = cheapestPrice(data.prices);
      return { title: data.title || 'Item', meta: [data.category, data.brand, c && (fmtMYR(c.price) + ' @ ' + c.shop)].filter(Boolean).join(' · '), thumb: (data.images || [])[0] };
    }
    case 'quick': return { title: data.title || 'Note', meta: ((data.bodyHtml || '').replace(/<[^>]+>/g, ' ').trim() || data.body || '').slice(0, 60) };
    case 'events': return { title: data.title || 'Event', meta: [fmtDT(data.when), data.location].filter(Boolean).join(' · ') };
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

/* accurate driving distance/time for the event detail card */
async function computeDistance(item, info) {
  info.innerHTML = '';
  info.appendChild(h('div', { class: 'hint' }, 'Calculating distance from you…'));
  try {
    const pos = await currentPosition();
    if (!pos) throw new Error('geo');
    const dest = await placeCoords(item);
    if (!dest) throw new Error('place-not-found');
    let km, mins;
    try {
      const r = await fetch('https://router.project-osrm.org/route/v1/driving/' + pos.lon + ',' + pos.lat + ';' + dest[1] + ',' + dest[0] + '?overview=false').then(x => x.json());
      const route = r.routes && r.routes[0];
      if (route) { km = route.distance / 1000; mins = Math.round(route.duration / 60); }
    } catch (e) {}
    if (km == null) { km = haversineKm(pos.lat, pos.lon, dest[0], dest[1]); mins = Math.round(km / 40 * 60); }
    info.innerHTML = '';
    info.appendChild(h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Distance'), h('span', { class: 'v' }, km.toFixed(1) + ' KM')));
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
  ed.addEventListener('input', () => data[key] = ed.innerHTML);
  const run = (c) => { document.execCommand(c, false, null); ed.focus(); data[key] = ed.innerHTML; };
  const btn = (content, c) => h('button', { class: 'rte-btn', type: 'button', onmousedown: e => { e.preventDefault(); run(c); } }, content);
  const toolbar = h('div', { class: 'rte-toolbar' },
    btn(h('b', null, 'B'), 'bold'),
    btn(h('i', null, 'I'), 'italic'),
    btn(h('u', null, 'U'), 'underline'),
    btn('• List', 'insertUnorderedList'));
  return h('div', null, toolbar, ed);
}
function openLightbox(src) {
  const ov = h('div', { class: 'lightbox', onclick: () => ov.remove() },
    h('img', { src }),
    h('div', { class: 'lightbox-close' }, '✕'));
  document.body.appendChild(ov);
}
function confirmDel(msg) { return window.confirm(msg || 'Delete this?'); }
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
  // saved items live under the Shopping List screen, not their own
  if (cat === 'shopitem') { navigate('#/cat/shopping/items'); return; }
  const bar = appbar(catName(cat), null, { back: () => navigate('#/') });
  const listEl = h('div', { class: 'list' }, h('div', { class: 'spinner' }));
  mount(screen(bar, listEl));
  const fab = h('button', { class: 'fab', onclick: () => navigate('#/edit/' + cat) }, '+');
  $app().appendChild(fab);

  const items = await DB.listItems(cat);
  listEl.innerHTML = '';

  if (cat === 'party') { renderArchiveList(listEl, 'party', items, partyIsArchived, { duplicate: true }); return; }
  if (cat === 'events') { renderArchiveList(listEl, 'events', items, eventIsArchived, { distance: true }); return; }
  if (cat === 'tax') { renderTaxList(listEl, items); return; }
  if (cat === 'shopping') { renderShoppingScreen(listEl, items, fab, sub === 'items' ? 'items' : 'lists'); return; }

  if (!items.length) {
    listEl.appendChild(emptyState(cat));
    return;
  }
  for (const it of items) {
    const canDelete = cat === 'todo' || cat === 'quick';
    const del = canDelete
      ? h('button', { class: 'row-del', type: 'button', title: 'Delete', onclick: async (e) => {
          e.stopPropagation();
          if (!confirmDel('Delete this ' + (cat === 'quick' ? 'note' : 'to-do list') + '?')) return;
          await DB.deleteItem(cat, it.id); toast('Deleted'); navigate('#/cat/' + cat);
        } }, '🗑')
      : null;
    const target = cat === 'quick' ? ('#/edit/quick/' + it.id) : undefined;
    listEl.appendChild(buildRow(cat, it, { action: del, target }));
  }
}

async function renderShoppingScreen(listEl, lists, fab, initialTab) {
  const items = await DB.listItems('shopitem');
  let tab = initialTab || 'lists';
  const tabsEl = h('div', { class: 'tabs' });
  const body = h('div', { class: 'list' });
  function render() {
    tabsEl.innerHTML = '';
    [['lists', 'Shopping lists (' + lists.length + ')'], ['items', 'Saved items (' + items.length + ')'], ['cats', 'Categories']].forEach(([k, label]) =>
      tabsEl.appendChild(h('div', { class: 'tab' + (tab === k ? ' active' : ''), onclick: () => { tab = k; render(); } }, label)));
    body.innerHTML = '';
    if (tab === 'cats') {
      if (fab) fab.style.display = 'none';
      renderCategoryManager(body);
      return;
    }
    if (fab) fab.style.display = '';
    if (tab === 'lists') {
      if (fab) fab.onclick = () => navigate('#/edit/shopping');
      if (!lists.length) { body.appendChild(emptyState('shopping', 'No shopping lists yet. Tap + to create one.')); return; }
      for (const it of lists) body.appendChild(buildRow('shopping', it));
    } else {
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
  const row = h('div', { class: 'row', onclick: () => navigate(target) },
    s.thumb ? h('img', { class: 'thumb', src: '' }) : null,
    h('div', { class: 'main' },
      h('div', { class: 'title' }, s.fav ? h('span', { class: 'fav-star' }, '★ ') : null, s.title),
      s.meta ? h('div', { class: 'meta' }, s.meta) : null),
    opts.action || h('div', { class: 'chev' }, '›'));
  if (s.thumb) DB.getImage(s.thumb).then(src => { const img = row.querySelector('.thumb'); if (img && src) img.src = src; });
  return row;
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
function eventIsArchived(it) {
  const d = it.data || {};
  return d.archived || dayPassed(d.when || d.eventDate);
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
  function render() {
    tabsEl.innerHTML = '';
    [['upcoming', 'Upcoming (' + upcoming.length + ')'], ['archive', 'Archive (' + archived.length + ')']].forEach(([k, label]) =>
      tabsEl.appendChild(h('div', { class: 'tab' + (tab === k ? ' active' : ''), onclick: () => { tab = k; render(); } }, label)));
    body.innerHTML = '';
    const list = tab === 'upcoming' ? upcoming : archived;
    if (!list.length) { body.appendChild(emptyState(cat, tab === 'upcoming' ? 'Nothing upcoming.' : 'Nothing archived yet.')); return; }
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
  const km = haversineKm(pos.lat, pos.lon, dest[0], dest[1]);
  const mins = Math.round(km / 40 * 60);
  const txt = km.toFixed(1) + ' KM · ~' + mins + ' min';
  const meta = row.querySelector('.meta');
  if (meta) meta.textContent = meta.textContent + ' · ' + txt;
  else { const main = row.querySelector('.main'); if (main) main.appendChild(h('div', { class: 'meta' }, txt)); }
}

/* ----- EDITOR ----- */
async function editScreen(cat, id) {
  let item = id ? await DB.getItem(cat, id) : null;
  let currentId = id;
  const data = item ? JSON.parse(JSON.stringify(item.data || {})) : {};
  const formHost = h('div');
  function renderForm() { formHost.innerHTML = ''; formHost.appendChild(buildEditor(cat, data)); }
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
    const saved = await DB.saveItem({ id: currentId || undefined, cat, data });
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
    const delBtn = h('button', { class: 'btn danger', onclick: async () => {
      if (confirm('Delete this note?')) { if (currentId) await DB.deleteItem(cat, currentId); toast('Deleted'); navigate('#/cat/' + cat); }
    } }, 'Delete');
    controls = h('div', { style: { marginTop: '18px' } }, status, delBtn);
  } else {
    const saveBtn = h('button', { class: 'btn', onclick: async () => {
      if (!hasContent()) { toast('Add a title first'); return; }
      await saveNow(); toast('Saved'); navigate('#/view/' + cat + '/' + currentId);
    } }, id ? 'Save changes' : 'Save');
    const delBtn = currentId ? h('button', { class: 'btn danger', style: { marginTop: '10px' }, onclick: async () => {
      if (confirm('Delete this note?')) { await DB.deleteItem(cat, currentId); toast('Deleted'); navigate('#/cat/' + cat); }
    } }, 'Delete') : null;
    controls = h('div', { style: { marginTop: '18px' } }, saveBtn, delBtn);
  }

  const bar = appbar((id ? 'Edit ' : 'New ') + catName(cat).replace(/s$/, ''), null, {
    back: async () => { if (isQuick) await saveNow(); navigate(currentId ? '#/view/' + cat + '/' + currentId : '#/cat/' + cat); }
  });
  mount(screen(bar, h('div', null, formHost, controls)));
}

/* ----- DETAIL ----- */
async function viewScreen(cat, id) {
  const item = await DB.getItem(cat, id);
  if (!item) { navigate('#/cat/' + cat); return; }
  const bar = appbar(catName(cat).replace(/s$/, ''), null, {
    back: () => navigate('#/cat/' + cat),
    action: h('button', { class: 'iconbtn', title: 'Edit', onclick: () => navigate('#/edit/' + cat + '/' + id) }, '✎')
  });
  const host = h('div', null, h('div', { class: 'spinner' }));
  mount(screen(bar, host));
  const detail = await renderDetail(cat, item);
  host.innerHTML = '';
  host.appendChild(detail);
}

/* ============================================================
   ROUTER
   ============================================================ */
function navigate(hash) { if (location.hash === hash) routeChanged(); else location.hash = hash; }

function routeChanged() {
  if (!CURRENT) {
    const v = location.hash.includes('signup') ? 'signup' : location.hash.includes('forgot') ? 'forgot' : 'login';
    mount(authScreen(v));
    return;
  }
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  // remove any stray FAB from previous screen
  const stale = $app().querySelector('.fab'); if (stale) stale.remove();

  if (parts.length === 0) return void homeScreen();
  if (parts[0] === 'settings') return void settingsScreen();
  if (parts[0] === 'cat') return void listScreen(parts[1], parts[2]);
  if (parts[0] === 'edit') return void editScreen(parts[1], parts[2]);
  if (parts[0] === 'view') return void viewScreen(parts[1], parts[2]);
  homeScreen();
}

/* ----- SETTINGS ----- */
async function settingsScreen() {
  const s = await DB.getSettings();
  // present lead time as value + unit
  let unit = (s.leadMinutes % 60 === 0 && s.leadMinutes >= 60) ? 'hours' : 'minutes';
  let amount = unit === 'hours' ? s.leadMinutes / 60 : s.leadMinutes;
  const form = { amount: String(amount), unit, notify: s.notify, telegramChatId: s.telegramChatId || '', todoDays: String(s.todoLeadDays != null ? s.todoLeadDays : 0) };

  const status = h('div', { class: 'hint', style: { marginTop: '6px' } },
    ('Notification' in window) ? ('Browser notifications: ' + Notification.permission) : 'This browser has no notifications.');

  const notifyBtn = h('button', { class: 'btn small ' + (form.notify ? '' : 'secondary'), type: 'button' },
    form.notify ? '✓ Reminders on' : 'Turn on reminders');
  notifyBtn.onclick = async () => {
    if (!form.notify) {
      if (!('Notification' in window)) { toast('Notifications not supported here'); return; }
      const perm = await Notification.requestPermission();
      status.textContent = 'Browser notifications: ' + perm;
      if (perm !== 'granted') { toast('Permission not granted'); return; }
      form.notify = true;
    } else { form.notify = false; }
    notifyBtn.className = 'btn small ' + (form.notify ? '' : 'secondary');
    notifyBtn.textContent = form.notify ? '✓ Reminders on' : 'Turn on reminders';
  };

  const body = h('div', null,
    h('div', { class: 'section-title' }, 'Event reminders'),
    h('div', { class: 'field' }, h('label', null, 'Remind me before each event'),
      h('div', { class: 'row2' },
        h('input', { type: 'number', inputmode: 'numeric', min: '1', value: form.amount, oninput: e => form.amount = e.target.value }),
        h('select', { onchange: e => form.unit = e.target.value },
          h('option', { value: 'minutes', selected: form.unit === 'minutes' ? 'selected' : null }, 'minutes before'),
          h('option', { value: 'hours', selected: form.unit === 'hours' ? 'selected' : null }, 'hours before')))),
    h('div', { class: 'field' }, notifyBtn, status),
    h('button', { class: 'btn secondary', style: { marginTop: '4px' }, type: 'button', onclick: () => {
      if (!('Notification' in window) || Notification.permission !== 'granted') { toast('Turn on reminders first'); return; }
      new Notification('MyLife Hub', { body: 'Test reminder — notifications are working ✅', icon: 'icons/icon-192.png' });
    } }, 'Send a test notification'),
    h('div', { class: 'section-title' }, 'To-do reminders'),
    h('div', { class: 'field' }, h('label', null, 'Start reminding me before the due date'),
      h('div', { class: 'row2' },
        h('input', { type: 'number', inputmode: 'numeric', min: '0', value: form.todoDays, oninput: e => form.todoDays = e.target.value }),
        h('div', { class: 'total-box' }, 'days before')),
      h('div', { class: 'hint' }, 'Set 0 to remind only on the due date. It nudges once a day until the list is done.')),
    h('div', { class: 'section-title' }, 'Telegram (for reminders when the app is closed)'),
    h('div', { class: 'field' }, h('label', null, 'Telegram chat ID'),
      h('input', { value: form.telegramChatId, placeholder: 'e.g. 123456789', oninput: e => form.telegramChatId = e.target.value, autocapitalize: 'none' }),
      h('div', { class: 'hint' }, 'Used by the scheduled reminder sender (see README). Optional.')),
    h('button', { class: 'btn', style: { marginTop: '18px' }, onclick: async () => {
      const n = Math.max(1, parseInt(form.amount) || 1);
      const leadMinutes = form.unit === 'hours' ? n * 60 : n;
      const todoLeadDays = Math.max(0, parseInt(form.todoDays) || 0);
      await DB.saveSettings({ leadMinutes, notify: form.notify, telegramChatId: form.telegramChatId.trim(), todoLeadDays });
      toast('Settings saved');
      startReminders();
      navigate('#/');
    } }, 'Save settings'));

  const bar = appbar('Settings', null, { back: () => navigate('#/') });
  mount(screen(bar, body));
}

/* ---------- in-app reminder engine ---------- */
let reminderTimer = null;
function startReminders() {
  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = setInterval(checkReminders, 60000);
  checkReminders();
}
async function checkReminders() {
  try {
    if (!CURRENT || !('Notification' in window) || Notification.permission !== 'granted') return;
    const s = await DB.getSettings();
    if (!s.notify) return;
    const lead = (s.leadMinutes || 60) * 60000;
    const now = Date.now();
    const events = await DB.listItems('events');
    for (const ev of events) {
      const d = ev.data || {};
      if (!d.when) continue;
      const t = new Date(d.when).getTime();
      if (isNaN(t)) continue;
      if (now >= t - lead && now < t && d._notifiedFor !== d.when) {
        const mins = Math.round((t - now) / 60000);
        new Notification('⏰ ' + (d.title || 'Event'), {
          body: (mins > 0 ? ('In about ' + mins + ' min' + (d.location ? ' · ' + d.location : '')) : 'Starting now') + ' · ' + fmtDT(d.when),
          icon: 'icons/icon-192.png', tag: 'ev-' + ev.id
        });
        d._notifiedFor = d.when;
        await DB.saveItem(ev);
      }
    }
    // to-do due dates: nudge once a day from (eta - todoLeadDays) through the due date
    const todoLeadDays = Math.max(0, s.todoLeadDays || 0);
    const todayStr = localDateStr(new Date());
    const todos = await DB.listItems('todo');
    for (const td of todos) {
      const d = td.data || {};
      if (!d.eta) continue;
      const items = d.items || [];
      if (items.length && items.every(i => i.checked)) continue; // already done
      const startStr = etaMinusDays(d.eta, todoLeadDays);
      if (todayStr >= startStr && todayStr <= d.eta && d._todoNotified !== todayStr) {
        const [y, m, dd] = d.eta.split('-').map(Number);
        const daysLeft = Math.round((new Date(y, m - 1, dd) - new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())) / 86400000);
        new Notification('✅ ' + (d.title || 'To-do') + ' — due ' + fmtDate(d.eta), {
          body: daysLeft > 0 ? ('Due in ' + daysLeft + ' day' + (daysLeft > 1 ? 's' : '')) : 'Due today',
          icon: 'icons/icon-192.png', tag: 'todo-' + td.id
        });
        d._todoNotified = todayStr;
        await DB.saveItem(td);
      }
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
