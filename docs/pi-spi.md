# π-SPI — fiche de candidature

**Statut : candidat documenté. Aucun adaptateur écrit, et c'est délibéré.**

Ce document consigne ce qu'on sait de la Plateforme Interopérable du Système de
Paiement Instantané de la BCEAO, lu le 10 septembre 2026 dans la spécification
OpenAPI publiée par [lomi.](https://github.com/lomiafrica/pi-spi-sdk).

Il existe pour une raison précise : **le jour où un PSP nous ouvrira un accès,
il ne faudra pas relire tout cela.** Et pour une seconde, moins agréable : la
tentation d'écrire l'adaptateur maintenant est réelle, et ce serait la
cinquième fois qu'on écrit du code contre une documentation sans jamais
l'appeler. Flutterwave nous a coûté trois versions pour exactement cela.

---

## Ce qui a été mesuré, et ce qui a seulement été lu

La distinction est la règle de la maison. Elle s'applique ici aussi.

| Fait | Comment on le sait |
|---|---|
| `pi-spi-sdk@0.2.0` s'installe depuis npm | **mesuré** — 58 paquets, 6,8 Mo |
| Le paquet publié n'a que 4 dépendances | **mesuré** — le `file:` du dépôt a disparu au packaging |
| `versFournisseur(1500, "XOF", 2) = 150000` | **mesuré** contre notre `devise.ts` |
| Les montants sont en centimes | **lu** — README de lomi., jamais confirmé par la BCEAO |
| Un alias MBNO est un numéro E.164 | **lu** — et pas dans la spécification, voir plus bas |
| Tout le reste de ce document | **lu** dans `openapi.json` |

Rien de ce dépôt n'a été appelé. Le bac à sable est
`https://sandbox.api.pi-bceao.com/piz/v1` et il est réservé aux participants
certifiés.

---

## Les alias — ce que c'est réellement

Un alias est une **adresse de paiement stable rattachée à un compte**. On
l'échange à la place d'un numéro de compte, comme on donne un pseudonyme plutôt
qu'une adresse postale.

Trois types, et le troisième est celui qui nous intéresse :

| Type | Forme | Pour qui | Exemple |
|---|---|---|---|
| **SHID** | UUID, 36 caractères | tous (P, C, B, G) | `8b1b2499-3e50-435b-b757-ac7a83d8aa7f` |
| **MCOD** | code alphanumérique court, pour l'USSD | entreprises (C, B, G) | `SNF00_2E4TY` |
| **MBNO** | **numéro de téléphone mobile** | **particuliers (P) seulement** | `+221771234567` |

Limite : **20 alias par compte** par défaut, relevable.

### Les trois routes, et ce qu'elles ne font pas

```
POST   /comptes/{numero}/alias        créer un alias sur SON compte
GET    /comptes/{numero}/alias        lister les alias de SON compte
DELETE /comptes/{numero}/alias/{cle}  en retirer un
```

**Il n'existe aucune route de résolution d'alias.** On ne peut pas demander
« quel est l'alias de ce numéro de téléphone ? », ni « à qui appartient cet
alias ? ». Les trois routes ne portent que sur un compte qu'on administre déjà.

C'est le point qu'il faut avoir en tête avant tout le reste, parce qu'il décide
de ce que Ndank pourrait ou ne pourrait pas faire.

### Le corps de la création ne contient que le type

```json
{ "type": "SHID" }
```

Pas de numéro, pas de nom. Le système génère la clé, ou la dérive du compte.
Pour un MBNO, cela signifie que **le numéro vient du dossier client du PSP**,
pas de l'appelant. Un particulier ne choisit pas son alias téléphonique : c'est
le numéro sous lequel il est déjà enregistré chez sa banque ou son opérateur.

---

## Le point qui change tout : `payeurAlias`

Dans une demande de paiement :

> **`payeurAlias`** — « Alias de compte du client payeur **à qui est adressée la
> demande** »

Une demande de paiement **s'adresse** donc à quelqu'un. Elle n'attend pas qu'il
vienne : elle arrive chez lui, dans son application bancaire ou mobile money,
avec le montant, le motif, un logo, et une date limite.

C'est structurellement autre chose qu'un lien de paiement.

### Et si MBNO est bien un E.164, alors…

Ndank connaît déjà le numéro de ses abonnés, normalisé en E.164 par
`normaliserIdentifiant`. Si l'alias MBNO d'un particulier **est** son numéro,
alors `payeurAlias` se déduit de ce que Ndank stocke déjà. Aucun enrôlement,
aucune saisie, aucune page.

**Mais cette phrase repose sur un fil.** L'exemple `+221771234567` vient de
`src/types/alias.ts`, un fichier **écrit à la main par lomi.** La
spécification OpenAPI, elle, ne donne aucun exemple de MBNO — seulement SHID et
MCOD. Le format exact (E.164 ? national ? préfixé ?) n'est écrit nulle part
dans la source d'autorité.

C'est très exactement la forme d'erreur qui nous a coûté la 0.14.0 : une
documentation tierce prise pour la spécification. **À vérifier contre le bac à
sable avant d'en dépendre d'une ligne.**

---

## Ce que le postulat de Ndank devient

Il ne bouge pas.

Il n'y a **ni mandat, ni ordre permanent, ni prélèvement récurrent** dans toute
la spécification. `DemandePaiementStatut` le dit sans détour :

```
INITIE       la confirmation du client payé est attendue (recherche d'alias)
ENVOYE       le PSP a transmis la demande au payeur
IRREVOCABLE  le payeur a accepté
REJETE       le payeur a refusé
```

Le payeur accepte ou refuse, **à chaque fois**. Le mobile money ne sait pas
prélever à l'initiative du marchand ; π-SPI non plus. Les deux horloges,
l'échelle de relance, la réconciliation : tout reste fondé.

Ce qui change, c'est le **meilleur barreau de l'échelle**.

| Aujourd'hui | Avec π-SPI |
|---|---|
| SMS → lien signé → page → choisir l'opérateur → saisir son numéro → valider | la demande arrive dans son application, il accepte |

---

## Ce qui s'emboîte avec le modèle de Ndank

### `dateLimiteReponse` — 92 jours par défaut

> « Par défaut, la date limite de réponse est la date de la demande + 92 jours
> (3 mois). » La demande expire à cette date ; le payé ne peut plus ni accepter
> ni refuser après.

Une demande émise à l'échéance reste **acceptable pendant tout le cycle
suivant** — la grâce, la reprise, et bien au-delà. C'est plus long que la
fenêtre entière de `repriseJusquA`.

Traduit dans notre vocabulaire :

```
dateLimitePaiement  →  cycle.echeance       « à payer avant »
dateLimiteReponse   →  cycle.repriseJusquA  au-delà, la demande est morte
```

### `txId` est une clé d'idempotence

> **DU03** (Duplicate Transaction) : le `txId` n'est pas unique.

C'est le rôle exact de notre `reference` (`20260905-1-essaimtob3l31`), qui porte
déjà l'échéance visée, le numéro de versement et l'abonnement. Le mapping est
direct.

### Cinq raisons de rejet sont des garde-fous natifs

C'est ce que la lecture a donné de plus inattendu. Les codes ISO 20022 de rejet
comprennent :

| Code | Sens | Ce que Ndank en ferait |
|---|---|---|
| **APAR** | Already Paid RTP | le cycle est déjà réglé — ne pas relancer |
| **ALAC** | Already Accepted RTP | idem, acceptée mais pas encore dénouée |
| **ARJR / ARFR** | Already Rejected / Refused | l'abonné a dit non, ne pas insister |
| **AEXR** | Already Expired RTP | la demande est morte, en réémettre une |
| **DU03** | txId dupliqué | rejeu détecté en amont |

Autrement dit, **la plateforme refuse elle-même le double débit**. Notre
`dejaCompte` ne disparaît pas — il reste la vérité côté marchand — mais il
cesse d'être la seule barrière.

Deux autres méritent leur propre traitement :

| Code | Sens | Décision |
|---|---|---|
| **AC04** | compte clôturé | cet abonné ne paiera plus jamais par ce canal |
| **AC06** | compte bloqué | idem, mais temporaire |

Un abonné dont le compte est clôturé n'a pas besoin de six SMS de relance. C'est
un signal qu'aucun agrégateur ne nous donne aujourd'hui.

### `confirmation: true` vérifie l'identité avant d'envoyer

Posé à `true`, le PSP fait une recherche d'alias et **rend le nom et le pays du
payeur** avant de transmettre la demande :

```
payeurNom   "Khadidja DIOP"
payeurPays  "SN"
```

Le marchand confirme, ou annule. C'est une vérification d'identité gratuite
avant toute sollicitation — de quoi éviter d'envoyer une facture à un homonyme.

Quand la recherche échoue : **BE23** (Alias invalid).

---

## Les webhooks — meilleurs que ce qu'on connaît

### `X-Signature` : HMAC-SHA256 **du corps**

> « Signature HMAC-SHA256 du corps de la requête. Permet au client de vérifier
> que la notification provient bien du participant. »

C'est précisément ce que Flutterwave ne fait pas. Notre `signature.ts` a dû
documenter, en 0.20.3, que le `verif-hash` de Flutterwave est un secret partagé
qui **n'authentifie pas le corps** — un webhook modifié en route passe la
vérification. Le test réel du 9 septembre l'a montré : montant réécrit de 2 000
à 200 000, signature toujours acceptée.

π-SPI signe le corps. Et impose **mTLS avec un certificat délivré par une
autorité de certification de la BCEAO** par-dessus.

### Mais la charge utile est un lot, pas un événement

```json
{
  "data": [
    { "evCode": "PAIEMENT_RECU", "evDate": "…", "txId": "23552722",
      "montant": 400, "client": "Khadidja DIOP",
      "alias": "9b1b…", "end2endId": "ESNB001…" }
  ],
  "meta": { "total": 1 }
}
```

**`data` est un tableau.** Notre `lireWebhook` rend une `Issue` — une seule. Un
lot de trois paiements en rendrait une et perdrait deux.

Ce n'est pas un défaut de Ndank : aucun fournisseur branché à ce jour n'envoie
de lots. Mais c'est une contrainte à connaître **avant** d'écrire l'adaptateur,
parce qu'elle touche la signature du port et non l'adaptateur seul.

### Les événements

| Code | Quand |
|---|---|
| `PAIEMENT_RECU` | un paiement arrive **ou une demande de paiement est acceptée** |
| `PAIEMENT_ENVOYE` / `PAIEMENT_REJETE` | ordre sortant |
| `RTP_RECU` | on reçoit une demande de paiement |
| `RTP_REJETE` | notre demande a été rejetée |
| `RETOUR_*`, `ANNULATION_*` | remboursements et annulations |

Le renouvellement d'un abonnement arriverait donc en **`PAIEMENT_RECU`**, et non
en `RTP_ACCEPTE` — il n'existe pas. Un exemple de la spécification le confirme :
celui nommé `WebhookEventRTP_ENVOYE_ACCEPTE` porte `evCode: "PAIEMENT_RECU"`.

### Un webhook peut être filtré par alias

```json
{ "callbackUrl": "https://…/webhooks", "alias": "9b1b…",
  "events": ["PAIEMENT_RECUE"] }
```

Un marchand multi-sites pourrait donner **un alias par site** (20 par compte) et
recevoir des notifications séparées. Cela recouvre exactement le champ `site` de
notre projection.

---

## Les unités — le piège, déjà désamorcé

> « amounts are in centimes » — 1 500 XOF s'écrit `montant: 150000`

**C'est l'inverse de l'ISO 4217**, où le XOF n'a aucune décimale. Troisième
fournisseur, troisième convention :

| Fournisseur | `decimalesFournisseur` |
|---|---|
| Flutterwave | `0` |
| Paystack | `2` |
| **π-SPI** | **`2`** |

Mesuré contre notre module :

```
versFournisseur(1500, "XOF", 2) = 150000   ← ce que π-SPI attend
```

`DECIMALES_PISPI = 2`, et **rien d'autre à faire**. C'est l'erreur de facteur
100 qui a coûté la 0.9.0, et `devise.ts` la couvre déjà.

Attention tout de même : **la spécification OpenAPI ne dit jamais « centimes »**.
Le mot n'apparaît que dans le README de lomi. et dans leurs aides
`xofToCentimes`. L'indice le plus solide est l'exemple `CompteSolde` :
`solde: 150000000` que leur README glose « 1 500 000 XOF ». C'est cohérent, mais
c'est une lecture, pas une confirmation de la BCEAO.

---

## Les défauts relevés dans la spécification

Ils ne sont pas rédhibitoires. Ils sont le genre de chose qui coûte une
après-midi quand on les découvre en intégrant.

1. **`categorie` se contredit.** Le schéma la déclare `type: "string"` avec
   `enum: ["500", "521", "401"]`. Les exemples utilisent tantôt `"401"`
   (chaîne), tantôt `401` (nombre). Et on trouve dans le fichier des catégories
   `"000"`, `"400"` et `"733"` qui ne sont dans aucun énuméré.

2. **L'URL du bac à sable n'est pas la même partout.** `openapi.json` déclare
   `https://sandbox.api.pi-bceao.com/piz/v1`. Un autre document du dépôt donne
   `sandbox.api.pi-spi.bceao.int`. Deux domaines différents.

3. **Le type généré `DemandePaiementRequest` a sept variantes** pour trois
   catégories. Artefact de génération : l'union `oneOf` n'a pas de
   discriminant exploitable, et le code généré est donc inutilisable tel quel
   pour distinguer les cas.

4. **`dateLimitePaiement` a deux sens selon la catégorie.** Pour le
   e-commerce immédiat (521), c'est « 2 minutes après création ». Pour la
   facture (401), c'est le « à payer avant ». Le même champ, deux horloges. Pour
   Ndank, **seule la 401 a du sens** — c'est la catégorie « Autres demandes de
   paiement de facture ».

---

## Comparaison de structure

| | pi-spi-sdk | Ndank |
|---|---|---|
| Nature | un **transport** — client d'une API | un **domaine** — moteur d'abonnement |
| Forme | `new PiSpiSDK({ baseUrl, accessToken })` | fonctions pures et ports |
| Sait | comptes, paiements, alias, QR, webhooks | cycles, échelle, réconciliation, santé |
| Montants | centimes | unités mineures ISO 4217 |
| Dépendances | 4 directes, 58 installées, 6,8 Mo | `{}` |
| Source | généré depuis OpenAPI + services écrits à la main | écrit |
| Version | 0.2.0 | 0.20.x |

**Ils ne se concurrencent pas.** π-SPI est un candidat `Encaissement` de plus, à
côté de Paystack, Flutterwave et MTN. Leur SDK est ce que serait notre couche
`fournisseurs/` si elle était tout le produit.

---

## Si on l'intégrait

Le port `Encaissement` accueille π-SPI sans modification :

| Ndank | π-SPI |
|---|---|
| `inviter` | `POST /demandes-paiements`, catégorie 401 |
| `constater` | `GET /demandes-paiements/{txId}` |
| `lireWebhook` | `POST` du participant, `X-Signature` en HMAC-SHA256 |

**On n'installerait pas leur SDK.** `dependencies: {}` est vérifié par
`src/paquet.test.ts`, et c'est une partie de ce qui rend Ndank acceptable à
installer. On écrirait `src/encaissement/fournisseurs/pi-spi.ts` contre l'API
REST, en lisant leur code comme référence — la méthode exacte de
`flutterwave.ts`.

### Les deux obstacles

**L'accès.** Il faut être « connecté à un participant π-SPI certifié ou à un
PSP ». Un marchand ne s'y branche pas seul. Même forme qu'aujourd'hui avec les
agrégateurs, et une relation commerciale à nouer avant la première ligne de
code.

**mTLS avec un certificat BCEAO.** Notre port `Http` ne porte aujourd'hui ni
certificat client ni CA. C'est le vrai travail d'intégration, et il est plus
profond qu'un adaptateur : il touche le port.

---

## Ce qu'il faudra vérifier le jour venu

Dans cet ordre, parce que le premier décide des autres.

- [ ] **Le format exact d'un alias MBNO.** E.164 avec `+` ? Sans ? National ?
      C'est ce qui décide si Ndank peut adresser un abonné avec ce qu'il a déjà.
- [ ] **Le sens réel de `IRREVOCABLE`** — accepté, ou dénoué ? Notre `REUSSI`
      demande que l'argent soit parti.
- [ ] **Les montants en centimes**, contre une vraie transaction. La spécification
      ne le dit pas.
- [ ] **Un lot de webhooks à plusieurs événements** — le port rend une `Issue`.
- [ ] **La casse de `PAIEMENT_RECU`** : la spécification écrit `PAIEMENT_RECUE`
      dans les exemples de création de webhook et `PAIEMENT_RECU` dans les
      événements. L'un des deux est faux.
- [ ] **Le plafond de la 429** — la spécification la déclare sans jamais donner
      de chiffre.

---

## Décision

**Ne pas écrire l'adaptateur.** Il ne serait éprouvable contre rien, et la
leçon de cette semaine est que les défauts sortent du faire, pas du lire :
Flutterwave v4 ne pouvait même pas s'authentifier, Resend partageait un objet
entre deux barreaux, le téléphone Android jetait la cause de l'échec, et le
webhook réel a montré qu'une signature peut ne rien signer.

Cette fiche vaut mieux qu'un cinquième adaptateur non appelé. Elle sera là le
jour où un PSP nous ouvrira une porte.
