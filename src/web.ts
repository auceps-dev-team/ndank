/**
 * Ndank — la forme d'une requête et d'une réponse, sans cadre applicatif.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI CES TYPES SONT À LA RACINE
 *
 * Ils sont nés dans `page/port.ts`, parce que la page de validation fut la
 * première à répondre à des requêtes. Puis le gestionnaire de webhooks les a
 * empruntés, puis l'API du tableau de bord — et l'on s'est retrouvé avec un
 * fichier de webhooks qui importe depuis « la page ».
 *
 * C'est une ligne qui ne veut rien dire pour quelqu'un qui ouvre le module des
 * webhooks en premier, et le genre de dépendance qui, laissée là, finit par en
 * justifier de vraies.
 *
 * Même correctif que pour `Http` et pour `echapper` : ce qui sert à plusieurs
 * couches et n'appartient à aucune vit à la racine, et l'ancien chemin
 * réexporte pour ne rien casser.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * NDANK NE LIVRE PAS DE SERVEUR
 *
 * `dependencies` est vide et doit le rester. Les trois routeurs — page,
 * webhooks, API — sont des fonctions de cette forme vers la suivante, et l'hôte
 * les monte où il veut : une route Next, un gestionnaire Hono, un
 * `http.createServer`, une fonction déployée au bord.
 *
 * `page/montage.ts` fournit les deux adaptateurs qui couvrent presque tout, et
 * ils servent aux trois routeurs — un routeur n'est jamais qu'une fonction.
 */

/** Une requête, réduite à ce dont un routeur a besoin. */
export interface RequeteWeb {
  methode: string;
  /** Le chemin **relatif au point de montage**, sans la base. */
  chemin: string;
  /** Les paramètres de requête, déjà décodés. */
  parametres: Readonly<Record<string, string>>;
  /**
   * Le corps, **brut**.
   *
   * Brut n'est pas une préférence : la signature d'un webhook porte sur les
   * octets envoyés, et `JSON.parse` puis `JSON.stringify` rend un texte
   * différent. Un montage qui relit le corps avant de le passer ici fera
   * échouer toutes les vérifications de signature, avec un « ça marche chez
   * moi » pour seul indice.
   */
  corps: string;
  /** Les en-têtes, en minuscules. */
  entetes: Readonly<Record<string, string | undefined>>;
}

export interface ReponseWeb {
  statut: number;
  entetes: Record<string, string>;
  corps: string;
}
