# Sky Trip

Préparer un voyage à vélo en France pour observer les étoiles, sur une seule carte :

- **Véloroutes & voies vertes** : EuroVelo, schéma national (V1, V2…) et itinéraires régionaux, avec la distinction voie verte / tronçon partagé.
- **Gares** : TER, TGV INOUI, OUIGO, Intercités (jour et nuit), Lyria/ICE, RER et Transilien, avec les règles pour embarquer son vélo.
- **Pollution lumineuse** : atlas 2025 de David J. Lorenz, lisible en tout point (magnitude/arcsec², visibilité de la Voie lactée).
- **Hébergements** : campings, hôtels, chambres d’hôtes, gîtes, auberges, refuges (OpenStreetMap), avec un lien Booking pré-rempli.
- **Itinéraire** : calcul vélo qui privilégie les véloroutes (BRouter), découpage en étapes selon votre rythme, et pour chaque nuit la qualité du ciel, la phase de la Lune et la fenêtre de nuit noire sans Lune. Export GPX et lien de partage.


### Mise en ligne sur GitHub Pages

Le workflow `.github/workflows/deploy.yml` construit et publie le site à chaque push sur `main`.

1. Créer le dépôt sur GitHub et pousser le code.
2. Dans le dépôt : **Settings → Pages → Source : GitHub Actions** (une seule fois).
3. Le site est publié sur `https://<utilisateur>.github.io/<dépôt>/` ; l’onglet **Actions** montre chaque déploiement.

Le sous-chemin (`/<dépôt>/`) est fourni au build par la variable `BASE_PATH`. Pour tester localement : `BASE_PATH=/sky-trip/ npm run build && npm run preview`.

Les données (gares, véloroutes) ne sont pas régénérées par le workflow : elles sont versionnées dans `public/`. Les rafraîchir avec `npm run data`, puis committer.

## Données

Les gares et les véloroutes sont pré-calculées dans `public/` (commitées, pour que le site marche sans étape de build des données). Pour les rafraîchir :


Tout le reste est interrogé en direct depuis le navigateur :

| Besoin | Service | Remarque |
| --- | --- | --- |
| Fond de carte | tile.openstreetmap.org, CyclOSM | |
| Calcul d’itinéraire | brouter.de | Serveur public gratuit ; auto-hébergeable (Docker) si besoin. La priorité « Maximale » aux véloroutes envoie une copie modifiée du profil (copies dans `src/route/profiles/`, brouter.de ne les servant pas aux navigateurs). |
| Recherche de lieux | photon.komoot.io | |
| Hébergements | Overpass API | Chargés par zone visible à partir du zoom 10. |
| Pollution lumineuse | djlorenz.github.io | Tuiles image + tuiles binaires pour la valeur exacte en un point. |

## Crédits

© contributeurs OpenStreetMap (ODbL) · SNCF Open Data (ODbL) · Atlas de la luminosité artificielle du ciel nocturne, D. J. Lorenz, d’après VIIRS / Earth Observation Group · BRouter · Photon (komoot) · CyclOSM · SunCalc · MapLibre GL JS.
