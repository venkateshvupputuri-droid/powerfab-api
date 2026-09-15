import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadContractorSessions, upsertContractorSession, deleteContractorSession } from './sessionStore';

test('session store persists and rehydrates contractors across restarts', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'powerfab-session-'));
  const storeFile = join(tempDir, 'contractor-sessions.json');

  try {
    const initial = loadContractorSessions(storeFile);
    assert.deepEqual(initial, new Map());

    upsertContractorSession(storeFile, 'token-123', 42, Date.now() + 60_000);
    const reloaded = loadContractorSessions(storeFile);
    const session = reloaded.get('token-123');
    assert.ok(session);
    assert.equal(session.contractorId, 42);
    assert.equal(session.expiresAt > 0, true);

    deleteContractorSession(storeFile, 'token-123');
    assert.equal(loadContractorSessions(storeFile).has('token-123'), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
