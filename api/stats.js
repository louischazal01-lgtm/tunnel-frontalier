// Tableau de bord privé des métriques du funnel — rendu HTML côté serveur.
// Accès protégé par authentification HTTP Basic (identifiant + mot de passe).
// Compte en direct depuis Brevo (liste Funnel Frontalier).

import crypto from 'node:crypto';

// Comparaison à temps constant (anti timing-attack), sans fuite de longueur
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  const ha = crypto.createHash('sha256').update(ba).digest();
  const hb = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ha, hb) && ba.length === bb.length;
}

export default async function handler(req, res) {
  // En-têtes de sécurité : pas d'indexation, pas de cache, pas d'iframe, CSP stricte
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");

  const KEY = process.env.BREVO_API_KEY;
  const LIST = parseInt(process.env.BREVO_LIST_ID || '0', 10);
  const USER = process.env.STATS_USER || '';
  const PASS = process.env.STATS_PASS || '';

  // Authentification HTTP Basic
  let authed = false;
  const h = req.headers.authorization || '';
  if (USER && PASS && h.startsWith('Basic ')) {
    let decoded = '';
    try { decoded = Buffer.from(h.slice(6), 'base64').toString('utf8'); } catch (e) { decoded = ''; }
    const idx = decoded.indexOf(':');
    if (idx >= 0) {
      const u = decoded.slice(0, idx);
      const p = decoded.slice(idx + 1);
      // On évalue toujours les deux pour ne pas court-circuiter (timing)
      const okU = safeEqual(u, USER);
      const okP = safeEqual(p, PASS);
      authed = okU && okP;
    }
  }
  if (!authed) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Metriques Funnel Frontalier", charset="UTF-8"');
    res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send('<body style="font-family:sans-serif;background:#000;color:#fff;padding:40px">🔒 Accès restreint.</body>');
    return;
  }
  if (!KEY) { res.status(500).send('Configuration Brevo manquante.'); return; }

  // Récupération de tous les contacts de la liste (pagination)
  let contacts = [], offset = 0; const limit = 500;
  try {
    for (let n = 0; n < 60; n++) {
      const r = await fetch(`https://api.brevo.com/v3/contacts/lists/${LIST}/contacts?limit=${limit}&offset=${offset}`, {
        headers: { 'api-key': KEY, 'accept': 'application/json' }
      });
      if (!r.ok) break;
      const j = await r.json();
      const batch = j.contacts || [];
      contacts = contacts.concat(batch);
      if (batch.length < limit) break;
      offset += limit;
    }
  } catch (e) { /* on rend ce qu'on a */ }

  const total = contacts.length || 0;
  const at = c => c.attributes || {};
  const filled = k => contacts.filter(c => { const v = at(c)[k]; return v !== undefined && v !== null && v !== ''; }).length;
  const breakdown = k => {
    const m = {};
    contacts.forEach(c => { const v = at(c)[k]; if (v === undefined || v === null || v === '') return; m[v] = (m[v] || 0) + 1; });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };
  const pct = n => total ? Math.round((n / total) * 100) : 0;

  const clicRdv = filled('CLIC_RDV');
  const clicDec = filled('CLIC_DECOUVRE');
  const clicDecCal = filled('CLIC_DECOUVRE_CAL');

  const bar = (rows, color) => rows.map(([k, v]) =>
    `<div class="row"><span class="lbl">${esc(k)}</span><span class="track"><span class="fill" style="width:${pct(v)}%;background:${color}"></span></span><span class="num">${v} · ${pct(v)}%</span></div>`
  ).join('') || '<p class="empty">Aucune donnée pour l\'instant.</p>';

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const stageLbl = { motivation: 'Motivation', email: 'Email', situation: 'Situation', distance: 'Distance', echeance: 'Échéance', identite: 'Coordonnées', rdv: 'Choix RDV', source: 'Source', complete: 'Terminé' };

  // Tableau détaillé, lead par lead (plus récent en haut)
  const leads = contacts.slice().sort((a, b) => new Date(b.modifiedAt || 0) - new Date(a.modifiedAt || 0));
  const leadsRows = leads.map(c => {
    const a = at(c);
    const nom = [a.PRENOM, a.NOM].filter(Boolean).join(' ');
    return `<tr>
      <td class="e">${esc(c.email || '')}</td>
      <td>${esc(nom)}</td>
      <td>${esc(a.TELEPHONE || '')}</td>
      <td>${esc(a.SEGMENT || '')}</td>
      <td>${esc(a.SITUATION || '')}</td>
      <td>${esc(a.ECHEANCE || '')}</td>
      <td>${esc(a.SOURCE || '')}</td>
      <td class="c">${a.CLIC_RDV ? '✅' : '—'}</td>
      <td class="c">${a.CLIC_DECOUVRE ? '✅' : '—'}</td>
      <td class="c">${a.CLIC_DECOUVRE_CAL ? '✅' : '—'}</td>
      <td>${esc(stageLbl[a.ETAPE] || a.ETAPE || '')}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="11" style="color:#8e8e8e;padding:16px">Aucun lead pour l\'instant. Passe dans le funnel avec ton email pour tester.</td></tr>';
  const leadsTable = `<div class="card"><h2>Détail des leads (${total})</h2>
    <div class="tw"><table>
      <thead><tr><th>Email</th><th>Nom</th><th>Tél</th><th>Segment</th><th>Situation</th><th>Échéance</th><th>Source</th><th>Réservé</th><th>+Tard (RDV)</th><th>+Tard (Cal)</th><th>Étape atteinte</th></tr></thead>
      <tbody>${leadsRows}</tbody>
    </table></div>
  </div>`;

  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Métriques — Funnel Frontalier</title>
<style>
:root{--gold:#D0A03E;--bg:#0b0b0b;--card:#161616;--border:#2a2a2a;--muted:#8e8e8e}
*{box-sizing:border-box;margin:0}body{background:var(--bg);color:#fff;font-family:Inter,system-ui,-apple-system,sans-serif;padding:28px 16px;line-height:1.4}
.wrap{max-width:760px;margin:0 auto}
h1{font-size:22px;margin-bottom:4px}.sub{color:var(--muted);font-size:13px;margin-bottom:24px}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:28px}
.kpi{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px}
.kpi .big{font-size:30px;font-weight:700;color:var(--gold)}.kpi .cap{font-size:12px;color:var(--muted);margin-top:4px}
.kpi .pc{font-size:12px;color:#fff;opacity:.7}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:18px;margin-bottom:16px}
.card h2{font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:var(--gold);margin-bottom:14px}
.row{display:flex;align-items:center;gap:10px;margin:8px 0}
.lbl{flex:0 0 42%;font-size:13.5px}.track{flex:1;height:9px;background:#000;border-radius:6px;overflow:hidden}
.fill{display:block;height:100%;border-radius:6px}.num{flex:0 0 74px;text-align:right;font-size:12.5px;color:var(--muted)}
.empty{color:var(--muted);font-size:13px}
.foot{color:var(--muted);font-size:11.5px;margin-top:18px;text-align:center}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font-size:12.5px;white-space:nowrap}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border)}
th{color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
td.e{color:var(--gold)}td.c{text-align:center}
tbody tr:hover{background:#1e1e1e}
</style></head><body><div class="wrap">
<h1>📊 Funnel Frontalier — Métriques</h1>
<div class="sub">En direct depuis Brevo · ${total} lead${total > 1 ? 's' : ''} capté${total > 1 ? 's' : ''}</div>

<div class="kpis">
  <div class="kpi"><div class="big">${total}</div><div class="cap">Leads captés (emails)</div></div>
  <div class="kpi"><div class="big">${clicRdv}</div><div class="cap">Clics « Réserver »</div><div class="pc">${pct(clicRdv)}% des leads</div></div>
  <div class="kpi"><div class="big">${clicDec}</div><div class="cap">Clics « Plus tard, découvrir »</div><div class="pc">${pct(clicDec)}% des leads</div></div>
</div>

<div class="card"><h2>Boutons de fin de funnel</h2>
  <div class="row"><span class="lbl">🗓️ Réserver maintenant</span><span class="track"><span class="fill" style="width:${pct(clicRdv)}%;background:var(--gold)"></span></span><span class="num">${clicRdv} · ${pct(clicRdv)}%</span></div>
  <div class="row"><span class="lbl">👀 Plus tard (étape RDV)</span><span class="track"><span class="fill" style="width:${pct(clicDec)}%;background:#4FC3F7"></span></span><span class="num">${clicDec} · ${pct(clicDec)}%</span></div>
  <div class="row"><span class="lbl">⏳ Plus tard (sur le calendrier)</span><span class="track"><span class="fill" style="width:${pct(clicDecCal)}%;background:#FF7043"></span></span><span class="num">${clicDecCal} · ${pct(clicDecCal)}%</span></div>
</div>

${leadsTable}

<div class="card"><h2>Segment</h2>${bar(breakdown('SEGMENT'), 'var(--gold)')}</div>
<div class="card"><h2>Où en sont-ils (situation)</h2>${bar(breakdown('SITUATION'), '#7ED957')}</div>
<div class="card"><h2>Échéance de départ</h2>${bar(breakdown('ECHEANCE'), '#EC5F9A')}</div>
<div class="card"><h2>Distance de la frontière</h2>${bar(breakdown('DISTANCE'), '#B388FF')}</div>
<div class="card"><h2>Comment ils m'ont connu</h2>${bar(breakdown('SOURCE'), '#4FC3F7')}</div>
<div class="card"><h2>Dernière étape atteinte</h2>${bar(breakdown('ETAPE'), '#FF7043')}</div>

<div class="foot">Rafraîchis la page pour mettre à jour · données Brevo liste « Funnel Frontalier »</div>
</div></body></html>`;

  res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}
