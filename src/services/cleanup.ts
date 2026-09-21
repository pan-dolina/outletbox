import type { DataStore } from '@tus/utils';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { log } from '../log.js';
import type { StorageBackend } from '../storage/index.js';
import { audit } from './audit.js';
import { purgeExpiredSessions } from './auth.js';
import { purgeExpiredAccess } from './access.js';
import { failUpload, listReadyFiles, listStaleUploads, liveStorageKeys, markMissing, type ItemRow } from './items.js';

export interface CleanupDeps { db: Db; cfg: Config; storage: StorageBackend; tusStore: DataStore }

export interface CleanupReport { staleUploads: number; missingFiles: number; orphans: number; sessions: number; accessSessions: number; challenges: number }

/** Removes an unfinished upload's data from storage, whichever mechanism created it. */
export async function discardUploadData(deps: CleanupDeps, item: ItemRow): Promise<void> {
  if (item.kind !== 'file') return;
  if (item.upload_kind === 'tus') {
    try { await deps.tusStore.remove(item.id); } catch { /* may already be gone */ }
  }
  await deps.storage.delete(item.id).catch((err) => log.warn('cleanup: delete failed', { itemId: item.id, err }));
}

/**
 * Keeps metadata and storage consistent:
 *  1. unfinished uploads older than the TTL are removed;
 *  2. ready files whose object vanished are flagged as 'missing';
 *  3. storage artefacts no live item references are deleted (tus sidecars,
 *     partial objects, abandoned multipart uploads);
 *  4. expired admin sessions, recipient sessions and old challenges are purged.
 */
export async function runCleanup(deps: CleanupDeps, opts: { ttlMs?: number; verifyFiles?: boolean } = {}): Promise<CleanupReport> {
  const ttlMs = opts.ttlMs ?? deps.cfg.incompleteUploadTtlMs;
  const report: CleanupReport = { staleUploads: 0, missingFiles: 0, orphans: 0, sessions: 0, accessSessions: 0, challenges: 0 };

  for (const item of listStaleUploads(deps.db, ttlMs)) {
    await discardUploadData(deps, item);
    if (failUpload(deps.db, item.id, 'expired')) {
      report.staleUploads++;
      audit(deps.db, { actorType: 'system', action: 'upload.expired', caseId: item.case_id, itemId: item.id });
    }
  }

  if (opts.verifyFiles ?? true) {
    for (const item of listReadyFiles(deps.db)) {
      const st = await deps.storage.stat(item.id).catch(() => undefined);
      if (st === undefined) continue; // storage error: don't flag
      if (st === null) {
        markMissing(deps.db, item.id);
        report.missingFiles++;
        audit(deps.db, { actorType: 'system', action: 'file.missing', caseId: item.case_id, itemId: item.id });
      }
    }
  }

  const live = liveStorageKeys(deps.db);
  try {
    const { removed } = await deps.storage.cleanupOrphans({ olderThanMs: ttlMs, isLive: (key) => live.has(key) });
    report.orphans = removed;
  } catch (err) {
    log.warn('cleanup: orphan sweep failed', { err });
  }

  report.sessions = purgeExpiredSessions(deps.db);
  const access = purgeExpiredAccess(deps.db);
  report.accessSessions = access.sessions;
  report.challenges = access.challenges;
  log.info('cleanup finished', { ...report });
  return report;
}
