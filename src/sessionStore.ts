import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type ContractorSession = {
  contractorId: number;
  expiresAt: number;
};

export function resolveSessionStorePath(filePath?: string) {
  return resolve(filePath ?? 'data/contractor-sessions.json');
}

function ensureSessionStoreDirectory(filePath: string) {
  const directory = dirname(filePath);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
}

export function loadContractorSessions(filePath?: string): Map<string, ContractorSession> {
  const sessionFile = resolveSessionStorePath(filePath);
  const sessions = new Map<string, ContractorSession>();

  try {
    if (!existsSync(sessionFile)) {
      ensureSessionStoreDirectory(sessionFile);
      return sessions;
    }

    const rawContents = readFileSync(sessionFile, 'utf8').trim();
    if (!rawContents) return sessions;

    const parsed = JSON.parse(rawContents) as Record<string, ContractorSession>;
    const now = Date.now();
    for (const [token, session] of Object.entries(parsed)) {
      if (!session || typeof session.contractorId !== 'number' || typeof session.expiresAt !== 'number') continue;
      if (session.expiresAt > now) {
        sessions.set(token, { contractorId: session.contractorId, expiresAt: session.expiresAt });
      }
    }
  } catch (error) {
    console.warn('Unable to load persisted contractor sessions. Starting with an empty session store.', error);
  }

  return sessions;
}

export function saveContractorSessions(filePath: string | undefined, sessions: Map<string, ContractorSession>) {
  const sessionFile = resolveSessionStorePath(filePath);
  ensureSessionStoreDirectory(sessionFile);
  const serializable = Object.fromEntries(
    [...sessions.entries()].filter(([, session]) => session.expiresAt > Date.now())
  );
  writeFileSync(sessionFile, JSON.stringify(serializable, null, 2));
}

export function upsertContractorSession(filePath: string | undefined, token: string, contractorId: number, expiresAt: number) {
  const sessions = loadContractorSessions(filePath);
  sessions.set(token, { contractorId, expiresAt });
  saveContractorSessions(filePath, sessions);
  return sessions;
}

export function deleteContractorSession(filePath: string | undefined, token: string) {
  const sessions = loadContractorSessions(filePath);
  sessions.delete(token);
  saveContractorSessions(filePath, sessions);
  return sessions;
}