# printctl — MeshCentral plugin

Module de suivi du serveur d’impression Windows : inventaire et état des files via RPC, travaux et purge via WMI, sans agent. La purge reste une action explicite avec confirmation.

Aucune dépendance à EannaAD ni à SYSVOL.

## Prérequis serveur MeshCentral (Linux)

Installer `rpcclient` (inventaire imprimantes), `impacket` (files d'attente WMI) et `snmpget` (récupération du modèle d'imprimante) :

```bash
sudo apt install -y samba-common-bin python3-impacket snmp
```

## Compte de service AD

Crée (via EannaAD) un compte de service avec les droits suivants sur le serveur d'impression :
- `Print Operators` ou droit `SeLoadDriverPrivilege` + permission "Manage Printers" sur l'imprimante racine.

Pour de la lecture seule, le compte n'a besoin que de `Read` (par défaut pour Authenticated Users sur les imprimantes), mais selon ta politique AD un compte dédié reste plus propre que le compte admin de domaine.

## Installation

1. Crée le repo `printctl-meshcentral` sur GitHub, push ce dossier.
2. Plugins MeshCentral → Add Plugin → URL :
   `https://raw.githubusercontent.com/V3locidad/printctl-meshcentral/main/config.json`
3. Sur le serveur MeshCentral :
   ```bash
   cd /home/maintenance/meshcentral-data/plugins/printctl
   cp printer-config.json.example printer-config.json
   # édite printer-config.json avec host/user/password/domain
   chmod 600 printer-config.json
   ```
4. Recharge le plugin depuis MeshCentral.

## Actions HTTP

- `?action=ping` — smoke test (compte d'imprimantes accessibles).
- `?action=list` — `rpcclient enumprinters 2` parsé.
- `?action=jobs&printer=NAME&host=SERVER` — travaux via WMI/impacket.
- `?action=pingPrinter&ip=IP` — ICMP, puis connexion TCP si nécessaire ; `alive: true` si une réponse est confirmée, `null` sinon.
- `?action=getStatus&ip=IP` — état SNMP avec indicateurs `available` et `errorsKnown` ; `force=1` ignore le cache.


## Interface — version 0.0.30

Les quatre compteurs filtrent le tableau : **Toutes les imprimantes**, **Prêtes**, **À surveiller** (alertes Windows ou SNMP, files suspendues ou en activité) et **État inconnu**. Une file Windows prête reste dans « Prêtes » si l’accès réseau direct n’est pas confirmé ; une alerte SNMP valide la fait passer dans « À surveiller ».

La recherche porte sur le nom, le partage, l’adresse, le modèle, le pilote, l’emplacement et le serveur. Elle se combine avec le filtre par serveur et le compteur sélectionné. Les compteurs décrivent le parc du serveur sélectionné, indépendamment du texte recherché. **Effacer les filtres** rétablit la vue complète.

Cliquer sur une imprimante ouvre son panneau de détails et ses travaux : document, utilisateur, état, pages, taille et date de soumission en heure du serveur. Le panneau s’affiche à droite sur grand écran et sous le tableau sur petit écran. Le tableau conserve un défilement horizontal quand nécessaire.

**Actualiser la file** relit les travaux de l’imprimante sélectionnée. **Vider la file** demande confirmation en indiquant l’imprimante et le serveur ; la sélection reste verrouillée pendant cette opération. Les erreurs de lecture sont affichées explicitement. Après la purge, le module relit la file, y compris en cas de suppression partielle, pour conserver à l’écran les travaux restants. L’actualisation générale automatique reste à 30 secondes.

## États des imprimantes

La colonne Statut distingue les sources :

- **Windows : Prête / Suspendue / Hors connexion / …** : état de la file fourni par le serveur d’impression (`PRINTER_INFO_2.Status`), actualisé toutes les 30 secondes. « Prête » décrit ce que Windows signale ; ce n’est pas une preuve de connexion directe depuis MeshCentral.
- **Joignable depuis MeshCentral** : réponse ICMP, connexion TCP (9100, 631, 515, 443 ou 80) ou réponse SNMP valide. Le test TCP n’envoie aucune donnée d’impression.
- **Accès direct non confirmé** : aucun test réseau n’a confirmé l’accès. Un filtrage réseau, une veille ou une commande `ping` absente ne suffisent plus à afficher « hors ligne ».
- **SNMP : …** : état ou alerte confirmé par une réponse SNMP valide. Les textes d’erreur, les délais dépassés et les objets SNMP non pris en charge ne deviennent ni des alertes ni un statut « OK ». Une absence de statut reste visible comme **État SNMP indisponible** ou **incomplet**.

Le voyant reprend l’état Windows lorsqu’il est disponible ; son infobulle indique la source. Des états Windows et SNMP différents restent affichés séparément pour permettre le diagnostic. Le modèle n’est plus remplacé par « hors ligne » après un ping échoué : le nom du pilote Windows sert de repli, identifié comme tel.

Le module interroge SNMP même sans réponse au ping et recherche l’index réel dans la table `hrPrinterEntry`. Si plusieurs périphériques figurent dans cette table, l’état est laissé inconnu plutôt que de fusionner leurs alertes. Le décodage utilise des OID numériques et des octets hexadécimaux, indépendamment des MIB installées. Le bouton **Rafraîchir** ignore le cache de statut ; une réponse en échec n’est pas mise en cache.

Après la mise à jour, recharger le plugin puis son panneau dans MeshCentral. Aucune modification des imprimantes ou de la configuration SNMP n’est nécessaire pour ce correctif. Si une alerte SNMP valide persiste malgré un état Windows « Prête », comparer avec l’interface de l’imprimante : le module n’efface pas une alerte réellement renvoyée par le matériel.

Références : [état Windows PRINTER_INFO_2](https://learn.microsoft.com/en-us/windows/win32/printdocs/printer-info-2), [Host Resources MIB, RFC 2790](https://www.rfc-editor.org/rfc/rfc2790.html), [options de sortie Net-SNMP](https://www.net-snmp.org/docs/man/snmpcmd.html).

## Tests

Exécuter `node --test test/*.test.js` avec Node.js 18 ou ultérieur. Les 24 tests simulent RPC, ICMP, TCP, SNMP et les réponses des files sans contacter le parc réel. Ils couvrent le ping filtré, les connexions sans réponse, les états Windows combinés, les erreurs SNMP, les index autres que 1, le cache, l’affichage des sources, les actualisations concurrentes, les filtres et les compteurs, les changements de sélection, les erreurs de lecture et les purges partielles ou en échec.
