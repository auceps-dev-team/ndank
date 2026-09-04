import { describe, expect, it } from "vitest";

import type { Http, Requete } from "../../http";
import type { Coordonnees } from "../../ports";
import { ErreurPasserelle } from "../port";
import { redigerCourriel, redigerPush, redigerSms } from "../redaction";
import type { Message } from "../../ports";
import { brevo } from "./brevo";
import { expo } from "./expo";
import { fondationEnvoi, PAR_NOM_ENVOI } from "./fondations";
import { resend } from "./resend";
import { twilio } from "./twilio";

const OU: Coordonnees = {
  nom: "Awa",
  courriel: "awa@ndank.test",
  telephone: "+2250700000000",
  appareils: ["ExponentPushToken[a]", "ExponentPushToken[b]"],
};

const MESSAGE: Message = {
  cle: "2026-02-09:3",
  destinataire: "Awa",
  offre: "Pass Créateur",
  montant: "2 000 F CFA",
  lien: "https://ndank.test/valider/ab-1",
  joursRestants: 1,
  dernier: true,
};

/** Un `Http` qui rejoue des réponses et retient ce qu'on lui a demandé. */
function fausseHttp(corps: string, statut = 200) {
  const requetes: Requete[] = [];

  const http: Http = async (requete) => {
    requetes.push(requete);
    return { statut, corps };
  };

  return { http, requetes };
}

describe("resend", () => {
  it("envoie le sujet, le texte et le HTML, avec la clé en Bearer", async () => {
    const f = fausseHttp(JSON.stringify({ id: "re-1" }));

    const remise = await resend({
      cleApi: "re_test",
      expediteur: "Baobart <no-reply@baobart.ci>",
      http: f.http,
    }).envoyer(OU, redigerCourriel(MESSAGE));

    expect(remise).toEqual({ parti: true, reference: "re-1" });

    const envoyee = f.requetes[0]!;
    expect(envoyee.url).toBe("https://api.resend.com/emails");
    expect(envoyee.entetes["Authorization"]).toBe("Bearer re_test");

    const corps = JSON.parse(envoyee.corps!) as Record<string, unknown>;
    expect(corps["to"]).toEqual(["awa@ndank.test"]);
    expect(corps["from"]).toBe("Baobart <no-reply@baobart.ci>");
    expect(String(corps["subject"])).toContain("Dernier rappel");
    expect(String(corps["text"])).toContain("Bonjour Awa,");
    expect(String(corps["html"])).toContain("<a href=");
  });

  it("ne compte pas comme parti un 2xx sans identifiant", async () => {
    // Noter la relance sur un envoi qu'on ne sait pas attester ferait que le
    // moteur ne réessaierait jamais.
    const f = fausseHttp(JSON.stringify({ message: "queued" }));

    const remise = await resend({
      cleApi: "re_test",
      expediteur: "a@b.ci",
      http: f.http,
    }).envoyer(OU, redigerCourriel(MESSAGE));

    expect(remise.parti).toBe(false);
  });

  it("remonte le refus de la passerelle mot pour mot", async () => {
    // Le premier obstacle réel d'un hôte : le domaine n'est pas vérifié. Le
    // message de Resend le dit — encore faut-il qu'il remonte.
    const f = fausseHttp(
      JSON.stringify({ message: "The baobart.ci domain is not verified" }),
      403,
    );

    await expect(
      resend({ cleApi: "re_x", expediteur: "a@baobart.ci", http: f.http }).envoyer(
        OU,
        redigerCourriel(MESSAGE),
      ),
    ).rejects.toThrow(/domain is not verified/);
  });
});

describe("brevo", () => {
  it("authentifie par l'en-tête « api-key », et non par un Bearer", async () => {
    // Le réflexe après Resend donne un 401 dont le message ne dit pas que
    // l'en-tête est le mauvais.
    const f = fausseHttp(JSON.stringify({ messageId: "<brevo-1>" }));

    const remise = await brevo({
      cleApi: "xkeysib-test",
      expediteur: "no-reply@baobart.ci",
      nomExpediteur: "Baobart",
      http: f.http,
    }).envoyer(OU, redigerCourriel(MESSAGE));

    expect(remise.reference).toBe("<brevo-1>");
    expect(f.requetes[0]!.entetes["api-key"]).toBe("xkeysib-test");
    expect(f.requetes[0]!.entetes["Authorization"]).toBeUndefined();

    const corps = JSON.parse(f.requetes[0]!.corps!) as Record<string, unknown>;
    expect(corps["sender"]).toEqual({
      email: "no-reply@baobart.ci",
      name: "Baobart",
    });
    expect(corps["to"]).toEqual([{ email: "awa@ndank.test", name: "Awa" }]);
  });
});

describe("twilio", () => {
  const CONFIG = { sid: "AC1", jeton: "secret", expediteur: "+15550001111" };

  it("envoie un formulaire, et non du JSON", async () => {
    // Twilio est l'une des dernières grandes API à attendre du
    // « x-www-form-urlencoded ». Lui envoyer du JSON donne un 400 qui se plaint
    // d'un « To » manquant — alors qu'il est là, dans un corps non lu.
    const f = fausseHttp(JSON.stringify({ sid: "SM1", status: "queued" }));

    const remise = await twilio({ ...CONFIG, http: f.http }).envoyer(
      OU,
      redigerSms(MESSAGE),
    );

    expect(remise).toEqual({ parti: true, reference: "SM1" });

    const envoyee = f.requetes[0]!;
    expect(envoyee.entetes["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(envoyee.entetes["Authorization"]).toContain("Basic ");

    const champs = new URLSearchParams(envoyee.corps!);
    expect(champs.get("To")).toBe("+2250700000000");
    expect(champs.get("From")).toBe("+15550001111");
    expect(champs.get("Body")).toContain("https://ndank.test/valider/ab-1");
  });

  it("refuse de se construire sans expéditeur ni service de messagerie", () => {
    // À la construction, et non au premier envoi : le premier envoi est une
    // relance de dernier palier, donc un abonné qu'on allait couper.
    expect(() => twilio({ sid: "AC1", jeton: "s" })).toThrow(/expediteur/);
  });

  it("juge indisponible un numéro local quand aucun indicatif n'est donné", () => {
    // Le refus reviendrait en erreur de passerelle, donc en « injoignable »
    // dans le bilan — sans dire que le problème est un format de numéro.
    const t = twilio(CONFIG);
    const local = { ...OU, telephone: "07 00 00 00 00" };

    expect(t.disponible!(local)).toBe(false);
    expect(twilio({ ...CONFIG, indicatifParDefaut: "225" }).disponible!(local)).toBe(
      true,
    );
  });

  it("garde le zéro de tête ivoirien en promouvant un numéro local", async () => {
    const f = fausseHttp(JSON.stringify({ sid: "SM2", status: "accepted" }));

    await twilio({
      ...CONFIG,
      indicatifParDefaut: "225",
      http: f.http,
    }).envoyer({ ...OU, telephone: "07 00 00 00 00" }, redigerSms(MESSAGE));

    expect(new URLSearchParams(f.requetes[0]!.corps!).get("To")).toBe(
      "+2250700000000",
    );
  });

  it("ne compte pas comme parti un message déjà « failed » à la création", async () => {
    // Le noter ferait que le moteur ne réessaierait jamais.
    const f = fausseHttp(JSON.stringify({ sid: "SM3", status: "failed" }));

    const remise = await twilio({ ...CONFIG, http: f.http }).envoyer(
      OU,
      redigerSms(MESSAGE),
    );

    expect(remise.parti).toBe(false);
    expect(remise.reference).toBe("SM3");
  });
});

describe("expo", () => {
  it("pousse vers tous les appareils en un seul appel", async () => {
    // Quelqu'un installe l'application sur son téléphone ET sur celui de son
    // commerce. N'en servir qu'un ferait arriver la relance sur celui resté
    // dans un tiroir.
    const f = fausseHttp(
      JSON.stringify({
        data: [
          { status: "ok", id: "t-1" },
          { status: "ok", id: "t-2" },
        ],
      }),
    );

    const remise = await expo({ http: f.http }).envoyer(OU, redigerPush(MESSAGE));

    expect(remise.parti).toBe(true);
    expect(f.requetes).toHaveLength(1);

    const corps = JSON.parse(f.requetes[0]!.corps!) as Record<string, unknown>[];
    expect(corps).toHaveLength(2);
    expect(corps[0]!["to"]).toBe("ExponentPushToken[a]");
    expect((corps[0]!["data"] as Record<string, unknown>)["lien"]).toBe(
      "https://ndank.test/valider/ab-1",
    );
    expect(corps[0]!["collapseId"]).toBe("2026-02-09:3");
  });

  it("lit les refus cachés dans un 200, et nomme les jetons morts", async () => {
    // C'est le piège de cette API : Expo répond 200 avec un tableau où chaque
    // entrée porte son propre statut. Une application désinstallée donne
    // « DeviceNotRegistered » dans une réponse que tout code naïf compte comme
    // un succès.
    const f = fausseHttp(
      JSON.stringify({
        data: [
          { status: "ok", id: "t-1" },
          {
            status: "error",
            message: "not registered",
            details: { error: "DeviceNotRegistered" },
          },
        ],
      }),
    );

    const remise = await expo({ http: f.http }).envoyer(OU, redigerPush(MESSAGE));

    // Un appareil joint suffit : un téléphone remplacé l'an dernier ne doit pas
    // faire échouer la notification arrivée sur celui d'aujourd'hui.
    expect(remise.parti).toBe(true);
    expect(remise.aRetirer).toEqual(["ExponentPushToken[b]"]);
  });

  it("ne réclame pas le retrait d'un jeton sur une panne passagère", async () => {
    // Retirer le jeton sur un dépassement de quota reviendrait à perdre
    // l'abonné pour de bon.
    const f = fausseHttp(
      JSON.stringify({
        data: [
          { status: "error", details: { error: "MessageRateExceeded" } },
          { status: "error", details: { error: "MessageRateExceeded" } },
        ],
      }),
    );

    const remise = await expo({ http: f.http }).envoyer(OU, redigerPush(MESSAGE));

    expect(remise.parti).toBe(false);
    expect(remise.aRetirer).toEqual([]);
  });
});

describe("l'appel commun", () => {
  it("nomme la passerelle quand elle répond autre chose que du JSON", async () => {
    // Une page d'erreur HTML sur un 502 ferait lever « Unexpected token < », un
    // message qui ne nomme ni la passerelle ni le statut.
    const f = fausseHttp("<html><body>Bad Gateway</body></html>", 502);

    await expect(
      resend({ cleApi: "k", expediteur: "a@b.ci", http: f.http }).envoyer(
        OU,
        redigerCourriel(MESSAGE),
      ),
    ).rejects.toThrow(ErreurPasserelle);
  });

  it("accepte un corps vide sur un 2xx", async () => {
    // Certaines passerelles répondent 202 sans rien dire. `JSON.parse("")`
    // lèverait, et l'envoi serait compté en échec alors qu'il est parti.
    const f = fausseHttp("", 202);

    const remise = await resend({
      cleApi: "k",
      expediteur: "a@b.ci",
      http: f.http,
    }).envoyer(OU, redigerCourriel(MESSAGE));

    // Pas d'identifiant, donc pas d'attestation : on ne le compte pas parti.
    expect(remise.parti).toBe(false);
  });
});

describe("les fondations", () => {
  it("se disent indisponibles, pour que le moteur descende au canal suivant", () => {
    const orange = fondationEnvoi(PAR_NOM_ENVOI["orange-sms"]!);

    expect(orange.canal).toBe("sms");
    expect(orange.disponible!(OU)).toBe(false);
  });

  it("rejettent une promesse, et ne lèvent pas de façon synchrone", async () => {
    // Une exception levée hors de la promesse échapperait au `.catch()` d'un
    // appelant qui n'aurait pas écrit `await`.
    const fcm = fondationEnvoi(PAR_NOM_ENVOI["fcm"]!);

    let promesse: Promise<unknown>;
    expect(() => {
      promesse = fcm.envoyer(OU, {} as never);
    }).not.toThrow();

    await expect(promesse!).rejects.toThrow(/n'est pas branchée/);
  });

  it("disent ce qui manque et où l'obtenir", async () => {
    const webpush = fondationEnvoi(PAR_NOM_ENVOI["webpush"]!);

    await expect(webpush.envoyer(OU, {} as never)).rejects.toThrow(/VAPID/);
    await expect(webpush.envoyer(OU, {} as never)).rejects.toThrow(
      /Transporteur/,
    );
  });
});
