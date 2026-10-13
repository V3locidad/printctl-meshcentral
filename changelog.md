# Historique

## 0.0.29

- Affiche l’état des files Windows au lieu de déduire « hors ligne » d’un ping échoué.
- Vérifie les ports TCP en complément du ping et distingue un accès non confirmé.
- Corrige le décodage SNMP : format hexadécimal strict, recherche de l’index du périphérique et absence de fausses alertes à partir des messages d’erreur.
- Affiche séparément les états Windows, réseau et SNMP ; conserve le pilote comme repli pour le modèle.
- Actualise aussi l’inventaire Windows toutes les 30 secondes et évite les actualisations simultanées.
- Ajoute 17 tests de non-régression sans accès au parc réel.
