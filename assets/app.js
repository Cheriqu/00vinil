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

// ======================================================================
// Guia de gradação (vinil e capa) — botão no topo da página
// ======================================================================
const GUIDE = {
  disco: {
    pill: 'Vinil',
    labels: ['Brilho', 'Riscos', 'Som'],
    grades: [
      { id: 'm', code: 'M', en: 'Mint', pt: 'Perfeito',
        sum: 'Nunca foi tocado — normalmente ainda lacrado.',
        rows: ['Espelhado, com reflexos limpos e uniformes.',
               'Nenhum, nem fio de cabelo.',
               'Silêncio total entre as faixas; só a música.'],
        note: 'Nos nossos anúncios, disco M/M aparece com a etiqueta “Lacrado”.',
        wave: { noise: 0, ticks: 0, label: 'silêncio total' } },
      { id: 'nm', code: 'NM', en: 'Near Mint', pt: 'Quase perfeito',
        sum: 'Quase novo. Se já foi tocado, foi com muito cuidado.',
        rows: ['Muito alto — parece disco novo.',
               'Nenhum à vista; no máximo uma marca de manuseio, só sob luz forte.',
               'Toca perfeito: sem estalos, chiado ou falhas.'],
        wave: { noise: 0, ticks: 0, label: 'limpo' } },
      { id: 'vgp', code: 'VG+', en: 'Very Good Plus', pt: 'Muito bom +',
        sum: 'Usado por um dono cuidadoso: o desgaste é mais estético do que sonoro.',
        rows: ['Bom, com leve perda do espelhado.',
               'Marcas superficiais e riscos finíssimos, visíveis contra a luz — não dá para sentir com a unha.',
               'Toca bem do começo ao fim; no máximo um estalinho ou chiado bem baixo.'],
        note: 'Um empenamento leve, que não afeta o som, ainda é aceito nesta nota.',
        wave: { noise: 0.02, ticks: 1, label: 'quase limpo' } },
      { id: 'vg', code: 'VG', en: 'Very Good', pt: 'Muito bom',
        sum: 'Uso evidente: toca inteiro, mas dá para ouvir o desgaste.',
        rows: ['Opaco em algumas áreas, com um halo de micro-riscos.',
               'Vários riscos finos; alguns dá para sentir com a unha e podem aparecer no som.',
               'Chiado perceptível, principalmente nas partes calmas e na entrada e saída das músicas — sem cobrir a música.'],
        wave: { noise: 0.05, ticks: 3, label: 'chiado nas partes calmas' } },
      { id: 'gp', code: 'G+', en: 'Good Plus', pt: 'Bom +',
        sum: 'Desgaste claro: toca sem pular, mas com bastante ruído.',
        rows: ['Fosco; reflete pouco.',
               'Muitos riscos, alguns profundos; sulcos com desgaste visível.',
               'Chiado forte e estalos (“ticks”) ao longo do lado inteiro.'],
        wave: { noise: 0.08, ticks: 6, label: 'chiado + estalos' } },
      { id: 'g', code: 'G', en: 'Good', pt: 'Bom',
        sum: 'Muito usado: ainda toca inteiro, mas o ruído é constante.',
        rows: ['Quase nenhum; superfície acinzentada.',
               'Riscos fundos espalhados pela superfície.',
               'Estalos e chiado altos; a música ainda aparece, sem pular.'],
        note: 'Serve para ouvir a música, não para quem coleciona o estado.',
        wave: { noise: 0.11, ticks: 9, label: 'ruído constante' } },
      { id: 'f', code: 'F', en: 'Fair', pt: 'Regular',
        sum: 'Muito castigado: pode pular ou repetir trechos.',
        rows: ['Sem brilho; superfície esbranquiçada e gasta.',
               'Talhos fundos que cortam os sulcos; pode estar empenado ou lascado.',
               'Pula ou repete trechos; ruído muito alto.'],
        note: 'Abaixo dele fica o P (Poor): rachado ou tão empenado que não toca até o fim.',
        wave: { noise: 0.12, ticks: 9, skip: true, label: 'pula e repete' } },
    ],
  },
  capa: {
    pill: 'Capa',
    labels: ['Anel do disco', 'Cantos e bordas', 'Emendas', 'Marcas'],
    grades: [
      { id: 'm', code: 'M', en: 'Mint', pt: 'Perfeita',
        sum: 'Impecável, como saiu da fábrica.',
        rows: ['Nenhum.',
               'Retos e firmes, sem qualquer marca.',
               'Todas fechadas.',
               'Nenhuma — sem vincos, escrita ou adesivo. Cores vivas e brilho de capa nova.'] },
      { id: 'nm', code: 'NM', en: 'Near Mint', pt: 'Quase perfeita',
        sum: 'Sem sinal de desgaste — no máximo o vestígio mais leve de manuseio.',
        rows: ['Nenhum.',
               'Intactos.',
               'Fechadas.',
               'Sem vincos, dobras ou furos de promoção.'] },
      { id: 'vgp', code: 'VG+', en: 'Very Good Plus', pt: 'Muito boa +',
        sum: 'Leve desgaste de prateleira, sem defeitos que chamem atenção.',
        rows: ['Bem leve, quase imperceptível.',
               'Pontas levemente batidas ou viradas; borda com um esbranquiçado discreto.',
               'Firmes; pode ter uma abertura mínima.',
               'Marcas leves de manuseio. Um furo ou corte de promoção pequeno ainda é aceito.'] },
      { id: 'vg', code: 'VG', en: 'Very Good', pt: 'Muito boa',
        sum: 'Desgaste evidente, mas a capa está inteira e firme.',
        rows: ['Visível, principalmente contra a luz.',
               'Bordas esbranquiçadas e cantos batidos.',
               'Pequena abertura, geralmente na base.',
               'Pode ter um vinco leve, adesivo ou escrita pequena — em geral não tudo junto.'] },
      { id: 'gp', code: 'G+', en: 'Good Plus', pt: 'Boa +',
        sum: 'Bastante desgaste: emendas abertas e marcas por toda parte.',
        rows: ['Forte e bem marcado.',
               'Cantos dobrados; bordas muito gastas.',
               'Abertas, principalmente na base ou na lombada.',
               'Vincos, escritas, fita adesiva e manchas.'] },
      { id: 'g', code: 'G', en: 'Good', pt: 'Boa',
        sum: 'Capa castigada, mas ainda protege o disco.',
        rows: ['Muito forte, com a cor desbotada.',
               'Cantos dobrados e desfiados.',
               'Abertas em mais de um lado.',
               'Rasgos, escritas grandes, manchas e fita.'] },
      { id: 'f', code: 'F', en: 'Fair', pt: 'Regular',
        sum: 'Muito danificada: segura o disco por pouco.',
        rows: ['Marcado e desbotado.',
               'Pedaços faltando e bordas rasgadas.',
               'Abertas nos três lados.',
               'Rasgos, manchas de umidade, escrita e fita por toda parte.'],
        note: 'Vale pelo disco, não pela capa.' },
    ],
  },
};

const GS = { kind: 'disco', opener: null };
const GHASH = '#gradacao';

// gerador pseudo-aleatório com semente (a "gravação" simulada é sempre a mesma)
function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// "osciloscópio" do som: a mesma música em todas as notas; o desgaste entra como chiado
// (fica mais evidente nas passagens calmas), estalos em vermelho e, no F, o PULO — o trecho
// volta e se repete.
function traceSVG(w, seed) {
  const W = 260, H = 46, mid = H / 2, n = 260, R = mulberry(seed * 9973 + 17);
  const env = t => 0.16 + 0.84 * Math.pow(Math.abs(Math.sin(t * 0.028 + 0.7)), 1.1);
  const wav = t => env(t) * (0.62 * Math.sin(t * 0.52) + 0.38 * Math.sin(t * 1.31 + 1.2));
  const sx = w.skip ? 166 : null, back = 38;
  let d = '';
  for (let i = 0; i <= n; i++) {
    const x = i * W / n, t = (sx !== null && x >= sx) ? x - back : x;
    const y = mid - wav(t) * H * 0.40 + (R() - 0.5) * 2 * w.noise * H * 0.5;
    d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
  }
  let g = '';
  for (let k = 0; k < w.ticks; k++) {
    const xn = 10 + (k + 0.15 + R() * 0.7) * (W - 20) / w.ticks, h = 6 + R() * 11;
    if (sx !== null && xn > sx - back - 8 && xn < sx + 46) continue;      // deixa o pulo livre p/ ler
    const x = xn.toFixed(1);
    g += `<line class="tr-tick" x1="${x}" x2="${x}" y1="${(mid - h).toFixed(1)}" y2="${(mid + h).toFixed(1)}"/>`;
  }
  if (sx !== null) {
    g += `<line class="tr-skip-l" x1="${sx}" x2="${sx}" y1="1" y2="${H - 1}"/>` +
         `<path class="tr-skip-a" d="M${sx} 6 Q${sx - back / 2} -7 ${sx - back} 6"/>` +
         `<path class="tr-skip-h" d="M${sx - back - 4} 3 L${sx - back + 4} 3 L${sx - back} 10Z"/>` +
         `<text class="tr-lab" x="${sx + 6}" y="9">pulo</text>`;
  }
  return `<svg class="trace" viewBox="0 0 ${W} ${H}" role="img" aria-label="Simulação do som: ${w.label}">` +
         `<line class="tr-base" x1="0" x2="${W}" y1="${mid}" y2="${mid}"/><path class="tr-wave" d="${d}"/>${g}</svg>`;
}

function gradeCard(kind, g, idx) {
  const K = GUIDE[kind];
  const card = el('article', 'g-item'); card.id = 'g-' + g.id;

  const fig = el('figure', 'g-fig');
  const img = el('img', 'g-img');
  img.src = `assets/guia/${kind}-${g.id}.webp`; img.width = 640; img.height = 640;
  img.decoding = 'async'; img.loading = idx < 2 ? 'eager' : 'lazy';
  img.alt = `Ilustração simulada de ${kind === 'disco' ? 'um disco' : 'uma capa'} na nota ${g.code}`;
  fig.appendChild(img);
  if (g.wave) {
    const tr = el('div', 'g-trace');
    tr.innerHTML = `<div class="g-trace-cap"><span>como toca</span><b>${g.wave.label}</b></div>` + traceSVG(g.wave, idx + 1);
    fig.appendChild(tr);
  }
  card.appendChild(fig);

  const info = el('div', 'g-info');
  const top = el('div', 'g-top');
  top.appendChild(el('div', 'g-code', g.code));
  const names = el('div', 'g-names'); names.append(el('div', 'g-en', g.en), el('div', 'g-pt', g.pt));
  top.append(names, el('span', 'pill', `${K.pill} ${g.code}`));
  info.append(top, el('p', 'g-sum', g.sum));
  const dl = el('dl', 'g-rows');
  K.labels.forEach((lab, i) => {
    const r = el('div', 'g-row'); r.append(el('dt', null, lab), el('dd', null, g.rows[i])); dl.appendChild(r);
  });
  info.appendChild(dl);
  if (g.note) info.appendChild(el('div', 'g-note', g.note));
  card.appendChild(info);
  return card;
}

function buildScale() {
  const box = $('#gScale'); if (box.childElementCount) return;
  GUIDE.disco.grades.forEach(g => {
    const b = el('button', 'g-step', g.code); b.type = 'button';
    b.setAttribute('aria-label', 'Ir para a nota ' + g.code);
    b.onclick = () => gotoGrade(g.id);
    box.appendChild(b);
  });
}

function gotoGrade(id) {
  const t = $('#g-' + id); if (!t) return;
  t.scrollIntoView({ behavior: 'smooth', block: 'start' });
  t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash');
}

// nota que está no topo da área visível (p/ manter a mesma nota ao trocar Vinil <-> Capa)
function gradeInView() {
  const bar = $('#guide .g-bar').getBoundingClientRect().bottom;
  for (const it of $$('#gBody .g-item')) if (it.getBoundingClientRect().bottom > bar + 60) return it.id;
  return null;
}

function setGuideTab(kind) {
  const scroller = $('#guide .guide-card');
  const keep = scroller.scrollTop > 140 ? gradeInView() : null;
  GS.kind = kind;
  $$('#guide .g-tab').forEach(t => {
    const on = t.dataset.tab === kind;
    t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1;
  });
  const body = $('#gBody'); body.innerHTML = '';
  body.setAttribute('aria-labelledby', kind === 'disco' ? 'gTabDisco' : 'gTabCapa');
  GUIDE[kind].grades.forEach((g, i) => body.appendChild(gradeCard(kind, g, i)));
  if (keep) { const t = $('#' + keep); if (t) t.scrollIntoView({ behavior: 'instant', block: 'start' }); }
}

function openGuide(kind) {
  if (!$('#guide').hidden) return;
  const ae = document.activeElement;
  GS.opener = (ae && ae !== document.body) ? ae : $('#gradeBtn');   // Safari não foca botão ao clicar
  buildScale();
  setGuideTab(kind || 'disco');
  if (typeof DATA !== 'undefined' && DATA && DATA.contacts) {
    const w = $('#guide [data-c="whatsapp"]');
    if (w) w.href = `${DATA.contacts.whatsapp}?text=${encodeURIComponent('Olá! Tenho uma dúvida sobre a condição de um disco.')}`;
  }
  $('#guide').hidden = false; document.body.style.overflow = 'hidden';
  $('#guide .guide-card').scrollTop = 0;
  $('#gClose').focus({ preventScroll: true });
  if (location.hash !== GHASH) history.replaceState(null, '', GHASH);   // link compartilhável
}

function closeGuide() {
  if ($('#guide').hidden) return;
  $('#guide').hidden = true; document.body.style.overflow = '';
  if (location.hash === GHASH) history.replaceState(null, '', location.pathname + location.search);
  if (GS.opener && GS.opener.focus) GS.opener.focus({ preventScroll: true });
}

$('#gradeBtn').onclick = () => openGuide('disco');
$$('[data-close-guide]').forEach(x => x.onclick = closeGuide);
$$('#guide .g-tab').forEach(t => {
  t.onclick = () => setGuideTab(t.dataset.tab);
  t.onkeydown = e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const k = t.dataset.tab === 'disco' ? 'capa' : 'disco';
    setGuideTab(k); $(k === 'disco' ? '#gTabDisco' : '#gTabCapa').focus();
  };
});
document.addEventListener('keydown', e => {
  if ($('#guide').hidden) return;
  if (e.key === 'Escape') { closeGuide(); return; }
  if (e.key === 'Tab') {                                   // mantém o foco dentro do guia
    const f = $$('#guide button, #guide a[href], #guide [tabindex="0"]').filter(x => x.offsetParent !== null && x.tabIndex >= 0);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});
window.addEventListener('hashchange', () => { if (location.hash === GHASH) openGuide('disco'); else closeGuide(); });
if (location.hash === GHASH) openGuide('disco');
