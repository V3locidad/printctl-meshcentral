# Historique

## 0.0.31

- Corrige les sauts de l’interface pendant les actualisations automatiques et manuelles : les résultats réseau sont appliqués ensemble, sans reconstruire le tableau à chaque réponse.
- Conserve les éléments inchangés et les positions de défilement de la page, du tableau et des travaux.
- Garde la file ouverte visible pendant sa relecture. En cas d’erreur, les derniers travaux connus restent affichés avec un message explicite et la purge désactivée.
- Stabilise la largeur du bouton Rafraîchir et ajoute 4 tests de non-régression (28 au total).

## 0.0.30

- Refonte visuelle : tableau aéré, recherche, filtre par serveur et compteurs cliquables (toutes, prêtes, à surveiller, état inconnu).
- Met en avant l’état Windows et conserve les indications réseau et SNMP avec leur source.
- Ajoute un panneau de détail et de travaux pour l’imprimante sélectionnée, adapté aux petits écrans.
- Distingue les files vides des erreurs de lecture et ignore les réponses tardives après un changement de sélection.
- Conserve la confirmation avant purge, verrouille la cible pendant la suppression et relit la file après un succès partiel ou un échec.
- Ajoute 7 tests ; 24 tests au total, sans accès au parc réel.

## 0.0.29

- Affiche l’état des files Windows au lieu de déduire « hors ligne » d’un ping échoué.
- Vérifie les ports TCP en complément du ping et distingue un accès non confirmé.
- Corrige le décodage SNMP : format hexadécimal strict, recherche de l’index du périphérique et absence de fausses alertes à partir des messages d’erreur.
- Affiche séparément les états Windows, réseau et SNMP ; conserve le pilote comme repli pour le modèle.
- Actualise aussi l’inventaire Windows toutes les 30 secondes et évite les actualisations simultanées.
- Ajoute 17 tests de non-régression sans accès au parc réel.
