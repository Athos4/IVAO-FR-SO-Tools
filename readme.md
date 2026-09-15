# IVAO France — Planning des zones spéciales

Page web autonome permettant de consulter les créneaux hebdomadaires des zones spéciales françaises présentes dans la base IVAO.

## Utilisation

Ouvrir simplement `index.html` dans un navigateur moderne. La page interroge l’API publique IVAO par FIR française et bascule sur un échantillon local clairement signalé si le réseau est indisponible.

- CSS et JavaScript entièrement inline ;
- aucune dépendance ni étape de compilation ;
- horaires affichés en UTC ;
- filtres par zone, type et région ;
- planning horizontal continu sur sept jours avec blocs proportionnels aux horaires ;
- vue détaillée des limites verticales et conditions d’activation ;
- carte sombre OpenStreetMap/CARTO avec sélection et superposition de plusieurs tracés IVAO.

## Modifications dans le planning

Un clic sur une zone ou un bloc horaire ouvre son détail. Un double-clic ouvre sa page de modification sur IVAO dans un nouvel onglet. Le détail propose également le lien « Modifier la zone sur IVAO ».

Après un chargement réussi, les horaires sont comparés au chargement précédent (conservé dans le cache local entre deux visites). Les nouveaux horaires sont entourés de cyan ; les horaires supprimés restent affichés avec des hachures. Un horaire déplacé affiche donc l'ancien créneau hachuré et le nouveau en cyan, sur des lignes distinctes s'ils se chevauchent. Les blocs supprimés ne sont pas considérés comme actifs. Les marqueurs sont recalculés à chaque chargement réussi ; le premier chargement sans historique n'en affiche aucun.

Tests : `node --test tests/planning-changes.test.mjs`.

## Airways et espaces inférieur / supérieur

Le bouton de bascule sur la carte et dans la fiche de zone sélectionne l’espace affiché :

- inférieur : réseau `fr.lawy` (278 airways, 1 050 segments), avec un plancher fixé au FL65 pour le contrôle des conflits ;
- supérieur : réseau `fr.hawy` (204 airways, 567 segments).

La séparation est fixée à FL195 : une zone dont le plafond est FL195 appartient à l’inférieur, une zone dont le plancher est FL195 appartient au supérieur. Une zone traversant ce niveau apparaît dans les deux espaces. La sélection est conservée au changement d’espace. À l’ouverture d’une fiche, l’espace est adapté si nécessaire pour afficher la zone.

Les airways sans conflit sont gris foncé, dans une teinte proche des FRA, avec une opacité de 30 %. Toute route conflictuelle est rouge, AWY comme FRA. Le contrôle automatique colore le tronçon AWY complet lorsqu’un de ses segments intersecte une zone sélectionnée et donne les noms AWY dans un panneau dédié. Les ruptures `BREAK` des fichiers sont conservées : aucun segment ne relie deux tronçons séparés. Le contrôle détecte les traversées, les segments contenus et les contacts avec les limites.

En inférieur, une zone dont le plafond est inférieur ou égal à 6 500 ft (FL65) reste visible mais ne génère aucun conflit AWY. Le volume de la zone doit dépasser FL65 et commencer sous FL195 pour être testé contre les `lawy`.

Les conflits AWY sont potentiels : les fichiers fournis contiennent uniquement des tracés, sans limites verticales par segment ni disponibilités horaires. Le test combine donc l’intersection latérale avec la présence de la zone dans la tranche choisie, sans prédire un conflit avec un vol réel.

Les trajectoires FRA AIRAC 2609 sont automatiquement affichées sur la carte principale et dans la fiche de zone, sans bouton d’activation. En supérieur, tout le tracé disponible est affiché, y compris les portions inférieures et les routes entièrement inférieures, quel que soit le point d’entrée FRA. En inférieur, seules les portions de la tranche choisie sont normalement dessinées ; lorsque le premier point publié diffère de l’entrée FRA (`E`), le tracé complet reste affiché. Les portions hors tranche sont du contexte visuel : leurs altitudes et les tests de conflit restent inchangés. Les portions DCT et les airways commençant par `U` (ex. `UT300`) ont un plafond de croisière **FL350** ; les portions sur une airway sans préfixe `U` (ex. `V21`, `G36`) ont un plafond **FL190**. Les phases de montée ou descente peuvent donc faire passer une portion DCT/U en inférieur. Leur couleur normale est identique à celle des AWY : gris foncé à 30 % d’opacité. Les filtres H24/nuit, militaires et aéroport restent applicables dans les deux espaces, ainsi que l’isolation d’une boîte sélectionnée. Les données AWY et FRA sont embarquées dans `index.html` ; les fichiers d’origine ne sont pas requis pour ouvrir la page.

En inférieur avec un filtre ICAO, le contrôle des airways autonomes est limité à l’emprise horizontale des volumes ATC inférieurs portant les ICAO sélectionnés, augmentée de **50 NM (92 600 m)** depuis leur contour. Les distances au contour sont sphériques ; ce n’est pas un rayon autour de l’aérodrome ni une boîte englobante. Seule la portion d’airway intersectant effectivement la zone est comparée à ce périmètre : une proximité ailleurs sur le même segment ne suffit pas. Le plancher FL65 demeure applicable, sans relever ou abaisser les limites des espaces ATC dessinés. Les codes multiples utilisent l’union de leurs périmètres. Un ICAO sans volume correspondant est signalé et ne déclenche pas de contrôle AWY local. Sans filtre ICAO, le contrôle général est conservé ; le contrôle AWY supérieur est inchangé. Les connexions point–aéroport restent exclues des conflits.

Les portions FRA hors tranche ne modifient que l’affichage : une route entièrement inférieure n’est pas proposée comme alternative supérieure vérifiée. Les profils par segment et les conflits/recherches inverses FRA conservent leur calcul dans la tranche sélectionnée.

Le profil vertical FRA utilise une référence d’aérodrome **0 ft** (hypothèse demandée), une pente de **montée 9 %** et de **descente 5 %** : hauteur en pieds = distance horizontale en mètres × pente / 0,3048. La distance est cumulée le long de chaque segment du tracé, avec les liaisons directes aéroport–premier point et dernier point–aéroport. Les plafonds FL190/FL350 sont propagés vers l’amont et l’aval pour obtenir des transitions continues, sans saut d’altitude entre deux portions. Un trajet court peut ne jamais atteindre son plafond de croisière. Un survol sans départ/arrivée explicites ne reçoit pas d’aérodrome inventé ; la condition « overflights or DEP … » conserve aussi ce scénario tant qu’un départ précis n’est pas sélectionné.

Le conflit FRA exige une intersection latérale avec la zone et une altitude compatible **sur la seule portion traversant cette zone**. Les points de changement montée/palier/descente sont pris en compte, y compris un sommet de profil à l’intérieur d’un segment. Le résultat alimente conflits, alternatives, recherche inverse et impact par aérodrome. Les scénarios multi-aérodromes restent distincts ; le filtre ICAO choisit les départs/arrivées concernés. Le passage inférieur/supérieur se fait à FL195 d’après le profil, sans changer artificiellement l’altitude du vol lorsqu’on bascule la vue. Les raccordements point–aéroport servent à mesurer les distances mais restent exclus des tests de collision. Les airways autonomes conservent leur contrôle volumique FL65–FL195 et leur périmètre ICAO + 50 NM : sans association DEP/ARR, aucun profil de vol individuel ne leur est inventé.

Ce profil est un modèle géométrique indicatif pour la simulation, pas une SID/STAR ni une garantie de performances. Les altitudes réelles des aérodromes, le relief, la pression, les performances avion et les autres contraintes publiées ne sont pas résolus par ces hypothèses.

Les segments sont associés au texte source complet, jamais au texte simplifié d’affichage. Lorsque le nombre de points diffère, les points nommés des bases de navigation servent à retrouver les portions correspondantes. Une portion mixte non résolue est signalée comme altitude non vérifiée et conservée comme conflit potentiel ; un tel itinéraire n’est pas proposé comme alternative vérifiée. Les associations de conflit publiées dans le JS ne remplacent pas ce contrôle vertical lorsque le polygone est disponible ; sans polygone, elles restent des conflits potentiels signalés comme incomplets.

## Routes FRA H24 / nuit et alternatives

Une séparation `/` avant un connecteur crée deux branches issues du préfixe commun : `GAI G39 KORAB / G39 AFRIC` donne `GAI G39 KORAB` et `GAI G39 AFRIC`, sans segment artificiel KORAB–AFRIC. La forme attachée `KORAB/ G39` est également reconnue ; les suffixes de niveau/vitesse comme `KORAB/F190` ou `KORAB/N0450F190` restent intacts. Chaque branche résolue possède son propre tracé, profil vertical, contrôle de conflit et raccordements aérodromes ; elle est identifiée par « Branche 1/2 », etc., dans le panneau. Les disponibilités et conditions de la route source sont conservées. Les filtres et la sélection d’une boîte s’appliquent aux branches comme aux autres itinéraires.

Les branches sont reconstruites en mémoire à l’ouverture, à partir des points nommés. Les points propres au JS peuvent aussi être récupérés dans ses tracés lorsque le nombre de points et au moins deux points connus confirment leur correspondance. Aucune coordonnée ambiguë n’est choisie arbitrairement : les points manquants sont signalés dans les fiches et dans le panneau de contrôle incomplet. Les branches résolues restent affichées ; si aucune branche n’est résolue, le tracé source partiel reste signalé comme non vérifié et ne sert pas à inventer des raccordements ou une alternative certifiée. Les données source embarquées et les fichiers d’origine restent inchangés.

Le bouton « FRA : H24 / Nuit + H24 » s’appuie sur les disponibilités `time_availability`, les types `NIGHT` et les calques nocturnes du fichier AIRAC 2609. H24 affiche les routes explicitement marquées H24 ; Nuit ajoute les routes mentionnant la nuit ou des plages nocturnes. Les horaires non classifiables (restrictions seules, week-end seul, disponibilités vides…) sont exclus de ces deux catégories. Il s’agit d’un filtre de catégorie horaire, pas d’une validation de toutes les conditions publiées.

Les alternatives vertes partagent les mêmes entrée→sortie ou une paire d’aérodromes DEP → ARR commune, dans le même sens. Une alternative FRA peut donc avoir des points d’entrée et de sortie différents si les deux routes précisent au moins un même départ ET une même arrivée. Un rôle absent n’est pas un joker : sans paire DEP → ARR complète, les mêmes entrée/sortie restent exigées. Pour la correspondance par points FRA, les champs `E` et `X` sont utilisés ; pour les AWY, les extrémités géographiques de chaque tronçon continu sont utilisées. Des routes AWY/FRA peuvent aussi correspondre si leurs extrémités coïncident. La recherche privilégie les routes existantes dans la tranche et le filtre horaire affichés. Si la route conflictuelle précise des aérodromes positifs DEP ou ARR, une alternative doit partager au moins un aérodrome pour chacun de ces rôles ; un DEP ne remplace jamais un ARR. Si les deux rôles sont présents, les deux doivent correspondre. Le filtre aérodrome impose les codes sélectionnés lorsqu’ils figurent parmi les choix du rôle concerné. Cette compatibilité est vérifiée séparément pour chaque boîte, même entre routes de mêmes entrée/sortie. Les mentions négatives ne prouvent aucune desserte et une AWY sans association aéroport ne remplace pas une FRA soumise à cette contrainte. Les abréviations telles que LFOA/LN sont développées avant comparaison. Cela ne réactive pas les contrôles de conflit sur les connexions point–aéroport.

Si une AWY conflictuelle n’a aucune alternative existante, un plus court chemin est recherché dans le réseau AWY de la tranche affichée (Dijkstra, distances sphériques). Les segments en conflit avec une des zones sélectionnées sont exclus ; les portions non conflictuelles d’une même airway restent utilisables. Les raccordements se font uniquement aux sommets de coordonnées identiques : aucun raccordement artificiel aux croisements ni entre deux parties séparées par `BREAK`. Le départ et l’arrivée, coordonnées et noms de source, sont conservés. Le détour calculé apparaît dans la même boîte, en vert avec l’épaisseur AWY normale ; son itinéraire donne tous les points et l’airway de chaque segment. La sélection de la boîte l’isole avec sa route conflictuelle et affiche ses points. Sans chemin disponible, aucune alternative n’est inventée.

Dans le texte affiché des itinéraires, les segments consécutifs empruntant la même airway sont regroupés : `GAI V21 TOBVO V21 TAKAT` devient `GAI V21 TAKAT`. Les changements d’airway, portions DCT et contraintes associées aux points sont préservés. Cette simplification concerne uniquement l’affichage : les itinéraires sources, géométries, points sur la carte en sélection et calculs de conflits restent complets.

Les fichiers ne donnant ni sens autorisés, ni disponibilités, ni niveaux par segment, le graphe est supposé bidirectionnel. Les propositions portent la mention « Calcul géométrique sur AWY · sens, niveaux et disponibilités non validés ». Elles ne constituent pas des routes opérationnellement validées. Aucun détour AWY n’est calculé lorsque le filtre aéroport ou la recherche inverse exclut les AWY des listes d’itinéraires, même si le réseau inférieur reste visible en fond de carte.

Une alternative doit éviter toutes les zones sélectionnées dans sa tranche d’altitude. Les intersections FRA publiées sont complétées par un contrôle géométrique des polygones IVAO. Les alternatives sont recalculées lorsqu’on ajoute ou retire une zone ou change de filtre ; une géométrie de zone manquante empêche de présenter des alternatives non vérifiées. Le panneau liste les alternatives, avec les disponibilités FRA d’origine au survol. Les conflits sont dessinés en dernier pour conserver le rouge sur les portions communes.

## Liste des itinéraires et RTBA

Sur les deux cartes, aucun nom ni symbole de point d’itinéraire n’est affiché hors sélection ; les marqueurs ICAO des aérodromes impactés restent visibles. Lorsqu’une boîte est isolée, tous les points de ses tracés visibles sont affichés, y compris ceux des portions inférieures en mode supérieur et ceux des portions hors tranche lorsqu’un itinéraire commence avant son entrée FRA, avec les couleurs des conflits et alternatives. Les points partagés sont dédoublonnés. Les noms AWY sont conservés directement depuis les nouveaux fichiers et leurs coordonnées résolues dans `fr.fix`, `fr.ndb` et `fr.vor` (3 830 points embarqués). Cette base enrichit aussi la recherche de noms par coordonnées pour les FRA ; `point_all` et `airport` du JS restent disponibles en complément. Faute de nom, les coordonnées sont affichées. Seuls les points du tracé géométrique disponible peuvent être positionnés, pas les portions externes présentes uniquement dans le texte de l’itinéraire.

Les conflits et alternatives sont listés dans un panneau à gauche de la carte, séparé de la liste des zones. Les itinéraires conflictuels partageant les mêmes entrée/sortie, dans le même sens, sont regroupés dans une section repliée par défaut. Le bouton « Afficher les détails / Masquer les détails » dévoile les variantes et leurs conditions ; son état est conservé lors du rafraîchissement des panneaux et partagé entre les deux cartes. Chaque variante conserve sa propre boîte et ses alternatives compatibles (mêmes entrée/sortie ou même paire DEP → ARR). Le regroupement ne fusionne pas les calculs, les conditions ni les tracés. Un clic sur une variante conflictuelle ou alternative l’affiche seule sur la carte, avec ses points et raccordements ; un second clic sur cette même variante rétablit l’affichage normal. Le bouton « Voir conflit + alternatives » permet de comparer toute sa boîte comme auparavant. Les conflits restent rouges et les alternatives vertes, avec leur épaisseur habituelle. Les variantes partageant une géométrie mais ayant des conditions différentes restent sélectionnables individuellement. Les zones et le fond de carte restent visibles. Chaque FRA affiche son itinéraire publié complet ; les AWY affichent les noms des points ou leurs coordonnées si le nom manque. Le bouton « Afficher le groupe sur la carte », accessible même avec les détails repliés, affiche ensemble tous les conflits du groupe entrée/sortie et leurs alternatives compatibles. Les alternatives communes sont dédoublonnées, les autres groupes sont masqués et les points/raccordements de tous les itinéraires retenus sont affichés. Un second clic sur le groupe rétablit toutes les routes. Il reste possible de passer directement à une boîte ou à une variante individuelle. Cette sélection est disponible sur la carte principale et dans la fiche de zone.

Les conditions `ADEP or ADES`, `utilisation` et `vertical_constraint` sont affichées intégralement sous les itinéraires FRA. Les variantes ayant des conditions différentes restent distinctes. Ces conditions sont informatives : elles ne sont pas évaluées contre un plan de vol. Les mentions explicites de type de vol M, dont `FLT-TYPE(M,X)`, identifient les routes militaires. Elles sont masquées par défaut, y compris dans les listes de conflits et d’alternatives. Le bouton « Afficher / Masquer routes militaires », sur la carte et dans la fiche de zone en supérieur, les affiche en vert sombre (#238653). Les conflits restent rouges et les alternatives vertes, même dans une boîte sélectionnée. Les filtres d’espace et H24/nuit restent applicables. Un tracé partagé avec une variante civile peut rester visible au titre de cette variante.

Le champ « Aérodromes » accepte un ou plusieurs codes OACI à quatre lettres séparés par des virgules, espaces ou points-virgules, par exemple `LFPG, LFPO`. Valider en quittant le champ ; vider le champ pour rétablir les routes. La casse est normalisée et les doublons supprimés. Les itinéraires retenus mentionnent au moins un de ces aérodromes dans leurs conditions publiées. Ce filtre exclut les mentions ARR/DEP interdites par « not available for traffic » et ne valide pas toutes les restrictions d’un vol. Dans les conditions FRA, les suffixes abrégés sont développés : `LFOA/LN` signifie `LFOA, LFLN` et `LFOA/LN/BO` signifie `LFOA, LFLN, LFBO`. Cette interprétation s’applique au texte affiché, aux filtres, aux raccordements et aux calculs de conflits/recherche inverse, sans modifier les séparateurs de branches des itinéraires. Les groupes d’aéroports restent non développés.

Le réseau AWY inférieur reste visible malgré un filtre aérodrome ou la recherche inverse, en gris avec les conflits en rouge. Les AWY sans association aérodrome ne sont toutefois pas ajoutées aux listes filtrées et ne créent pas de résultats ICAO en recherche inverse. En supérieur, ces filtres continuent de masquer les AWY autonomes. L’isolation d’une boîte d’itinéraires masque toujours les autres routes, y compris le réseau AWY de fond.

### Recherche inverse et impact aérodromes

En mode carte, activer « Recherche inverse » puis saisir les codes ICAO. La carte affiche les zones ayant au moins un conflit avec les trajectoires FRA filtrées **ou** avec un volume ATC associé à l’un des codes saisis. Les nombres de trajectoires et de volumes ATC sont distingués pour chaque zone. Les filtres de zones, H24/nuit et militaires sont conservés pour les routes ; ils ne désactivent pas les espaces ATC. L’activation du mode démarre en supérieur, mais le bouton d’espace permet aussi de rechercher les conflits ATC en inférieur. Sans code, aucun résultat n’est affiché. Les zones sans géométrie sont signalées comme contrôle incomplet ; seules les intersections FRA déjà publiées dans le JS restent utilisables pour ces zones. Les conflits sont potentiels, sans validation des horaires d’activation de chaque zone contre un vol.

Un clic sur une zone de la liste inverse ouvre sa fiche. La liste textuelle des aérodromes impactés est remplacée par des marqueurs ICAO sur les deux cartes, avec le nom et le rôle ARR/DEP au survol. Les coordonnées sont embarquées explicitement depuis le calque `airport` du JS. Les aérodromes associés aux itinéraires conflictuels et à leurs alternatives sont reliés par des pointillés fléchés : aéroport DEP → premier point du tracé disponible, dernier point du tracé → aéroport ARR. Les liens reprennent la couleur de leur itinéraire : rouge pour les conflits, vert pour les alternatives, à l’épaisseur FRA habituelle ; le rouge prime sur les liens partagés. Un aérodrome impacté uniquement via un espace ATC reçoit un marqueur rose sans liaison inventée. Le cadrage inclut les marqueurs et les extrémités reliées. Une boîte isolée ne montre que ses liaisons et aérodromes.

Les raccordements sont des liaisons directes indicatives, **pas des SID/STAR**. Ils sont uniquement visuels et exclus de tous les contrôles de conflit, en inférieur comme en supérieur : une zone coupant seulement un segment point–aéroport ne rend pas l’itinéraire conflictuel, ne produit aucun résultat en recherche inverse et n’exclut pas une alternative. Les contrôles sur les portions FRA/AWY et sur les espaces ATC restent actifs. Les disponibilités H24/nuit et le filtre militaire s’appliquent également à l’affichage des raccordements.

Les conditions `overflight or DEP … with ARR …` et `overflights or DEP … with ARR …` relient les deux extrémités : chaque départ explicite rejoint le premier point, et chaque arrivée explicite est reliée au dernier point de chaque branche. « Overflight » n’annule pas les départs indiqués. Les listes entre crochets, les codes séparés par des virgules et les mentions ARR/DEP répétées sont pris en charge. Si la source ne répartit pas les aérodromes entre branches, les associations positives restent des possibilités pour chaque branche, sans inventer une affectation exclusive.

Le bouton « Connexions : ON/OFF », présent sur les deux cartes, masque ou affiche uniquement les segments point–aéroport et leurs flèches. Les marqueurs d’aérodromes, les itinéraires et tous les calculs de conflits restent actifs. Le réglage est partagé entre les cartes et conservé au changement d’espace ou de filtre ; le bouton ne recentre pas la carte. Les connexions sont visibles par défaut.

Seules les mentions positives explicites ARR/DEP du champ d’aérodromes créent des raccordements ; les clauses négatives, identifiants FIR et groupes ne sont pas transformés en destinations. Un filtre d’aéroport conserve son raccordement ainsi que les raccordements de rôle opposé du même itinéraire (par exemple les départs possibles d’une route vers l’arrivée filtrée), mais pas les autres choix d’arrivée. Les associations ambiguës et coordonnées manquantes sont signalées dans un résumé, sans inventer de position ni de liaison. Si les coordonnées d’un aérodrome requis sont absentes, le profil de montée/descente est non vérifié : les conflits restent potentiels entre 0 ft et le plafond calculable, mais aucune alternative vérifiée n’est proposée. Aucune coordonnée n’est inventée. Les restrictions complexes ne sont pas validées opérationnellement et les AWY seules n’ont pas d’association aérodrome dans les données fournies.

Quitter le mode inverse rétablit la sélection manuelle précédente des zones, sans effacer le filtre d’aérodromes.

Les zones R 589 à R 593 (y compris leurs subdivisions nommées), ainsi que celles dont la description contient « Low flying high speed training » (sans distinction de casse ou d’espacement) sont identifiées comme RTBA et colorées en turquoise sur le planning et les cartes. Elles sont masquées par défaut uniquement dans le planning ; le bouton « Afficher RTBA / Masquer RTBA » permet de les inclure. Elles restent disponibles en mode carte.

Lorsqu’un ICAO sélectionné apparaît comme ARR ou DEP dans une clause « not available for traffic », la variante d’itinéraire concernée est ignorée pour cette recherche : affichage, conflits, alternatives et recherche inverse FRA. La restriction est recherchée dans les champs aérodromes, utilisation et limites verticales, avec prise en charge des listes numérotées, retours à la ligne, abréviations comme LFOA/LN et exceptions explicites de même rôle. Une restriction portant sur un des codes sélectionnés prime sur une autre mention positive. Les aérodromes ainsi interdits ne sont pas présentés comme desservis ou impactés par cette route. L’itinéraire reste disponible sans filtre ou pour d’autres aérodromes autorisés ; ses données source ne sont pas supprimées. Les groupes, jokers et restrictions complexes ne sont pas développés ni validés opérationnellement.

## Espaces ATC X-Plane

En recherche inverse, les espaces ATC affichés sur les deux cartes sont limités aux ICAO sélectionnés dans le filtre aérodrome. Les contours, remplissages, étiquettes, liste des volumes et compteur appliquent tous cette restriction. Plusieurs codes affichent l’union de leurs espaces ; sans code correspondant, aucun espace n’est affiché. Le repli sur `FACILITY_ID` reste possible uniquement pour un contrôleur sans ICAO, comme dans la recherche inverse. Quitter ce mode rétablit tous les espaces impactés. Ce filtre d’affichage ne modifie pas les calculs de conflit.

La base `atc.dat` embarquée est filtrée à l’import sur `FACILITY_ID` : seuls les préfixes `LF`, `NT`, `TF` et `FM` sont conservés ; les identifiants FIR `LFFF`, `LFEE`, `LFBB`, `LFRR` et `LFMM` sont exclus. Elle contient 128 contrôleurs, 615 volumes et 14 141 points, contre 3 981 contrôleurs, 8 981 volumes et 335 605 points dans la source mondiale. Les espaces exclus ne participent ni à l’affichage ni à la recherche inverse. Le fichier source reste intact et permet de régénérer la base.

Les limites verticales sont interprétées en pieds AMSL, conformément au [format officiel X-Plane](https://developer.x-plane.com/article/atc-dat/). Chaque volume retenu est conservé séparément, sans simplification des polygones ; les coordonnées sont compactées sans perte à la précision de six décimales de la source.

Un conflit ATC nécessite une intersection latérale des polygones (inclusion et contact compris) et un recouvrement vertical strict dans la tranche affichée, séparée au FL195. Un simple contact entre plancher et plafond ne suffit pas. Le plancher FL65 des AWY inférieures ne s’applique pas aux espaces ATC. Les polygones traversant l’antiméridien sont traités sans leur faire couvrir artificiellement le reste du monde.

Les volumes impactés par les zones affichées sont dessinés sur les deux cartes en rose `#ff69cf`, avec un contour à `0.5` et un remplissage à `0.1` d’opacité. Une étiquette rose affiche uniquement l’ICAO (ou le `FACILITY_ID` si l’ICAO est absent), par exemple `LFBO`, sans type d’espace. Sous ce nom figurent le plafond puis le plancher : pieds jusqu’à 5 000 ft, FL au-delà, `SFC` pour 0 et `UNL` pour 66 000 ou 99 999. Ces étiquettes restent réservées aux cartes. Le panneau « Espaces ATC impactés » indique le contrôleur sans son type et les limites de chaque volume. En recherche inverse, la correspondance utilise `ICAO`, ou `FACILITY_ID` pour un contrôleur sans association ICAO. Un identifiant de centre n’est pas présenté comme un aérodrome dans la liste d’impact.

## Maintenance

Pour régénérer les espaces ATC (lecture seule du fichier source, remplacement des seules données inline) :

```sh
node tools/import-atc.mjs "chemin/atc.dat" index.html --write
```

L’empreinte SHA-256 de la source est conservée. Pour les éditeurs limitant la taille des fichiers, `--placeholder --write` peut temporairement remplacer les seules données ATC par une liste vide ; il faut impérativement relancer sans `--placeholder` pour rétablir la base complète avant utilisation.

`tools/import-airways.mjs` lit les fichiers texte sans les exécuter, valide les coordonnées DMS et résout les références nommées grâce aux fichiers FIX/NDB/VOR. Les références inconnues ou ambiguës provoquent une erreur avant toute écriture. Les ruptures `BREAK` sont conservées. Les cinq fichiers conservent leur empreinte SHA-256 dans les données embarquées. Sans `--write`, l’outil produit un patch ; avec cette option, il régénère uniquement les données inline :

```sh
node tools/import-airways.mjs chemin/fr.lawy chemin/fr.hawy index.html chemin/fr.fix chemin/fr.ndb chemin/fr.vor --write
```

Tests du parseur, des ruptures, du seuil FL195 et des intersections géométriques :

```sh
node --test
```

`tools/import-fra-metadata.mjs` produit le patch des disponibilités, paires entrée/sortie et itinéraires complets à partir de `2609_visu_public.js` (lecture JSON, sans exécution du fichier). L’option `--write` remplace directement les seules métadonnées inline :

```sh
node tools/import-fra-metadata.mjs chemin/2609_visu_public.js index.html --write
```

> Réservé à la simulation IVAO. Ne pas utiliser pour la navigation réelle.
