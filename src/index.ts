import { loadConfig } from './config';
import { ExcelPhoneWorkbook } from './excel';
import { GoogleMapsPhoneFinder } from './maps';
import { randomBetween } from './utils';

async function main(): Promise<void> {
  const config = loadConfig(process.argv.slice(2));
  const workbook = new ExcelPhoneWorkbook(config);
  const { pendingRows, totalDataRows, sheetName } = await workbook.load();
console.log("bla");

  console.log(`Feuille utilisee: ${sheetName}`);
  console.log(`Lignes de donnees detectees: ${totalDataRows}`);
  console.log(`Lignes avec telephone vide: ${pendingRows.length}`);
  console.log(`Fichier de sortie: ${config.outputPath}`);

  if (pendingRows.length === 0) {
    await workbook.save();
    console.log('Aucune ligne a enrichir. Une copie du fichier a tout de meme ete sauvegardee.');
    return;
  }

  const finder = new GoogleMapsPhoneFinder(config);
  await finder.init();

  try {
    for (let index = 0; index < pendingRows.length; index += 1) {
      const row = pendingRows[index];
      console.log(
        `[${index + 1}/${pendingRows.length}] ligne ${row.rowNumber} -> ${row.company}${
          row.address ? ` | ${row.address}` : ''
        }`,
      );

      const lookupResult = await finder.lookup(row);
      workbook.applyLookupResult(row, lookupResult);

      const suffix = lookupResult.phone ? ` | ${lookupResult.phone}` : '';
      console.log(`   statut: ${lookupResult.status}${suffix}`);

      if (index < pendingRows.length - 1) {
        const delay = randomBetween(config.delayMinMs, config.delayMaxMs);
        console.log(`   pause: ${delay} ms`);
        await finder.pauseBetweenRows(delay);
      }
    }
  } finally {
    await finder.close();
  }

  await workbook.save();
  console.log('Traitement termine.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Echec du script: ${message}`);
  process.exitCode = 1;
});
