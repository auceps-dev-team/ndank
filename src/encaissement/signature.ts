import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Vérifier qu'un webhook vient bien de qui il prétend.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * C'EST LE SEUL ENDROIT OÙ NDANK ACCEPTE QUELQUE CHOSE DE L'EXTÉRIEUR
 *
 * Tout le reste du module part de chez nous : on appelle un fournisseur, on lit
 * sa réponse. Un webhook fait le contraire — n'importe qui sur Internet peut
 * poster sur cette adresse. Et ce que le corps de la requête raconte, c'est
 * qu'un abonnement vient d'être payé.
 *
 * Sans vérification, ouvrir un accès payant se réduit à connaître l'URL.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * SUR LE CORPS BRUT, JAMAIS SUR L'OBJET RELU
 *
 * La signature porte sur les octets envoyés. `JSON.parse` puis
 * `JSON.stringify` rend un texte différent — l'ordre des clés, les espaces, la
 * notation des nombres — et la signature ne correspond plus. Le piège est
 * classique et il se manifeste par un « ça marche chez moi » : la plupart des
 * cadres applicatifs relisent le corps avant que le code de l'hôte ne le voie.
 *
 * D'où la signature de ces fonctions : elles prennent une chaîne, et l'hôte
 * doit veiller à ce que ce soit celle reçue.
 */

/** Comparaison à temps constant. Deux longueurs différentes valent faux. */
function memeSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");

  // `timingSafeEqual` lève si les longueurs diffèrent : on répond avant, mais
  // la longueur d'une signature ne dépend pas du secret, donc rien ne fuit.
  if (x.length !== y.length) return false;

  return timingSafeEqual(x, y);
}

/**
 * Paystack : HMAC-SHA512 du corps brut, signé avec la clé secrète.
 *
 * En-tête `x-paystack-signature`, en hexadécimal minuscule.
 *
 * Paystack publie aussi trois adresses IP d'origine — 52.31.139.75,
 * 52.49.173.169 et 52.214.14.220, les mêmes en test et en production. Les
 * filtrer est une bonne idée, mais cela relève de l'infrastructure de l'hôte,
 * pas de ce module : derrière un répartiteur de charge, l'IP vue ici n'est
 * déjà plus celle de l'appelant.
 */
export function verifierPaystack(
  corps: string,
  signature: string | undefined,
  cleSecrete: string,
): boolean {
  if (!signature) return false;

  const attendue = createHmac("sha512", cleSecrete).update(corps, "utf8").digest("hex");

  return memeSecret(attendue, signature.trim().toLowerCase());
}

/**
 * Flutterwave : HMAC-SHA256 du corps brut, signé avec le « secret hash ».
 *
 * En-tête `flutterwave-signature`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * L'ANCIEN EN-TÊTE EST ACCEPTÉ AUSSI, ET CE N'EST PAS DE LA COMPLAISANCE
 *
 * Pendant des années, Flutterwave a posé le secret en clair dans `verif-hash`
 * et demandait une simple égalité. Beaucoup de comptes marchands existants
 * émettent encore cette forme-là, et un hôte qui migre ne contrôle pas la date
 * de bascule côté fournisseur.
 *
 * Refuser l'ancienne forme reviendrait à ignorer des paiements réels le jour
 * de la migration. On accepte donc les deux — mais l'égalité simple n'est
 * tentée que si l'en-tête moderne est absent, jamais en repli d'une signature
 * moderne invalide.
 */
export function verifierFlutterwave(
  corps: string,
  entetes: Readonly<Record<string, string | undefined>>,
  secret: string,
): boolean {
  const moderne = entetes["flutterwave-signature"];

  if (moderne) {
    const attendue = createHmac("sha256", secret).update(corps, "utf8").digest("hex");
    return memeSecret(attendue, moderne.trim().toLowerCase());
  }

  const ancien = entetes["verif-hash"];
  if (ancien) return memeSecret(secret, ancien.trim());

  return false;
}

/**
 * MTN MoMo : rien à vérifier, et c'est le problème.
 *
 * Les rappels MTN n'arrivent pas signés. L'hôte déclare une adresse de rappel
 * à la création de l'utilisateur d'API, et MTN y poste le résultat — sans
 * en-tête d'authenticité.
 *
 * On ne peut donc pas faire confiance au corps du rappel. La seule conduite
 * sûre est de le traiter comme un signal — « va regarder » — et d'aller relire
 * l'état par `constater`, qui, lui, passe par un appel authentifié. C'est ce
 * que fait l'adaptateur MTN, et c'est pour cela que cette fonction rend
 * toujours faux plutôt que d'exister pour la forme.
 */
export function verifierMtn(): boolean {
  return false;
}
