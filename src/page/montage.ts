import type { ReponseWeb, RequeteWeb } from "../web";

/**
 * Ndank — monter la page dans l'hôte, quel qu'il soit.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * NDANK NE LIVRE PAS DE SERVEUR, ET N'EN LIVRERA PAS
 *
 * `dependencies` est vide. Le routeur est une fonction d'une requête vers une
 * réponse ; ce fichier ne fait que traduire, dans les deux formes qui couvrent
 * à peu près tout ce qui existe :
 *
 *   — **`Request`/`Response`**, la forme du web : Next, Hono, Bun, Deno, les
 *     fonctions déployées au bord, et Node depuis la version 18 ;
 *   — **`(req, res)`**, la forme de Node : `http.createServer`, Express,
 *     Fastify avec son mode brut.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * AUCUN `import` DE `node:http`, ET C'EST DÉLIBÉRÉ
 *
 * L'adaptateur Node décrit les formes dont il a besoin plutôt que d'importer
 * les types du module. C'est la même décision que pour `@prisma/client` : un
 * `import "node:http"` dans un fichier que Next embarque dans une fonction
 * déployée au bord la fait échouer à la construction, pour un adaptateur que
 * cet hôte-là n'appellera jamais.
 */

// ─────────────────────────────────────────────────────────────── web ──

/**
 * Traduit un routeur en gestionnaire `Request` → `Response`.
 *
 * `prefixe` est le chemin où la page est montée, tel qu'il apparaît dans l'URL
 * publique : `/v`, `/abonnement/valider`. Il est retiré avant que le routeur ne
 * voie le chemin, parce que le routeur ne sait pas où on l'a monté — et ne doit
 * pas avoir à le savoir.
 */
export function versFetch(
  routeur: (requete: RequeteWeb) => Promise<ReponseWeb>,
  prefixe = "",
): (requete: Request) => Promise<Response> {
  const tete = prefixe.replace(/\/+$/, "");

  return async (requete) => {
    const url = new URL(requete.url);

    const chemin = url.pathname.startsWith(tete)
      ? url.pathname.slice(tete.length)
      : url.pathname;

    const parametres: Record<string, string> = {};
    url.searchParams.forEach((valeur, cle) => {
      parametres[cle] = valeur;
    });

    const entetes: Record<string, string> = {};
    requete.headers.forEach((valeur, cle) => {
      entetes[cle.toLowerCase()] = valeur;
    });

    // `GET` et `HEAD` n'ont pas de corps, et en demander un lève dans certaines
    // implémentations plutôt que de rendre une chaîne vide.
    const corps =
      requete.method === "GET" || requete.method === "HEAD"
        ? ""
        : await requete.text();

    const reponse = await routeur({
      methode: requete.method,
      chemin,
      parametres,
      corps,
      entetes,
    });

    return new Response(reponse.corps, {
      status: reponse.statut,
      headers: reponse.entetes,
    });
  };
}

// ────────────────────────────────────────────────────────────── node ──

/** Ce qu'on lit d'une requête Node. Décrit, et non importé. */
export interface RequeteNode {
  method?: string | undefined;
  url?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  on(evenement: "data", ecouteur: (morceau: Buffer | string) => void): unknown;
  on(evenement: "end", ecouteur: () => void): unknown;
  on(evenement: "error", ecouteur: (cause: unknown) => void): unknown;
}

/** Ce qu'on écrit sur une réponse Node. */
export interface ReponseNode {
  writeHead(statut: number, entetes: Record<string, string>): unknown;
  end(corps?: string): unknown;
}

/**
 * Lit le corps d'une requête Node.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * IL EST BORNÉ, ET IL FAUT QU'IL LE SOIT
 *
 * Ce point de montage est public : n'importe qui sur Internet peut y poster. Un
 * corps non borné laisse quiconque remplir la mémoire du processus en une
 * requête, sans même avoir de jeton valide.
 *
 * Cent kilo-octets est très au-delà d'un formulaire à trois champs — et très
 * en-deçà de ce qui fait tomber un service.
 */
const CORPS_MAX = 100_000;

function lireCorps(requete: RequeteNode): Promise<string> {
  return new Promise((resoudre, rejeter) => {
    let corps = "";
    let trop = false;

    requete.on("data", (morceau) => {
      if (trop) return;

      corps += typeof morceau === "string" ? morceau : morceau.toString("utf8");

      if (corps.length > CORPS_MAX) {
        trop = true;
        corps = "";
      }
    });

    requete.on("end", () => resoudre(corps));
    requete.on("error", rejeter);
  });
}

/**
 * Traduit un routeur en gestionnaire Node `(req, res)`.
 *
 * Se monte tel quel dans `http.createServer`, ou dans Express avec
 * `app.use("/v", versNode(routeur, "/v"))`.
 */
export function versNode(
  routeur: (requete: RequeteWeb) => Promise<ReponseWeb>,
  prefixe = "",
): (requete: RequeteNode, reponse: ReponseNode) => Promise<void> {
  const tete = prefixe.replace(/\/+$/, "");

  return async (requete, reponse) => {
    // L'hôte est arbitraire : on ne s'en sert que pour découper le chemin des
    // paramètres, jamais pour fabriquer un lien.
    const url = new URL(requete.url ?? "/", "http://interne");

    const chemin = url.pathname.startsWith(tete)
      ? url.pathname.slice(tete.length)
      : url.pathname;

    const parametres: Record<string, string> = {};
    url.searchParams.forEach((valeur, cle) => {
      parametres[cle] = valeur;
    });

    const entetes: Record<string, string> = {};
    for (const [cle, valeur] of Object.entries(requete.headers)) {
      if (typeof valeur === "string") entetes[cle.toLowerCase()] = valeur;
      else if (Array.isArray(valeur)) entetes[cle.toLowerCase()] = valeur.join(", ");
    }

    const methode = requete.method ?? "GET";

    const corps =
      methode === "GET" || methode === "HEAD" ? "" : await lireCorps(requete);

    const sortie = await routeur({
      methode,
      chemin,
      parametres,
      corps,
      entetes,
    });

    reponse.writeHead(sortie.statut, sortie.entetes);
    reponse.end(sortie.corps);
  };
}
