import type { ContactLookupResult, LookupResult, PendingRow, WorkbookContext } from './types';

// Contrat attendu par l'application pour lire, modifier et sauvegarder le fichier de travail.
export interface WorkbookGateway {
  load(): Promise<WorkbookContext>;
  applyLookupResult(row: PendingRow, lookupResult: LookupResult): void;
  applyContactResult(row: PendingRow, contactResult: ContactLookupResult): void;
  saveProgress(): Promise<void>;
  save(): Promise<void>;
}

// Contrat pour un service capable de trouver un telephone et/ou un site officiel.
export interface PhoneLookupService {
  init(): Promise<void>;
  lookup(row: PendingRow): Promise<LookupResult>;
  close(): Promise<void>;
}

// Contrat pour un service capable d'enrichir une entreprise avec email et nom de contact.
export interface ContactLookupService {
  init(): Promise<void>;
  crawlCompanyWebsite(row: PendingRow, websiteUrl?: string): Promise<ContactLookupResult>;
  close(): Promise<void>;
}

// Contrat minimal pour afficher et restaurer l'etat de la progression console.
export interface ProgressReporter {
  update(current: number): void;
  clear(): void;
  install(): void;
  restore(): void;
}
