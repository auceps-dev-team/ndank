/**
 * Ndank — la chaîne SMS complète, sur de vraies sockets et une vraie horloge.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CE QUE LES 684 TESTS NE PEUVENT PAS DIRE
 *
 * Ils passent tous, et ils passent avec des horloges injectées et des appels de
 * fonction directs. Trois choses leur échappent par construction :
 *
 *   — **la latence réelle**. On affirme que le long-polling libère « en
 *     quelques centaines de millisecondes ». Un test qui avance une horloge à
 *     la main ne le mesure pas, il le suppose ;
 *   — **le passage par HTTP**. `routeurFile` rend un objet ; entre lui et un
 *     agent, il y a un serveur, un corps à lire, des en-têtes à poser. Aucun
 *     test ne traverse cette couche ;
 *   — **la concurrence**. Deux agents qui tirent la même file au même instant,
 *     c'est le bail qui décide — et un `Map` interrogé séquentiellement ne
 *     reproduit pas cela.
 *
 * Ce script fait tourner la chaîne entière — rédaction, limite, dépôt, serveur,
 * agent, accusé, santé — sans SIM et sans téléphone. Seule la radio manque.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * L'AGENT EST SIMULÉ, ET C'EST LA SEULE CHOSE QU'IL FAUT SAVOIR
 *
 * `emettre()` ne fait rien : il rend « parti » après un délai. Tout le reste —
 * la boucle, le long-poll, le lot, l'accusé — est exactement ce qu'un agent
 * Android devra faire. Ce script vaut donc aussi de spécification pour qui
 * l'écrira.
 *
 *   node scripts/bac-a-sable-sms.mjs
 */
import { createServer } from "node:http";

import { agentSms } from "../dist/file/agent.js";
import { envoiCompose } from "../dist/envoi/compose.js";
import { limiter } from "../dist/envoi/limite.js";
import { fileEnMemoire } from "../dist/file/memoire.js";
import { routeurFile } from "../dist/file/routeur.js";
import { versLaFile } from "../dist/file/transporteur.js";
import { bilan } from "../dist/sante.js";

const JETON = "jeton-de-bac-a-sable";

let echecs = 0;
let passes = 0;

function verifier(quoi, condition, detail = "") {
  if (condition) {
    passes += 1;
    console.log(`  ✓ ${quoi}`);
    return;
  }

  echecs += 1;
  console.log(`  ✗ ${quoi}${detail ? ` — ${detail}` : ""}`);
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────── le serveur ──

/**
 * Monte le routeur sur un vrai serveur HTTP.
 *
 * C'est le code qu'un hôte écrit lui-même, et il tient en vingt lignes. Le
 * reproduire ici sert autant à l'éprouver qu'à montrer ce qu'il faut faire.
 */
function monter(routeur) {
  const serveur = createServer(async (req, rep) => {
    const url = new URL(req.url, "http://x");
    const corps = await new Promise((r) => {
      let t = "";
      req.on("data", (c) => (t += c));
      req.on("end", () => r(t));
    });

    const reponse = await routeur({
      methode: req.method,
      chemin: url.pathname,
      parametres: Object.fromEntries(url.searchParams),
      corps,
      entetes: req.headers,
    });

    rep.writeHead(reponse.statut, reponse.entetes);
    rep.end(reponse.corps);
  });

  return new Promise((r) => {
    serveur.listen(0, "127.0.0.1", () => r({ serveur, port: serveur.address().port }));
  });
}

// ───────────────────────────────────────────────────────────── l'agent ──

/**
 * L'agent **livré**, et non une copie écrite pour l'occasion.
 *
 * C'était le défaut de la première version de ce script : il réimplémentait la
 * boucle « demander, émettre, acquitter » à la main. On éprouvait donc une
 * ressemblance, pas le code que les hôtes feront tourner.
 *
 * `agentSms` reçoit un `TransporteurSms` et lui confie l'émission. Ici, ce
 * transporteur ne fait rien — c'est la seule pièce simulée de tout ce script.
 */
function agent(port, { emettre, jeton = JETON } = {}) {
  const journal = { lots: 0, emis: 0, rates: 0, expires: 0 };

  const transporteur = {
    nom: "simule",
    canal: "sms",
    async envoyer(ou, contenu) {
      const parti = emettre ? await emettre({ telephone: ou.telephone, texte: contenu.texte }) : true;
      return { parti, reference: parti ? `SIM-${Date.now()}` : null };
    },
  };

  const a = agentSms({
    base: `http://127.0.0.1:${port}`,
    jeton,
    transporteur,
    pauseErreur: 200,
    journal: (f) => {
      if (f.quoi === "LOT") {
        journal.lots += 1;
        journal.emis += f.partis;
        journal.expires += f.expires;
        journal.rates += f.recus - f.partis - f.expires;
      }
      if (f.quoi === "REFUSE") journal.refus = f.statut;
    },
  });

  const boucle = a.demarrer();

  return {
    journal,
    async arreter() {
      a.arreter();
      await Promise.race([boucle, dormir(1500)]);
    },
  };
}

/** Un abonné, tel que le moteur le passerait à l'envoi. */
const abonne = (telephone) => ({
  nom: "Awa",
  courriel: null,
  telephone,
  appareils: [],
});

const message = (jours) => ({
  cle: `2026-09-12:${jours}`,
  destinataire: "Awa",
  offre: "Pass Créateur",
  montant: "2 000 XOF",
  lien: "https://p.baobart.ci/v/eyJhIjoi.abc123.def456",
  joursRestants: jours,
  dernier: jours < 0,
});

// ══════════════════════════════════════════════════════════════════════════

console.log("Ndank — la chaîne SMS, de bout en bout, sans SIM");
console.log("Seule la radio manque : l'agent est simulé, tout le reste est réel.\n");

// ── 1. le tour complet ────────────────────────────────────────────────────
{
  console.log("▸ Le tour complet : rédaction → file → HTTP → agent → accusé");

  const file = fileEnMemoire();
  const { serveur, port } = await monter(routeurFile({ file, jeton: JETON }));

  // L'envoi tel que le moteur le construit : la file en transporteur SMS.
  const envoi = envoiCompose({ sms: versLaFile({ file }) });

  const numeros = ["+2250718350482", "+2250769630987"];
  for (const n of numeros) await envoi.envoyer("sms", abonne(n), message(7));

  verifier("les deux relances sont en file", file.contenu().length === 2);

  const a = agent(port);
  await dormir(400);
  await a.arreter();

  verifier("l'agent a tout émis", a.journal.emis === 2, `emis=${a.journal.emis}`);
  verifier("la file est vidée par les accusés", file.contenu().length === 0);

  serveur.close();
}

// ── 2. la latence, mesurée et non supposée ────────────────────────────────
{
  console.log("\n▸ La latence du long-polling — l'affirmation à vérifier");

  const file = fileEnMemoire();
  const { serveur, port } = await monter(routeurFile({ file, jeton: JETON }));
  const envoi = envoiCompose({ sms: versLaFile({ file }) });

  let recuA = 0;
  const a = agent(port, {
    async emettre() {
      recuA = Date.now();
      return true;
    },
  });

  // On laisse l'agent s'installer dans son attente, puis on dépose.
  await dormir(600);
  const deposeA = Date.now();
  await envoi.envoyer("sms", abonne("+2250718350482"), message(1));

  await dormir(700);
  await a.arreter();
  serveur.close();

  const latence = recuA - deposeA;
  console.log(`  · dépôt → réception par l'agent : ${latence} ms`);

  verifier(
    "sous la seconde, donc compatible avec un code de connexion",
    latence > 0 && latence < 1000,
    `${latence} ms`,
  );
}

// ── 3. la limite, sur une vraie horloge ───────────────────────────────────
{
  console.log("\n▸ La limite de débit, chronométrée");

  const file = fileEnMemoire();
  // 120/min = 500 ms d'espacement. Assez lent pour se mesurer, assez rapide
  // pour ne pas faire durer ce script.
  const sms = limiter(versLaFile({ file }), { parMinute: 120, hasard: 0.2 });

  const depart = Date.now();
  for (let i = 0; i < 5; i++) await sms.envoyer(abonne("+2250718350482"), {
    texte: "x", segments: 1, perdus: [], tronque: false,
  });
  const duree = Date.now() - depart;

  console.log(`  · 5 envois espacés de ~500 ms : ${duree} ms`);
  verifier("l'espacement s'applique vraiment", duree >= 1600, `${duree} ms`);
  verifier("les cinq sont en file", file.contenu().length === 5);
}

// ── 4. l'agent qui meurt ──────────────────────────────────────────────────
{
  console.log("\n▸ L'agent qui prend puis meurt — le bail");

  const file = fileEnMemoire({ bailSecondes: 1 });
  const { serveur, port } = await monter(routeurFile({ file, jeton: JETON }));
  const envoi = envoiCompose({ sms: versLaFile({ file }) });

  await envoi.envoyer("sms", abonne("+2250718350482"), message(7));

  // Il prend, et n'acquitte jamais.
  const r = await fetch(`http://127.0.0.1:${port}/attente`, {
    headers: { authorization: `Bearer ${JETON}` },
  });
  verifier("il a bien pris le message", (await r.json()).length === 1);

  const pendant = await file.prendre(10, new Date());
  verifier("aucun autre agent ne peut le prendre pendant le bail", pendant.length === 0);

  await dormir(1100);
  const apres = await file.prendre(10, new Date());
  verifier("le message revient quand le bail expire", apres.length === 1);

  serveur.close();
}

// ── 5. ce que la route refuse ─────────────────────────────────────────────
{
  console.log("\n▸ Ce que la route refuse, à travers HTTP");

  const file = fileEnMemoire();
  const { serveur, port } = await monter(
    routeurFile({ file, jeton: JETON, attenteMax: 0 }),
  );
  const base = `http://127.0.0.1:${port}`;

  const sansJeton = await fetch(`${base}/attente`);
  verifier("401 sans jeton", sansJeton.status === 401, `${sansJeton.status}`);

  const mauvais = await fetch(`${base}/attente`, {
    headers: { authorization: "Bearer faux-jeton-de-la-bonne-longueur" },
  });
  verifier("401 sur un jeton faux", mauvais.status === 401, `${mauvais.status}`);

  const vide = await fetch(`${base}/attente`, {
    headers: { authorization: `Bearer ${JETON}` },
  });
  verifier("204 quand il n'y a rien", vide.status === 204, `${vide.status}`);
  verifier(
    "rien n'est mis en cache",
    vide.headers.get("cache-control") === "no-store",
  );

  const inconnue = await fetch(`${base}/nimporte`, {
    headers: { authorization: `Bearer ${JETON}` },
  });
  verifier("404 dit où aller", (await inconnue.text()).includes("/attente"));

  serveur.close();
}

// ── 6. la santé voit la panne ─────────────────────────────────────────────
{
  console.log("\n▸ La panne de l'appareil, vue sans qu'un envoi ait échoué");

  const file = fileEnMemoire();
  const envoi = envoiCompose({ sms: versLaFile({ file }) });
  for (let i = 0; i < 31; i++) {
    await envoi.envoyer("sms", abonne("+2250718350482"), message(7));
  }

  // Personne ne vient chercher. On regarde une heure et demie plus tard.
  const plusTard = new Date(Date.now() + 5400_000);
  const constats = await bilan(
    {
      battements: {
        async commencer() { return "p"; },
        async terminer() {},
        async echouer() {},
        async dernier() {
          return {
            id: "p", commenceLe: new Date(), termineLe: new Date(),
            vus: 31, relances: 31, suspendus: 0, clos: 0,
            injoignables: 0, echecs: 0, lotPlein: false, erreur: null,
          };
        },
      },
      fileSms: (quand) => file.statistiques(quand),
    },
    {},
    plusTard,
  );

  const f = constats.find((c) => c.quoi === "FILE_SMS");
  console.log(`  · [${f?.gravite}] ${f?.titre}`);

  verifier("la file alerte", f?.gravite === "ALERTE");
  verifier(
    "sans qu'un seul envoi ait échoué",
    !constats.some((c) => c.quoi === "CANAL_MORT" || c.quoi === "ENVOIS"),
  );
}

// ── 7. deux agents sur la même file ───────────────────────────────────────
{
  console.log("\n▸ Deux agents en concurrence — aucun doublon");

  const file = fileEnMemoire();
  const { serveur, port } = await monter(
    routeurFile({ file, jeton: JETON, parLot: 3 }),
  );
  const envoi = envoiCompose({ sms: versLaFile({ file }) });

  const combien = 24;
  for (let i = 0; i < combien; i++) {
    const n = `+22507000000${String(i).padStart(2, "0")}`;
    await envoi.envoyer("sms", abonne(n), message(7));
  }

  // Deux agents tirent en même temps. C'est le bail qui doit trancher : un
  // message pris par l'un ne doit jamais être rendu à l'autre, sinon un abonné
  // recevrait deux fois le même rappel. Aucun test unitaire ne reproduit cela,
  // parce qu'un `Map` interrogé séquentiellement n'a pas de concurrence.
  // On note le NUMÉRO et non l'identifiant de file : le transporteur ne voit
  // pas l'id, et c'est de toute façon la bonne propriété à prouver — aucun
  // abonné ne doit recevoir deux fois le même rappel.
  const vus = [];
  const emettre = async (m) => {
    vus.push(m.telephone);
    await dormir(5);
    return true;
  };

  const un = agent(port, { emettre });
  const deux = agent(port, { emettre });

  await dormir(900);
  await Promise.all([un.arreter(), deux.arreter()]);
  serveur.close();

  const uniques = new Set(vus);
  console.log(
    `  · ${vus.length} émissions vers ${uniques.size} numéros distincts, ` +
      `${un.journal.lots} + ${deux.journal.lots} lots`,
  );

  verifier(
    "les 24 abonnés ont tous été joints",
    uniques.size === combien,
    `${uniques.size}/${combien}`,
  );
  verifier(
    "aucun n'a reçu deux fois le même rappel",
    vus.length === uniques.size,
    `${vus.length - uniques.size} doublon(s)`,
  );
  verifier(
    "les deux agents ont travaillé",
    un.journal.lots > 0 && deux.journal.lots > 0,
  );
  verifier("la file est vide à la fin", file.contenu().length === 0);
}


// ══════════════════════════════════════════════════════════════════════════

console.log(`\n${passes} vérifiées, ${echecs} en échec.`);

if (echecs > 0) {
  console.error("\nLa chaîne SMS ne tient pas ses promesses.");
  process.exit(1);
}

console.log("\nLa chaîne tient, de la rédaction à l'accusé.");
console.log("Ce qui reste non éprouvé : la radio elle-même — une SIM, un opérateur.");
