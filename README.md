# printctl — MeshCentral plugin

Visualiseur read-only du serveur d'impression Windows. Liste les imprimantes partagées et leurs files d'attente en interrogeant le service Print Spooler via RPC, sans agent.

Aucune dépendance à EannaAD ni à SYSVOL.

## Prérequis serveur MeshCentral (Linux)

Installer `rpcclient` (inventaire imprimantes) et `impacket` (files d'attente WMI) :

```bash
sudo apt install -y samba-common-bin python3-impacket
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
- `?action=jobs&printer=NAME` — `rpcclient enumjobs <NAME>` parsé.
