import { apply } from '@realsync/ot-engine'
import type { DocumentState } from '@realsync/ot-engine'
import { getDocument, updateSnapshot } from '../db/documents'
import { getOperationsSince } from '../db/operations'
import { logger } from '../utils/logger'

/**
 * Compute a full document snapshot by replaying all operations since the
 * last stored snapshot, then persist the result to PostgreSQL.
 *
 * Called every 100 operations (via setImmediate) to keep snapshot replay
 * time bounded — without this, reconstructing document state would require
 * replaying the entire operation log from the beginning.
 *
 * Failures are logged but never rethrown: a missed snapshot is non-critical
 * and must not interrupt the client's editing session.
 *
 * @param docId          The document to snapshot.
 * @param serverVersion  The version number this snapshot should reflect.
 */
export async function takeSnapshot(docId: string, serverVersion: number): Promise<void> {
  try {
    const doc = await getDocument(docId)
    if (!doc) {
      logger.warn({ docId }, 'takeSnapshot: document not found — skipping')
      return
    }

    // Replay only the operations that were applied up to and including
    // `serverVersion`. Without the upper bound, ops written after this snapshot
    // job was scheduled (but before it runs) would be included, producing
    // document content for a later version while the snapshot is persisted
    // under `serverVersion` — mismatching content and version.
    const ops = await getOperationsSince(docId, doc.snapshotVersion, serverVersion)
    let state: DocumentState = { content: doc.snapshotContent, version: doc.snapshotVersion }
    for (const op of ops) {
      state = apply(state, op)
    }

    // Persist only if this version is newer than whatever is currently stored.
    // takeSnapshot() jobs run via setImmediate and can complete out of order;
    // updateSnapshot() uses a snapshotVersion < newVersion guard so a stale
    // job arriving late matches zero rows and does nothing rather than
    // regressing the snapshot.
    const updated = await updateSnapshot(docId, state.content, state.version)
    if (updated === 0) {
      logger.debug(
        { docId, snapshotVersion: state.version },
        'takeSnapshot: skipped — a newer snapshot already exists'
      )
    } else {
      logger.debug({ docId, snapshotVersion: state.version }, 'takeSnapshot: snapshot updated')
    }
  } catch (err) {
    logger.error({ docId, serverVersion, err }, 'takeSnapshot: failed — snapshot skipped')
  }
}
