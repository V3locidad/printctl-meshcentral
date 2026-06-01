# printctl — MeshCentral plugin

Lecture seule du déploiement d'imprimantes par salle, depuis le JSON GPO produit par EannaAD (`Imprimantes_Par_OU.json` dans SYSVOL).

L'édition reste dans EannaAD : ce plugin ne fait que consulter, jamais écrire.

## Installation

1. Installe le plugin via MeshCentral (Plugins → Add → URL de ce repo).
2. Sur le serveur MeshCentral (Linux), monte SYSVOL en lecture seule, par exemple via `/etc/fstab` :

   ```
   //L-GRAVES.LOCAL/SYSVOL  /mnt/sysvol  cifs  ro,guest,vers=3.0,nofail  0  0
   ```

   Puis `sudo mkdir -p /mnt/sysvol && sudo mount -a`.

3. Copie `printer-config.json.example` en `printer-config.json` dans le dossier du plugin, et vérifie que `jsonPath` pointe bien sur le `Imprimantes_Par_OU.json` (l'UUID de la GPO peut varier).

4. Recharge le plugin depuis MeshCentral.

## Actions HTTP

- `?action=ping` — smoke test : confirme l'accès au JSON et renvoie un compteur.
- `?action=list` — renvoie le JSON parsé et trié.
- `?action=pingPrinter&ip=…` — ping ICMP d'une imprimante (1 paquet, timeout 1s).
