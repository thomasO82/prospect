import { RobotApplication } from './app/RobotApplication';
import { loadConfig } from './config/loadConfig';
import { ExcelPhoneWorkbook } from './infrastructure/excel/ExcelPhoneWorkbook';
import { CompanyContactCrawler } from './scrapers/contacts/CompanyContactCrawler';
import { GoogleMapsPhoneFinder } from './scrapers/google-maps/GoogleMapsPhoneFinder';
import { createProgressLogger } from './shared/console/progress';

async function main(): Promise<void> {
  const config = loadConfig(process.argv.slice(2));
  const workbook = new ExcelPhoneWorkbook(config);
  const phoneFinder = new GoogleMapsPhoneFinder(config);
  const contactCrawler = new CompanyContactCrawler(config);
  const app = new RobotApplication(config, workbook, phoneFinder, contactCrawler, createProgressLogger);

  await app.run();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Echec du script: ${message}`);
  process.exitCode = 1;
});
