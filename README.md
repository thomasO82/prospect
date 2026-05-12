# Enrichissement Excel via Google Maps

Ce projet lit un fichier Excel, repere les lignes dont la colonne telephone est vide, cherche un numero via Google Maps, puis ecrit le resultat dans un nouveau fichier sans ecraser les numeros existants.

La couche Excel utilise `xlsx` (SheetJS), ce qui s'est montre plus robuste que `exceljs` sur votre classeur source.

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
COLUMN_STATUS="statut"
MISSING_PHONE_VALUES="Non trouvé publiquement"

ROW_SKIP_REGEX="^\\s*[-–—]{2,}"
HEADLESS=false
DELAY_MIN_MS=2500
DELAY_MAX_MS=5000
NAVIGATION_TIMEOUT_MS=30000
SEARCH_SETTLE_MS=4000
MAX_AMBIGUOUS_RESULTS=5
```

## Colonnes de votre fichier

Le script est deja preconfigure pour votre feuille telle qu'elle apparait actuellement :

- `Entreprise`
- `Adresse`
- `Téléphone`
- `Source / vérification téléphone-contact`

La colonne `statut` sera creee automatiquement si elle n'existe pas.

Pour adapter les noms de colonnes :

1. Changez les variables `COLUMN_COMPANY`, `COLUMN_ADDRESS`, `COLUMN_PHONE`, `COLUMN_SOURCE`, `COLUMN_STATUS` dans `.env`.
2. Si la ligne d'en-tete n'est pas la premiere, changez `HEADER_ROW_INDEX`.
3. Si votre fichier utilise d'autres libelles d'absence que `Non trouvé publiquement`, ajoutez-les dans `MISSING_PHONE_VALUES` en les separant par `|`.
4. Si vous avez des lignes separatrices comme `--- GÉMENOS ---`, gardez ou adaptez `ROW_SKIP_REGEX`.

## Regles metier prises en charge

- Le script ne touche qu'aux lignes dont le telephone est vide ou contient une valeur d'absence comme `Non trouvé publiquement`.
- Un numero existant n'est jamais ecrase.
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
- `xlsx` reecrit le fichier; la mise en forme complexe peut etre legerement modifiee selon le classeur source.

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
