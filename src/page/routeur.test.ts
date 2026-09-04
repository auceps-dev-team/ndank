import { describe, expect, it } from "vitest";

import { ajouterJours, cycleApresPaiement } from "../cycle";
import { ErreurFournisseur, type Encaissement, type Issue } from "../encaissement/port";
import { referenceDeVersement, type Creances } from "../encaissement/reconciliation";
import type { AbonnementLu, Coordonnees } from "../ports";
import { grille } from "../offre";
import {
  lireSouscription,
  referenceDeSouscription,
} from "../souscription";
import { lienDe, lienOffre, signerLien, jourDe } from "./lien";
import { versFetch } from "./montage";
import type { ReglagesPage } from "./port";
import type { RequeteWeb } from "../web";
import { routeurPage, VERIFICATIONS_MAX, type FaitPage } from "./routeur";

const SECRET = "secret-de-page-suffisamment-long";
const BASE = "https://p.ndank.test/v";
const DEPART = new Date("2026-01-10T00:00:00Z");

function abonnement(sur: Partial<AbonnementLu> = {}): AbonnementLu {
  return {
    id: "ab-1",
    abonneId: "user-1",
    cadence: "MENSUEL",
    // Échéance passée de deux jours : l'accès tient encore, on est en relance.
    cycle: cycleApresPaiement(ajouterJours(new Date(), -32), "MENSUEL"),
    resilieeLe: null,
    montant: 2000,
    devise: "XOF",
    libelle: "Pass Créateur",
    ...sur,
  };
}

/** Un encaissement en mémoire, qui retient ce qu'on lui a demandé. */
function fauxFournisseur(options: {
  url?: string | null;
  instruction?: string | null;
  issues?: Issue["etat"][];
  leve?: boolean;
} = {}) {
  const demandes: { reference: string; montant: number; retour: string; telephone: string | null }[] =
    [];
  const constats: string[] = [];
  const suite = [...(options.issues ?? ["EN_ATTENTE"])];

  const encaissement: Encaissement = {
    nom: "faux",
    devises: ["XOF"],

    async inviter(demande) {
      if (options.leve) throw new ErreurFournisseur("faux", 400, "clé invalide");

      demandes.push({
        reference: demande.reference,
        montant: demande.montant,
        retour: demande.retour,
        telephone: demande.abonne.telephone,
      });

      return {
        reference: demande.reference,
        identifiantFournisseur: "chg_1",
        url: options.url ?? null,
        instruction: options.instruction ?? null,
        etat: "EN_ATTENTE",
        expireLe: null,
      };
    },

    async constater(reference) {
      constats.push(reference);
      return {
        reference,
        etat: suite.shift() ?? "EN_ATTENTE",
        montant: 2000,
        devise: "XOF",
        identifiantFournisseur: "chg_1",
        regleLe: null,
        brut: {},
      };
    },

    lireWebhook() {
      return null;
    },
  };

  return { encaissement, demandes, constats };
}

const CREANCES_VIDES: Creances = {
  async etat() {
    return { verse: 0, joursAccordes: 0, versements: 0 };
  },
  async dejaCompte() {
    return false;
  },
};

function monter(
  options: {
    abonnement?: AbonnementLu | null;
    fournisseur?: ReturnType<typeof fauxFournisseur>;
    creances?: Creances;
    surIssue?: ReglagesPage["surIssue"];
    telephoneRequis?: boolean;
  } = {},
) {
  const a = options.abonnement === undefined ? abonnement() : options.abonnement;
  const f = options.fournisseur ?? fauxFournisseur();
  const faits: FaitPage[] = [];

  const routeur = routeurPage({
    base: BASE,
    secret: SECRET,
    marque: "Baobart",
    dossier: {
      async abonnement(id) {
        return a !== null && a.id === id ? a : null;
      },
      async coordonnees() {
        return {
          nom: "Awa",
          courriel: "awa@ndank.test",
          telephone: "+2250700000000",
          appareils: [],
        };
      },
    },
    creances: options.creances ?? CREANCES_VIDES,
    fournisseurs: [
      {
        nom: "faux",
        libelle: "Orange Money",
        encaissement: f.encaissement,
        telephone: options.telephoneRequis,
      },
    ],
    montant: (m, d) => `${m} ${d}`,
    surIssue: options.surIssue,
    journal: (fait) => faits.push(fait),
  });

  const jeton = lienDe(BASE, SECRET, a?.id ?? "ab-1").slice(BASE.length + 1);

  return { routeur, jeton, faits, fournisseur: f, abonnement: a };
}

function requete(
  chemin: string,
  sur: Partial<RequeteWeb> = {},
): RequeteWeb {
  return {
    methode: "GET",
    chemin,
    parametres: {},
    corps: "",
    entetes: {},
    ...sur,
  };
}

describe("la page de règlement", () => {
  it("montre l'offre, le montant et les moyens de paiement", async () => {
    const m = monter();
    const r = await m.routeur(requete(`/${m.jeton}`));

    expect(r.statut).toBe(200);
    expect(r.corps).toContain("Pass Créateur");
    expect(r.corps).toContain("2000 XOF");
    expect(r.corps).toContain("Orange Money");
    expect(r.corps).toContain('method="post"');
  });

  it("ne peut être ni indexée, ni gardée, ni suivie par un référent", async () => {
    // Elle affiche, nommément, ce que quelqu'un doit. Et le jeton est dans
    // l'URL : sans « Referrer-Policy: no-referrer », le navigateur l'enverrait
    // au fournisseur dans l'en-tête « Referer » au moment de la redirection, et
    // il se retrouverait dans les journaux d'accès d'un tiers — d'où il ouvre
    // la page d'un abonné pendant quinze jours.
    const m = monter();
    const r = await m.routeur(requete(`/${m.jeton}`));

    expect(r.entetes["Referrer-Policy"]).toBe("no-referrer");
    expect(r.entetes["Cache-Control"]).toContain("no-store");
    expect(r.entetes["X-Robots-Tag"]).toContain("noindex");
    expect(r.corps).toContain('name="robots"');
  });

  it("ne charge aucune ressource extérieure", async () => {
    // Cette page s'ouvre depuis un SMS, sur un téléphone d'entrée de gamme, en
    // 3G. Chaque requête supplémentaire est une occasion d'attendre, et chaque
    // attente est un abandon.
    const m = monter();
    const r = await m.routeur(requete(`/${m.jeton}`));

    expect(r.corps).not.toMatch(/<script/i);
    expect(r.corps).not.toMatch(/<link[^>]+href/i);
    expect(r.corps).not.toMatch(/<img/i);
    expect(r.corps).not.toMatch(/https?:\/\/(?!p\.ndank\.test)/);
  });

  it("échappe ce qui vient de la base", async () => {
    const m = monter({
      abonnement: abonnement({ libelle: 'Pass <script>alert("x")</script>' }),
    });

    const r = await m.routeur(requete(`/${m.jeton}`));

    expect(r.corps).not.toContain("<script>alert");
    expect(r.corps).toContain("&lt;script&gt;");
  });

  it("propose le reliquat, et non la somme entière, à qui a déjà versé", async () => {
    // Redemander deux mille francs à quelqu'un qui en a versé mille deux cents
    // lui fait croire que son premier versement s'est perdu.
    const m = monter({
      creances: {
        async etat() {
          return { verse: 1200, joursAccordes: 0, versements: 1 };
        },
        async dejaCompte() {
          return false;
        },
      },
    });

    const r = await m.routeur(requete(`/${m.jeton}`));

    expect(r.corps).toContain("800 XOF");
    expect(r.corps).toContain("Déjà versé");
  });
});

describe("ce que la page refuse d'afficher", () => {
  it("un jeton expiré, en disant quoi faire", async () => {
    const m = monter();
    const vieux = signerLien(SECRET, {
      abonnementId: "ab-1",
      jourLimite: jourDe(DEPART),
    });

    const r = await m.routeur(requete(`/${vieux}`));

    expect(r.statut).toBe(410);
    expect(r.corps).toContain("expiré");
  });

  it("un jeton forgé, avec la même page qu'un jeton inexistant", async () => {
    // Distinguer les deux à l'écran apprendrait à celui qui essaie quand il
    // chauffe.
    const m = monter();

    const forge = await m.routeur(requete("/aaaa.1.zzzzzzzzzzzzzzzz"));
    const absent = await m.routeur(requete("/nimporte-quoi"));

    expect(forge.statut).toBe(404);
    expect(absent.statut).toBe(404);
    expect(forge.corps).toBe(absent.corps);
  });

  it("un abonnement résilié : il n'y a plus rien à régler", async () => {
    const m = monter({
      abonnement: abonnement({ resilieeLe: new Date("2026-01-20T00:00:00Z") }),
    });

    const r = await m.routeur(requete(`/${m.jeton}`));

    expect(r.statut).toBe(410);
    expect(r.corps).toContain("résilié");
    expect(r.corps).not.toContain('method="post"');
  });

  it("un abonnement à jour : c'est ainsi qu'on évite le double paiement", async () => {
    // Le lien vient d'une relance. S'il mène à un abonnement à jour, c'est
    // presque toujours que l'abonné vient de payer et que la relance a croisé
    // son règlement — ce dont le courriel l'avertissait. Lui montrer quand même
    // un bouton, c'est lui faire payer deux fois, et Ndank ne rembourse pas.
    const m = monter({
      abonnement: abonnement({ cycle: cycleApresPaiement(new Date(), "MENSUEL") }),
    });

    const r = await m.routeur(requete(`/${m.jeton}`));

    expect(r.statut).toBe(200);
    expect(r.corps).toContain("à jour");
    expect(r.corps).not.toContain('method="post"');
  });
});

describe("l'invitation", () => {
  it("transmet une référence qui porte l'abonnement, et un retour vers nous", async () => {
    const m = monter();

    await m.routeur(
      requete(`/${m.jeton}`, {
        methode: "POST",
        corps: "fournisseur=faux&montant=2000",
      }),
    );

    const d = m.fournisseur.demandes[0]!;
    expect(d.reference).toContain("-ab-1");
    expect(d.montant).toBe(2000);
    expect(d.retour).toContain(`${BASE}/${m.jeton}/etat`);
    expect(d.retour).toContain("ref=");
  });

  it("redirige en 303 quand le fournisseur a sa propre page", async () => {
    // Un 302 laisserait certains clients rejouer le POST : un rechargement
    // demanderait un second paiement.
    const m = monter({
      fournisseur: fauxFournisseur({ url: "https://checkout.faux/abc" }),
    });

    const r = await m.routeur(
      requete(`/${m.jeton}`, {
        methode: "POST",
        corps: "fournisseur=faux&montant=2000",
      }),
    );

    expect(r.statut).toBe(303);
    expect(r.entetes["Location"]).toBe("https://checkout.faux/abc");
    expect(r.entetes["Referrer-Policy"]).toBe("no-referrer");
  });

  it("affiche l'instruction du fournisseur quand il pousse sur le téléphone", async () => {
    const m = monter({
      fournisseur: fauxFournisseur({ instruction: "Composez #144# puis validez" }),
    });

    const r = await m.routeur(
      requete(`/${m.jeton}`, {
        methode: "POST",
        corps: "fournisseur=faux&montant=2000",
      }),
    );

    expect(r.statut).toBe(200);
    expect(r.corps).toContain("Composez #144#");
    expect(r.corps).toContain("http-equiv=\"refresh\"");
  });

  it("préfère le numéro saisi à celui de la base", async () => {
    // C'est celui du téléphone que l'abonné a en main, maintenant.
    const m = monter({ telephoneRequis: true });

    await m.routeur(
      requete(`/${m.jeton}`, {
        methode: "POST",
        corps: "fournisseur=faux&montant=2000&telephone=0788888888",
      }),
    );

    expect(m.fournisseur.demandes[0]!.telephone).toBe("0788888888");
  });

  it("revérifie le montant côté serveur", async () => {
    // Un attribut HTML évite la faute de frappe, il n'empêche rien.
    const m = monter();

    const trop = await m.routeur(
      requete(`/${m.jeton}`, {
        methode: "POST",
        corps: "fournisseur=faux&montant=20000",
      }),
    );

    expect(trop.statut).toBe(400);
    expect(m.fournisseur.demandes).toHaveLength(0);

    const zero = await m.routeur(
      requete(`/${m.jeton}`, { methode: "POST", corps: "fournisseur=faux&montant=0" }),
    );

    expect(zero.statut).toBe(400);
  });

  it("ne montre jamais à l'abonné ce que le fournisseur a répondu", async () => {
    // Le message peut contenir un identifiant de compte ou une partie de clé.
    const m = monter({ fournisseur: fauxFournisseur({ leve: true }) });

    const r = await m.routeur(
      requete(`/${m.jeton}`, {
        methode: "POST",
        corps: "fournisseur=faux&montant=2000",
      }),
    );

    expect(r.statut).toBe(502);
    expect(r.corps).not.toContain("clé invalide");

    // Mais l'hôte, lui, l'a dans son journal.
    const erreur = m.faits.find((f) => f.quoi === "ERREUR")!;
    expect(erreur.detail).toContain("clé invalide");
  });
});

describe("le constat", () => {
  it("refuse une référence fabriquée pour un autre abonnement", async () => {
    // Le garde-fou qui rend cette route sûre. Sans lui, il suffirait de changer
    // « ref » pour faire constater — et compter — le paiement de quelqu'un
    // d'autre sur son propre abonnement.
    const m = monter();
    const volee = referenceDeVersement("ab-999", m.abonnement!.cycle.echeance, 0);

    const r = await m.routeur(
      requete(`/${m.jeton}/etat`, { parametres: { ref: volee, f: "faux" } }),
    );

    expect(r.statut).toBe(400);
    expect(m.fournisseur.constats).toHaveLength(0);
    expect(m.faits.some((f) => f.detail === "référence étrangère")).toBe(true);
  });

  it("appelle le crochet de l'hôte quand le paiement a réussi", async () => {
    const recus: Issue[] = [];
    const m = monter({
      fournisseur: fauxFournisseur({ issues: ["REUSSI"] }),
      surIssue: async (issue) => {
        recus.push(issue);
      },
    });

    const ref = referenceDeVersement("ab-1", m.abonnement!.cycle.echeance, 0);
    const r = await m.routeur(
      requete(`/${m.jeton}/etat`, { parametres: { ref, f: "faux" } }),
    );

    expect(r.statut).toBe(200);
    expect(r.corps).toContain("Paiement reçu");
    expect(recus).toHaveLength(1);
  });

  it("n'échoue pas devant l'abonné si le crochet de l'hôte lève", async () => {
    // Le paiement, lui, a bien eu lieu. Afficher un échec ferait repayer.
    const m = monter({
      fournisseur: fauxFournisseur({ issues: ["REUSSI"] }),
      surIssue: async () => {
        throw new Error("base indisponible");
      },
    });

    const ref = referenceDeVersement("ab-1", m.abonnement!.cycle.echeance, 0);
    const r = await m.routeur(
      requete(`/${m.jeton}/etat`, { parametres: { ref, f: "faux" } }),
    );

    expect(r.corps).toContain("Paiement reçu");
    expect(m.faits.some((f) => f.detail === "surIssue a levé")).toBe(true);
  });

  it("ne conclut pas à l'échec sur un état qu'il ne sait pas lire", async () => {
    // Conclure couperait l'accès de quelqu'un qui a peut-être payé.
    const m = monter({ fournisseur: fauxFournisseur({ issues: ["INCONNU"] }) });

    const ref = referenceDeVersement("ab-1", m.abonnement!.cycle.echeance, 0);
    const r = await m.routeur(
      requete(`/${m.jeton}/etat`, { parametres: { ref, f: "faux" } }),
    );

    expect(r.corps).toContain("En attente");
    expect(r.corps).not.toContain("pas abouti");
  });

  it("continue d'attendre quand le fournisseur est injoignable", async () => {
    // Le fournisseur est injoignable, pas l'abonné insolvable.
    const cassé = fauxFournisseur();
    cassé.encaissement.constater = async () => {
      throw new ErreurFournisseur("faux", 503, "indisponible");
    };

    const m = monter({ fournisseur: cassé });
    const ref = referenceDeVersement("ab-1", m.abonnement!.cycle.echeance, 0);

    const r = await m.routeur(
      requete(`/${m.jeton}/etat`, { parametres: { ref, f: "faux" } }),
    );

    expect(r.statut).toBe(200);
    expect(r.corps).toContain("En attente");
  });

  it("arrête de se recharger seule au bout du compte", async () => {
    // Un onglet oublié interrogerait le fournisseur jusqu'à la fin de la
    // batterie — des appels comptés, et parfois facturés.
    const m = monter();
    const ref = referenceDeVersement("ab-1", m.abonnement!.cycle.echeance, 0);

    const tot = await m.routeur(
      requete(`/${m.jeton}/etat`, { parametres: { ref, f: "faux", n: "2" } }),
    );
    const tard = await m.routeur(
      requete(`/${m.jeton}/etat`, {
        parametres: { ref, f: "faux", n: String(VERIFICATIONS_MAX + 1) },
      }),
    );

    expect(tot.corps).toContain("http-equiv=\"refresh\"");
    expect(tard.corps).not.toContain("http-equiv=\"refresh\"");
    // Elle propose toujours de vérifier à la main.
    expect(tard.corps).toContain("Vérifier maintenant");
  });

  it("dit franchement qu'un paiement a été refusé, et propose de réessayer", async () => {
    const m = monter({ fournisseur: fauxFournisseur({ issues: ["ECHOUE"] }) });
    const ref = referenceDeVersement("ab-1", m.abonnement!.cycle.echeance, 0);

    const r = await m.routeur(
      requete(`/${m.jeton}/etat`, { parametres: { ref, f: "faux" } }),
    );

    expect(r.corps).toContain("pas abouti");
    expect(r.corps).toContain(`${BASE}/${m.jeton}`);
  });
});

describe("le montage", () => {
  it("retire le préfixe, parce que le routeur ne sait pas où on l'a monté", async () => {
    const m = monter();
    const gestionnaire = versFetch(m.routeur, "/v");

    const r = await gestionnaire(
      new Request(`https://p.ndank.test/v/${m.jeton}`),
    );

    expect(r.status).toBe(200);
    expect(await r.text()).toContain("Pass Créateur");
  });

  it("passe le corps d'un POST et les paramètres d'un GET", async () => {
    const m = monter({ fournisseur: fauxFournisseur({ url: "https://ailleurs" }) });
    const gestionnaire = versFetch(m.routeur, "/v");

    const r = await gestionnaire(
      new Request(`https://p.ndank.test/v/${m.jeton}`, {
        method: "POST",
        body: "fournisseur=faux&montant=2000",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    );

    expect(r.status).toBe(303);
    expect(m.fournisseur.demandes).toHaveLength(1);
  });
});

describe("le checkout public", () => {
  const OFFRE = {
    id: "createur",
    libelle: "Pass Créateur",
    montant: 5000,
    devise: "XOF",
    cadence: "MENSUEL" as const,
  };

  function boutique(
    options: {
      fournisseur?: ReturnType<typeof fauxFournisseur>;
      actif?: boolean;
    } = {},
  ) {
    const f = options.fournisseur ?? fauxFournisseur();
    const contacts = new Map<string, Coordonnees>();
    const ouverts: Array<{ offreId: string; abonneId: string }> = [];
    const faits: FaitPage[] = [];

    const routeur = routeurPage({
      base: BASE,
      secret: SECRET,
      marque: "Baobart",
      dossier: {
        async abonnement() {
          return null;
        },
      },
      fournisseurs: [
        { nom: "faux", libelle: "Orange Money", encaissement: f.encaissement },
      ],
      montant: (m, d) => `${m} ${d}`,
      indicatifParDefaut: "225",
      offres: async () => grille([{ ...OFFRE, actif: options.actif ?? true }]),
      souscriptions: {
        async abonne(reference, coordonnees) {
          contacts.set(reference, coordonnees);
          return `usr-${reference}`;
        },
        async abonneParReference(reference) {
          return contacts.get(reference) ?? null;
        },
        async enCours() {
          return null;
        },
        async ouvrir(nouveau) {
          ouverts.push({ offreId: nouveau.offre.id, abonneId: nouveau.abonneId });
          return {
            id: "abo-1",
            abonneId: nouveau.abonneId,
            cadence: nouveau.offre.cadence,
            cycle: nouveau.cycle,
            resilieeLe: null,
            suspenduLe: null,
            montant: nouveau.offre.montant,
            devise: nouveau.offre.devise,
            libelle: nouveau.offre.libelle,
          };
        },
      },
      journal: (fait) => faits.push(fait),
    });

    const jeton = lienOffre(BASE, SECRET, "createur").split("/o/")[1]!;

    return { routeur, jeton, contacts, ouverts, faits, fournisseur: f };
  }

  it("montre l'offre et son prix, sans demander plus de trois champs", async () => {
    // Chaque champ ajouté est une occasion d'abandonner, et l'on est sur un
    // téléphone, avant d'avoir payé quoi que ce soit.
    const b = boutique();
    const r = await b.routeur(requete(`/o/${b.jeton}`));

    expect(r.statut).toBe(200);
    expect(r.corps).toContain("Pass Créateur");
    expect(r.corps).toContain("5000 XOF");
    expect(r.corps.match(/<input type="(text|tel)"/g) ?? []).toHaveLength(3);
  });

  it("crée le contact avant le paiement, jamais l'abonnement", async () => {
    // `souscrire` exige un paiement constaté. Un abonnement « en attente » ne
    // peut pas s'exprimer dans le modèle de cycle : il donnerait un accès
    // ouvert à qui n'a rien payé, ou un abonné relancé chaque jour.
    const b = boutique();

    await b.routeur(
      requete(`/o/${b.jeton}`, {
        methode: "POST",
        corps: "nom=Awa&telephone=0700000000&courriel=awa@baobart.ci&fournisseur=faux",
      }),
    );

    expect(b.contacts.get("+2250700000000")?.nom).toBe("Awa");
    expect(b.ouverts).toHaveLength(0);
  });

  it("porte l'offre et l'abonné dans la référence, sans rien stocker d'autre", async () => {
    // Pas de table d'attente : donc pas de purge à écrire, pas d'index à tenir,
    // et pas de réponse à trouver à « que fait-on des lignes que personne n'est
    // venu chercher ».
    const b = boutique();

    await b.routeur(
      requete(`/o/${b.jeton}`, {
        methode: "POST",
        corps: "nom=Awa&telephone=0700000000&courriel=awa@baobart.ci&fournisseur=faux",
      }),
    );

    const lue = lireSouscription(b.fournisseur.demandes[0]!.reference)!;
    expect(lue.offreId).toBe("createur");
    expect(lue.abonneReference).toBe("+2250700000000");
  });

  it("ouvre l'abonnement au retour, et seulement s'il a payé", async () => {
    const b = boutique({ fournisseur: fauxFournisseur({ issues: ["REUSSI"] }) });

    await b.routeur(
      requete(`/o/${b.jeton}`, {
        methode: "POST",
        corps: "nom=Awa&telephone=0700000000&courriel=awa@baobart.ci&fournisseur=faux",
      }),
    );

    const ref = b.fournisseur.demandes[0]!.reference;
    const r = await b.routeur(
      requete(`/o/${b.jeton}/etat`, { parametres: { ref, f: "faux" } }),
    );

    expect(r.statut).toBe(200);
    expect(r.corps).toContain("abonnement est ouvert");
    expect(b.ouverts).toEqual([
      { offreId: "createur", abonneId: "usr-+2250700000000" },
    ]);
  });

  it("refuse une référence qui désigne une autre offre", async () => {
    // Sans ce garde-fou, il suffirait de changer « ref » pour faire naître un
    // abonnement à une offre sur le paiement d'une autre — donc au mauvais prix.
    const b = boutique({ fournisseur: fauxFournisseur({ issues: ["REUSSI"] }) });
    const volee = referenceDeSouscription("autre-offre", "+2250700000000", "1");

    const r = await b.routeur(
      requete(`/o/${b.jeton}/etat`, { parametres: { ref: volee, f: "faux" } }),
    );

    expect(r.statut).toBe(400);
    expect(b.ouverts).toHaveLength(0);
  });

  it("exige un courriel, parce que c'est le canal gratuit de l'échelle", async () => {
    // Sans lui, chaque relance de cet abonné coûtera un SMS.
    const b = boutique();

    const r = await b.routeur(
      requete(`/o/${b.jeton}`, {
        methode: "POST",
        corps: "nom=Awa&telephone=0700000000&courriel=pasunmail&fournisseur=faux",
      }),
    );

    expect(r.statut).toBe(400);
    expect(b.contacts.size).toBe(0);
  });

  it("normalise le numéro sans lui retirer son zéro de tête", async () => {
    const b = boutique();

    await b.routeur(
      requete(`/o/${b.jeton}`, {
        methode: "POST",
        corps:
          "nom=Awa&telephone=07+00+00+00+00&courriel=awa@baobart.ci&fournisseur=faux",
      }),
    );

    expect(b.fournisseur.demandes[0]!.telephone).toBe("+2250700000000");
  });

  it("refuse de vendre une offre retirée du catalogue", async () => {
    // Un lien périmé collé quelque part continuerait sinon de vendre ce qu'on
    // ne vend plus.
    const b = boutique({ actif: false });

    expect((await b.routeur(requete(`/o/${b.jeton}`))).statut).toBe(410);
  });

  it("refuse un jeton d'offre là où on attend un jeton de relance", async () => {
    // Sans le marqueur, un jeton d'offre relu comme un lien de relance
    // désignerait un « abonnement » dont l'identifiant serait celui d'une offre.
    const b = boutique();

    expect((await b.routeur(requete(`/${b.jeton}`))).statut).toBe(404);
  });

  it("ne crée pas un second abonnement quand il y en a déjà un", async () => {
    const b = boutique({ fournisseur: fauxFournisseur({ issues: ["REUSSI"] }) });
    b.contacts.set("+2250700000000", {
      nom: "Awa",
      courriel: "awa@baobart.ci",
      telephone: "+2250700000000",
      appareils: [],
    });

    const ref = referenceDeSouscription("createur", "+2250700000000", "1");
    const r = await b.routeur(
      requete(`/o/${b.jeton}/etat`, { parametres: { ref, f: "faux" } }),
    );

    expect(r.statut).toBe(200);
    expect(b.ouverts).toHaveLength(1);
  });

  it("répond 501 quand l'hôte ne vend pas en ligne", async () => {
    const m = monter();
    expect((await m.routeur(requete("/o/nimporte"))).statut).toBe(501);
  });
});
