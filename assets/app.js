'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (t, c, txt) => { const e = document.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e; };

const norm = s => (s || '').toString().toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const keyOf = it => `${norm(it.artist)}|${norm(it.title)}|${norm(it.vinil)}|${norm(it.capa)}`;
const money = v => 'R$ ' + Math.round(v).toLocaleString('pt-BR');

function parseMoneyBR(s) {
  if (!s) return null;
  let t = s.toString().replace(/[^\d.,]/g, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const v = parseFloat(t);
  return isNaN(v) ? null : v;
}

// --- CSV parser (aspas, vírgulas, quebras) ---
function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c === '\r') { /* skip */ }
    else cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

let DATA = null;          // catalog.json
let AVAIL = null;         // Map<key, {n, prices[]}> da planilha ao vivo (null = offline)
let ITEMS = [];           // itens exibíveis (com preço vigente)
const F = { q: '', sort: 'az', vinil: new Set(), tags: new Set(), genre: new Set(), style: new Set(), decade: new Set(), pmin: null, pmax: null };

// -------- boot --------
(async function () {
  try {
    const r = await fetch('catalog.json?_=' + Date.now());
    if (!r.ok) throw new Error('HTTP ' + r.status);
    DATA = await r.json();
  } catch (e) {
    console.error('catálogo indisponível:', e);
    $('#grid').innerHTML = '<p style="grid-column:1/-1;text-align:center;color:var(--muted);padding:40px">' +
      'Não consegui carregar o catálogo agora. Recarregue a página em instantes.</p>';
    $('#live').innerHTML = '<span class="dot stale"></span> catálogo indisponível';
    return;
  }
  wireContacts();
  buildFilters();
  computeItems();
  render();
  refreshLive();               // busca a planilha ao vivo e re-renderiza
})();

function wireContacts() {
  const c = DATA.contacts;
  $$('[data-c]').forEach(a => { a.href = c[a.dataset.c] || '#'; });
  const fl = $('#footLinks');
  [['WhatsApp', c.whatsapp], ['Mercado Livre', c.mercadolivre], ['Shopee', c.shopee], ['Instagram', c.instagram]]
    .forEach(([t, u]) => { const a = el('a', null, t); a.href = u; a.target = '_blank'; a.rel = 'noopener'; fl.appendChild(a); });
}

// -------- planilha ao vivo --------
async function refreshLive() {
  try {
    const txt = await (await fetch(DATA.sheet.csv_url, { cache: 'no-store' })).text();
    const rows = parseCSV(txt);
    let h = rows.findIndex(r => r.some(c => norm(c) === 'artista'));
    if (h < 0) throw new Error('cabeçalho não encontrado');
    const H = rows[h].map(norm);
    const col = {
      artist: H.indexOf('artista'),
      title: H.findIndex(x => x === 'titulo' || x === 'title'),
      vinil: H.indexOf('vinil'), capa: H.indexOf('capa'),
      price: H.findIndex(x => x.includes('venda')),
      vend: H.findIndex(x => x.includes('vendido')),
    };
    const map = new Map();
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i];
      const artist = (r[col.artist] || '').trim(), title = (r[col.title] || '').trim();
      if (!artist || !title) continue;
      if (col.vend >= 0 && (r[col.vend] || '').trim()) continue;      // vendido -> fora
      const price = parseMoneyBR(r[col.price]);
      if (!price) continue;                                            // sem preço na F -> fora
      const k = `${norm(artist)}|${norm(title)}|${norm(r[col.vinil])}|${norm(r[col.capa])}`;
      const e = map.get(k) || { n: 0, prices: [] };
      e.n++; e.prices.push(price); map.set(k, e);
    }
    AVAIL = map;
    setLive(true);
  } catch (err) {
    AVAIL = null;
    setLive(false);
    console.warn('planilha ao vivo indisponível:', err);
  }
  computeItems(); render();
}

function setLive(ok) {
  const d = $('#live');
  if (ok) d.innerHTML = `<span class="dot"></span> lista <b>atualizada agora</b> — sincronizada com o estoque`;
  else d.innerHTML = `<span class="dot stale"></span> mostrando a última sincronização`;
}

// itens exibíveis: se a planilha ao vivo respondeu, só os ainda disponíveis (e com preço vigente)
function computeItems() {
  if (!AVAIL) { ITEMS = DATA.items.map(x => ({ ...x, price: x.preco })); return; }
  const used = new Map();
  ITEMS = [];
  for (const it of DATA.items) {
    const k = keyOf(it);
    const e = AVAIL.get(k);
    const u = used.get(k) || 0;
    if (e && u < e.n) { used.set(k, u + 1); ITEMS.push({ ...it, price: e.prices[u] }); }
  }
}

// -------- filtros --------
function uniq(arr) { return [...new Set(arr.filter(Boolean))]; }
function decadeOf(y) { const n = parseInt(y, 10); return n ? (Math.floor(n / 10) * 10) + 's' : null; }

function buildFilters() {
  const panel = $('#filters'); panel.innerHTML = '';
  const items = DATA.items;
  const groups = [];
  const count = arr => { const m = new Map(); arr.forEach(x => x && m.set(x, (m.get(x) || 0) + 1)); return m; };
  const gc = count(items.flatMap(i => i.genre || []));
  const sc = count(items.flatMap(i => i.style || []));
  const genres = [...gc.keys()].sort();
  const styles = [...sc.entries()].filter(([, n]) => n >= 4).map(([k]) => k).sort();   // só estilos frequentes
  const decades = uniq(items.map(i => decadeOf(i.year))).sort();
  const vinis = uniq(items.map(i => i.vinil)).sort();
  const tags = uniq(items.flatMap(i => i.tags || []));

  if (genres.length) groups.push(['Gênero', 'genre', genres]);
  if (styles.length) groups.push(['Estilo', 'style', styles]);
  if (decades.length) groups.push(['Década', 'decade', decades]);
  if (vinis.length) groups.push(['Condição do vinil', 'vinil', vinis]);
  if (tags.length) groups.push(['Formato', 'tags', tags]);

  for (const [label, kind, vals] of groups) {
    const g = el('div', 'fgroup'); g.appendChild(el('h4', null, label));
    const chips = el('div', 'chips');
    for (const v of vals) {
      const c = el('button', 'chip', kind === 'vinil' ? 'Vinil ' + v : v);
      c.onclick = () => { F[kind].has(v) ? F[kind].delete(v) : F[kind].add(v); c.classList.toggle('on'); render(); };
      chips.appendChild(c);
    }
    g.appendChild(chips); panel.appendChild(g);
  }
  // preço
  const pg = el('div', 'fgroup'); pg.appendChild(el('h4', null, 'Preço'));
  const rng = el('div', 'range');
  const mn = el('input'); mn.type = 'number'; mn.placeholder = 'mín'; mn.min = 0;
  const mx = el('input'); mx.type = 'number'; mx.placeholder = 'máx'; mx.min = 0;
  mn.oninput = () => { F.pmin = mn.value ? +mn.value : null; render(); };
  mx.oninput = () => { F.pmax = mx.value ? +mx.value : null; render(); };
  rng.append(mn, el('span', null, '—'), mx); pg.appendChild(rng);
  const clr = el('button', 'clearf', 'limpar filtros');
  clr.onclick = () => {
    ['vinil', 'tags', 'genre', 'style', 'decade'].forEach(k => F[k].clear());
    F.pmin = F.pmax = null; mn.value = mx.value = '';
    $$('.chip.on').forEach(c => c.classList.remove('on'));
    render();
  };
  pg.appendChild(clr); panel.appendChild(pg);

  $('#filtersBtn').onclick = () => {
    const open = panel.hidden; panel.hidden = !open;
    $('#filtersBtn').setAttribute('aria-expanded', String(open));
  };
  $('#q').oninput = e => { F.q = norm(e.target.value); render(); };
  $('#sort').onchange = e => { F.sort = e.target.value; render(); };
}

function passes(it) {
  if (F.q && !(norm(it.artist) + ' ' + norm(it.title)).includes(F.q)) return false;
  if (F.vinil.size && !F.vinil.has(it.vinil)) return false;
  if (F.tags.size && ![...F.tags].every(t => (it.tags || []).includes(t))) return false;
  if (F.genre.size && !(it.genre || []).some(g => F.genre.has(g))) return false;
  if (F.style.size && !(it.style || []).some(s => F.style.has(s))) return false;
  if (F.decade.size && !F.decade.has(decadeOf(it.year))) return false;
  if (F.pmin != null && it.price < F.pmin) return false;
  if (F.pmax != null && it.price > F.pmax) return false;
  return true;
}

// -------- render --------
function render() {
  let list = ITEMS.filter(passes);
  if (F.sort === 'az') list.sort((a, b) => (a.artist + a.title).localeCompare(b.artist + b.title, 'pt'));
  else if (F.sort === 'price-asc') list.sort((a, b) => a.price - b.price);
  else if (F.sort === 'price-desc') list.sort((a, b) => b.price - a.price);

  const nf = ['vinil', 'tags', 'genre', 'style', 'decade'].reduce((s, k) => s + F[k].size, 0) + (F.pmin != null || F.pmax != null ? 1 : 0);
  $('#fcount').textContent = nf ? `(${nf})` : '';
  $('#count').textContent = `${list.length} ${list.length === 1 ? 'disco' : 'discos'} à venda`;

  const grid = $('#grid'); grid.innerHTML = '';
  $('#empty').hidden = list.length > 0;
  const frag = document.createDocumentFragment();
  for (const it of list) frag.appendChild(card(it));
  grid.appendChild(frag);
}

function card(it) {
  const c = el('div', 'card'); c.onclick = () => openModal(it);
  const im = el('div', 'card-img');
  const img = el('img'); img.loading = 'lazy'; img.alt = `${it.artist} — ${it.title}`;
  img.src = (it.img && it.img.thumb) || (it.img && it.img.cover) || '';
  im.appendChild(img);
  if ((it.tags || []).includes('Lacrado')) { const f = el('span', 'card-flag', 'Lacrado'); im.appendChild(f); }
  c.appendChild(im);
  const b = el('div', 'card-body');
  b.appendChild(el('div', 'card-artist', it.artist));
  b.appendChild(el('div', 'card-title', it.title));
  const cond = el('div', 'card-cond');
  if (it.vinil) cond.appendChild(el('span', 'pill', 'Vinil ' + it.vinil));
  if (it.capa) cond.appendChild(el('span', 'pill', 'Capa ' + it.capa));
  b.appendChild(cond);
  const p = el('div', 'card-price'); p.innerHTML = `<small>R$</small>${Math.round(it.price).toLocaleString('pt-BR')}`;
  b.appendChild(p);
  c.appendChild(b);
  return c;
}

// -------- modal --------
function openModal(it) {
  const imgs = [it.img.cover, ...((it.img.extras) || [])].filter(Boolean);
  const mImg = $('#mImg'); mImg.src = imgs[0] || ''; mImg.alt = `${it.artist} — ${it.title}`;
  const th = $('#mThumbs'); th.innerHTML = '';
  if (imgs.length > 1) imgs.forEach((src, i) => {
    const t = el('img'); t.src = src; t.className = i === 0 ? 'on' : ''; t.loading = 'lazy';
    t.onclick = () => { mImg.src = src; $$('#mThumbs img').forEach(x => x.classList.remove('on')); t.classList.add('on'); };
    th.appendChild(t);
  });
  $('#mArtist').textContent = it.artist;
  $('#mTitle').textContent = it.title;
  const meta = [it.year, it.label, ...(it.genre || [])].filter(Boolean).join(' · ');
  $('#mMeta').textContent = meta;
  const pills = $('#mPills'); pills.innerHTML = '';
  if (it.vinil) pills.appendChild(el('span', 'pill', 'Vinil ' + it.vinil));
  if (it.capa) pills.appendChild(el('span', 'pill', 'Capa ' + it.capa));
  const tags = $('#mTags'); tags.innerHTML = '';
  (it.tags || []).forEach(t => tags.appendChild(el('span', 'tag', t)));
  $('#mPrice').textContent = money(it.price);

  const msg = `Olá! Tenho interesse no disco *${it.artist} — ${it.title}* (Vinil ${it.vinil} / Capa ${it.capa}) por ${money(it.price)}. Está disponível?`;
  $('#mWhats').href = `${DATA.contacts.whatsapp}?text=${encodeURIComponent(msg)}`;
  $('#mML').href = DATA.contacts.mercadolivre;
  $('#mShopee').href = DATA.contacts.shopee;
  const dg = $('#mDiscogs'); if (it.discogs) { dg.href = it.discogs; dg.hidden = false; } else dg.hidden = true;

  $('#modal').hidden = false; document.body.style.overflow = 'hidden';
}
function closeModal() { $('#modal').hidden = true; document.body.style.overflow = ''; }
$$('[data-close]').forEach(x => x.onclick = closeModal);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
