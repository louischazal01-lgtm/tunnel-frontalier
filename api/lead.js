// Vercel Serverless Function — capture des leads du funnel dans Brevo
// Reçoit le POST envoyé par le funnel (navigator.sendBeacon / fetch) à chaque étape,
// et fait un upsert du contact dans Brevo (liste "Funnel Frontalier").

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  // Le corps peut arriver en objet (parsé par Vercel) ou en texte brut (sendBeacon Blob)
  let d = req.body;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = {}; } }
  if (!d || typeof d !== 'object') d = {};

  const email = String(d.email || '').trim().toLowerCase();
  if (!email) { res.status(200).json({ ok: true, skipped: 'no_email' }); return; }

  const KEY = process.env.BREVO_API_KEY;
  const LIST = parseInt(process.env.BREVO_LIST_ID || '0', 10);
  const NEWS_LIST = parseInt(process.env.BREVO_NEWSLETTER_LIST_ID || '0', 10);
  if (!KEY) { res.status(500).json({ error: 'brevo_key_missing' }); return; }

  // Prénom / Nom depuis le champ unique "Prénom et Nom"
  const parts = String(d.nom || '').trim().split(/\s+/).filter(Boolean);
  const prenom = parts.shift() || '';
  const nom = parts.join(' ');

  // Codes du funnel -> libellés lisibles dans Brevo
  const LABELS = {
    motivation: { postule_sans_retour: "A postulé en Suisse, sans retour", je_commence: "Commence tout juste", comprendre_systeme: "Veut comprendre le système", curiosite: "Découvre par curiosité" },
    situation: { en_poste: "En poste en France", fin_contrat: "Fin de contrat / préavis", recherche_court: "En recherche < 6 mois", recherche_long: "En recherche > 6 mois" },
    distance: { moins_1h: "Moins d'1 heure", '1_2h': "Entre 1 et 2 heures", loin_pret: "Plus loin, prêt à déménager", loin_fixe: "Plus loin, ne déménage pas" },
    echeance: { moins_3m: "Moins de 3 mois", '3_6m': "3 à 6 mois", '6_12m': "6 à 12 mois", pas_date: "Ne sait pas encore" },
    rdv: { rdv_now: "Réserver maintenant", rdv_later: "Plus tard, découvrir d'abord" },
    source: { post_li: "Post LinkedIn", newsletter: "Newsletter", dm: "Message direct", facebook: "Groupe Facebook", bouche_oreille: "Bouche-à-oreille", recherche: "Recherche (Google/ChatGPT)", autre: "Autre" },
    segment: { chaud: "Chaud", date: "A une échéance", froid: "Froid" }
  };
  const lbl = (f, v) => (v && LABELS[f] && LABELS[f][v]) || v;

  const attributes = {
    PRENOM: prenom,
    NOM: nom,
    TELEPHONE: d.tel || '',
    MOTIVATION: lbl('motivation', d.motivation),
    SITUATION: lbl('situation', d.situation),
    DISTANCE: lbl('distance', d.distance),
    ECHEANCE: lbl('echeance', d.echeance),
    SEGMENT: lbl('segment', d.segment),
    SOURCE: lbl('source', d.source),
    RDV_CHOIX: lbl('rdv', d.rdv),
    ETAPE: d.stage || ''
  };
  // Compteurs de clic internes : on horodate le bouton cliqué (visible/comptable dans Brevo)
  const today = new Date().toISOString().slice(0, 10);
  if (d.click === 'rdv') attributes.CLIC_RDV = today;
  if (d.click === 'decouvre') attributes.CLIC_DECOUVRE = today;
  if (d.click === 'decouvre_cal') attributes.CLIC_DECOUVRE_CAL = today;

  // On n'envoie jamais de valeur vide -> évite d'écraser une donnée déjà remplie
  for (const k of Object.keys(attributes)) {
    if (attributes[k] === '' || attributes[k] == null) delete attributes[k];
  }

  const listIds = [];
  if (LIST) listIds.push(LIST);
  if (NEWS_LIST && d.news) listIds.push(NEWS_LIST);

  const payload = { email, attributes, updateEnabled: true };
  if (listIds.length) payload.listIds = listIds;

  try {
    const r = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'api-key': KEY,
        'Content-Type': 'application/json',
        'accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    // On ne renvoie jamais de détail interne (statut/erreur Brevo) au client
    res.status(200).json({ ok: r.ok || r.status === 204 });
  } catch (e) {
    res.status(200).json({ ok: false });
  }
}
