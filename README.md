# Enrichissement Excel via Google Maps

Ce projet lit un fichier Excel, repere les lignes a enrichir, cherche un numero via Google Maps, puis utilise le site officiel detecte pour trouver un email quand c'est possible.

La strategie par defaut est volontairement simple et rapide :

1. Google Maps reste la source pour le telephone et le site officiel.
2. La recherche email se limite au domaine officiel detecte.
3. Le robot visite seulement quelques pages prioritaires : accueil, contact, nous-contacter, mentions legales.
4. Des qu'un email officiel est trouve, la recherche contact s'arrete pour cette entreprise.
5. Bing, Hunter et les PDFs sont desactives par defaut car ils ralentissent beaucoup et peuvent bloquer.

La couche Excel utilise `exceljs` afin de modifier une copie du classeur en conservant la mise en forme existante autant que possible.

## Structure

```text
.
├── .env.example
├── .gitignore
├── package.json
├── README.md
├── tsconfig.json
└── src
    ├── config.ts
    ├── excel.ts
    ├── index.ts
    ├── maps.ts
    ├── types.ts
    └── utils.ts
```

## Installation

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

## Lancement

Le plus simple est d'utiliser le fichier `.env`, puis :

```bash
npm run dev -- --input "/Users/jodierabattu/Downloads/Prospection_Gemenos_Aubagne_LaCiotat_recherche_refaite.xlsx"
```

Ou en buildant d'abord :

```bash
npm run build
npm run start -- --input "/Users/jodierabattu/Downloads/Prospection_Gemenos_Aubagne_LaCiotat_recherche_refaite.xlsx"
```

## Configuration

Exemple de variables utiles :

```env
INPUT_XLSX="/Users/jodierabattu/Downloads/Prospection_Gemenos_Aubagne_LaCiotat_recherche_refaite.xlsx"
OUTPUT_XLSX="/Users/jodierabattu/Downloads/Prospection_Gemenos_Aubagne_LaCiotat_recherche_refaite_enrichi.xlsx"
SHEET_NAME=""
HEADER_ROW_INDEX=1

COLUMN_COMPANY="Entreprise"
COLUMN_ADDRESS="Adresse"
COLUMN_PHONE="Téléphone"
COLUMN_SOURCE="Source / vérification téléphone-contact"
COLUMN_WEBSITE_URL="websiteUrl"
COLUMN_EMAIL="email"
COLUMN_CONTACT_NAME="nomContact"
COLUMN_CONFIDENCE="confidence"
COLUMN_SOURCE_URL="sourceUrl"
COLUMN_SCRAPING_STATUS="scrapingStatus"
COLUMN_LAST_CHECKED_AT="lastCheckedAt"
COLUMN_STATUS="statut"
MISSING_PHONE_VALUES="Non trouvé publiquement"

ROW_SKIP_REGEX="^\\s*[-–—]{2,}"
HEADLESS=false
DELAY_MIN_MS=1000
DELAY_MAX_MS=2500
NAVIGATION_TIMEOUT_MS=30000
SEARCH_SETTLE_MS=4000
BROWSER_CLOSE_DELAY_MS=0
MAX_AMBIGUOUS_RESULTS=5
MAX_ROWS_TO_PROCESS=
PROCESS_ALL_ROWS=true
FORCE_UPDATE=false
USE_BING_SEARCH=false
USE_HUNTER=false
HUNTER_API_KEY=""
HUNTER_MAX_EMAILS=10
HUNTER_TIMEOUT_MS=15000
BATCH_SIZE=50
PAUSE_BETWEEN_BATCHES_MS=0
SAVE_EVERY_ROWS=5
MAX_PAGES_PER_COMPANY=4
MAX_BING_RESULTS=2
MAX_PDF_PER_COMPANY=0
SEARCH_DELAY_MS=0
CONTACT_TIMEOUT_MS=4000
USE_AI=false
SLOW_MODE=false
```

Pour tester uniquement les 20 premieres lignes a enrichir :

```bash
npm run test:20
```

Pour garder les fenetres Playwright ouvertes en fin de traitement et lire une erreur visuelle :

```env
BROWSER_CLOSE_DELAY_MS=60000
```

## Colonnes de votre fichier

Le script est deja preconfigure pour votre feuille telle qu'elle apparait actuellement :

- `Entreprise`
- `Adresse`
- `Téléphone`
- `Source / vérification téléphone-contact`

Le script ajoute aussi les colonnes :

- `email`
- `nomContact`
- `confidence`
- `sourceUrl`
- `scrapingStatus`
- `websiteUrl`
- `lastCheckedAt`

Les colonnes `websiteUrl`, `email`, `nomContact`, `confidence`, `sourceUrl`, `scrapingStatus`, `lastCheckedAt` et `statut` seront creees automatiquement si elles n'existent pas.

Pour adapter les noms de colonnes :

1. Changez les variables `COLUMN_COMPANY`, `COLUMN_ADDRESS`, `COLUMN_PHONE`, `COLUMN_WEBSITE_URL`, `COLUMN_EMAIL`, `COLUMN_CONTACT_NAME`, `COLUMN_SOURCE`, `COLUMN_STATUS` dans `.env`.
2. Si la ligne d'en-tete n'est pas la premiere, changez `HEADER_ROW_INDEX`.
3. Si votre fichier utilise d'autres libelles d'absence que `Non trouvé publiquement`, ajoutez-les dans `MISSING_PHONE_VALUES` en les separant par `|`.
4. Si vous avez des lignes separatrices comme `--- GÉMENOS ---`, gardez ou adaptez `ROW_SKIP_REGEX`.

## Regles metier prises en charge

- Le script ne touche qu'aux lignes dont le telephone est vide ou contient une valeur d'absence comme `Non trouvé publiquement`.
- Le script traite aussi les lignes dont l'email ou le nom de contact doit etre complete, mais la recherche du nom est opportuniste et ne ralentit pas le traitement.
- Avec `PROCESS_ALL_ROWS=true`, le robot passe sur toutes les entreprises, pas seulement celles dont le telephone manque.
- Google Maps n'est appele que si le telephone ou `websiteUrl` manque.
- Si `scrapingStatus=OK` et que les donnees principales sont deja presentes, la ligne est ignoree sauf `FORCE_UPDATE=true`.
- Le traitement sauvegarde regulierement via `SAVE_EVERY_ROWS`. La pause entre lots est desactivee par defaut avec `PAUSE_BETWEEN_BATCHES_MS=0`.
- Un numero existant n'est jamais ecrase.
- Un email ou un nom de contact existant n'est pas ecrase, sauf si `FORCE_UPDATE=true`.
- Le crawl contact est limite par `MAX_PAGES_PER_COMPANY` et s'arrete des qu'un email officiel est trouve.
- Les recherches textuelles Bing sont desactivees par defaut avec `USE_BING_SEARCH=false`.
- Hunter.io peut etre reactive en source optionnelle avec `USE_HUNTER=true` et `HUNTER_API_KEY`, mais ce n'est plus la strategie rapide.
- Les recherches Bing sont limitees par `MAX_BING_RESULTS`.
- Google Search HTML n'est pas utilise pour les recherches textuelles.
- Les PDFs sont desactives par defaut avec `MAX_PDF_PER_COMPANY=0`.
- Aucun email n'est genere ou devine : seules les adresses trouvees explicitement dans une source publique analysee sont retenues.
- Les captchas sont detectes et donnent le statut `CAPTCHA_DETECTED`; le script ne tente pas de les contourner.
- La colonne `source` est mise a jour avec l'URL ou la trace de la recherche.
- La colonne `statut` est renseignee avec `trouvé`, `introuvable`, `ambigu` ou `erreur`.
- Si Google Maps renvoie plusieurs fiches, le script ne choisit pas au hasard.
- En cas d'ambiguite, il stocke les candidats detectes dans `source`.
- Une pause aleatoire est ajoutee entre chaque recherche.

## Limites de l'approche Playwright

- Google Maps change regulierement son DOM : certains selecteurs peuvent casser.
- Le consentement cookies, les captchas ou le rate limiting peuvent interrompre le scraping.
- Une fiche peut exister sans numero visible publiquement.
- Certaines recherches ouvrent une liste de resultats proches mais pas strictement identiques, d'ou le statut `ambigu`.
- `exceljs` conserve les styles courants, largeurs, hauteurs et feuilles existantes, mais certains elements Excel avances peuvent etre reecrits differemment selon le classeur source.

## Alternative plus robuste : Google Places API

Si vous voulez quelque chose de plus stable en production :

1. Utiliser l'API `Text Search` ou `Find Place` de Google Places pour retrouver une fiche.
2. Recuperer ensuite `formatted_phone_number` via `Place Details`.
3. Conserver la logique Excel identique.

Avantages :

- Plus stable qu'un scraping navigateur.
- Reponses structurees.
- Moins sensible aux changements d'interface.
- Gestion plus propre des cas ambigus avec des identifiants de lieu.

Inconvenients :

- Cle API necessaire.
- Cout potentiel selon le volume.
- Respect des quotas et de la facturation Google.
