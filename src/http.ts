/**
 * Ndank — le seul moyen par lequel il parle au monde extérieur.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI CE FICHIER EST À LA RACINE, ET PLUS DANS L'ENCAISSEMENT
 *
 * Il y est né parce que les fournisseurs de paiement étaient les premiers à
 * avoir besoin du réseau. Mais un port HTTP n'a rien d'une notion comptable :
 * la couche d'envoi appelle une passerelle SMS exactement comme l'adaptateur
 * Paystack appelle Paystack.
 *
 * Le laisser dans `encaissement/port.ts` aurait obligé la couche des relances à
 * importer celle des paiements pour envoyer un courriel. Une dépendance dans ce
 * sens-là ne se justifie par rien, et elle aurait fini par en autoriser
 * d'autres.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * AUCUN APPEL N'EST FAIT ICI NON PLUS
 *
 * `Http` est un port, comme `Lecture` ou `Envoi`. Les adaptateurs le reçoivent,
 * ils ne l'inventent pas — c'est ce qui permet d'éprouver un flux complet, d'un
 * bout à l'autre, sans réseau, sans compte, et en une milliseconde.
 */

export interface Requete {
  methode: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  entetes: Record<string, string>;
  /** Déjà sérialisé. Les adaptateurs décident de leur propre encodage. */
  corps?: string;
}

export interface Reponse {
  statut: number;
  corps: string;
}

/**
 * Le port.
 *
 * L'hôte peut y brancher `fetch`, un client qui réessaie, un qui journalise, ou
 * un faux qui rejoue des réponses enregistrées — c'est ce dernier cas qui rend
 * les adaptateurs éprouvables sans compte marchand.
 */
export type Http = (requete: Requete) => Promise<Reponse>;

/** L'implémentation par défaut, sur le `fetch` de la plateforme. */
export const httpParDefaut: Http = async (requete) => {
  const reponse = await fetch(requete.url, {
    method: requete.methode,
    headers: requete.entetes,
    body: requete.corps,
  });

  return { statut: reponse.status, corps: await reponse.text() };
};
