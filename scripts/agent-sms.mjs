/**
 * Ndank — l'agent, à faire tourner chez le marchand.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * OÙ IL DOIT TOURNER, ET POURQUOI CELA DÉCIDE DE TOUT
 *
 * Sur une machine **du même réseau que le téléphone** : un Raspberry Pi, un
 * vieux portable, l'ordinateur du bureau. Pas sur le serveur du marchand, et
 * surtout pas dans le nuage.
 *
 * C'est tout l'intérêt. Vers le serveur il appelle, donc le NAT est traversé.
 * Vers le téléphone il est déjà sur le bon réseau, donc l'adresse privée est
 * joignable. Les deux moitiés du problème se résolvent parce que quelqu'un se
 * tient au milieu.
 *
 *     serveur du marchand  ←── long-poll ──  CET AGENT  ──→  téléphone
 *        (Vercel, VPS)                       (au bureau)      (192.168.x.x)
 *
 * ════════════════════════════════════════════════════════════════════════════
 * COMMENT LE LANCER
 *
 *     NDANK_FILE_BASE=https://mon-app.ci/sms \
 *     NDANK_FILE_JETON=...                   \
 *     SMS_BASE=http://192.168.1.42:8080      \
 *     SMS_UTILISATEUR=sms                    \
 *     SMS_MOT_DE_PASSE=...                   \
 *     node node_modules/ndank/scripts/agent-sms.mjs
 *
 * Il ne s'arrête pas tout seul : mettez-le sous `systemd`, `pm2` ou dans un
 * conteneur qui redémarre. Un agent arrêté ne produit aucune erreur — il
 * produit du silence, et c'est `bilan()` qui le verra grossir la file.
 */
import { agentSms } from "../dist/file/agent.js";
import { limiter } from "../dist/envoi/limite.js";
import { passerelleAndroid } from "../dist/envoi/transporteurs/passerelle-android.js";

const lire = (nom) => {
  const v = process.env[nom];
  if (!v) {
    console.error(`Il manque ${nom}.`);
    console.error("Attendus : NDANK_FILE_BASE, NDANK_FILE_JETON, SMS_BASE,");
    console.error("           SMS_UTILISATEUR, SMS_MOT_DE_PASSE.");
    process.exit(1);
  }
  return v;
};

const base = lire("NDANK_FILE_BASE");

/**
 * La limite enveloppe la passerelle, et non l'inverse.
 *
 * Elle doit s'appliquer à ce qui touche la SIM, pas à ce qui interroge la file.
 * Espacer les appels au serveur ne protégerait rien et rendrait l'agent lent
 * pour rien.
 */
const transporteur = limiter(
  passerelleAndroid({
    base: lire("SMS_BASE"),
    utilisateur: lire("SMS_UTILISATEUR"),
    motDePasse: lire("SMS_MOT_DE_PASSE"),
    ...(process.env["SMS_SIM"] ? { sim: Number(process.env["SMS_SIM"]) } : {}),
  }),
  {
    parMinute: Number(process.env["SMS_PAR_MINUTE"] ?? 10),
    ...(process.env["SMS_PAR_JOUR"]
      ? { parJour: Number(process.env["SMS_PAR_JOUR"]) }
      : {}),
    surRefus: ({ envoyesAujourdhui, plafond }) => {
      console.warn(
        `[plafond] ${envoyesAujourdhui}/${plafond} atteint — le reste attendra demain.`,
      );
    },
  },
);

const agent = agentSms({
  base,
  jeton: lire("NDANK_FILE_JETON"),
  transporteur,
  journal: (f) => {
    const t = new Date().toISOString().slice(11, 19);

    switch (f.quoi) {
      case "LOT":
        console.log(
          `[${t}] ${f.partis}/${f.recus} parti(s)` +
            (f.expires > 0 ? `, ${f.expires} périmé(s)` : ""),
        );
        break;
      case "ERREUR":
        console.warn(`[${t}] ${f.ou} : ${f.cause}`);
        break;
      case "REFUSE":
        console.error(
          `[${t}] la file refuse le jeton (${f.statut}). L'agent s'arrête : ` +
            "réessayer n'y changerait rien.",
        );
        break;
      // « VIDE » est le cas normal, plusieurs fois par minute. Le dire
      // remplirait le journal de la seule chose qui ne mérite pas d'être lue.
      case "VIDE":
        break;
    }
  },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log("\nArrêt demandé. Le lot en cours est terminé avant de rendre la main.");
    agent.arreter();
  });
}

console.log(`Agent Ndank — file : ${base}`);
console.log("Il demande, il émet, il acquitte, il redemande.\n");

await agent.demarrer();

console.log("Agent arrêté.");
