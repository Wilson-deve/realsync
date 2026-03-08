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

    // Replay all operations that were applied after the last stored snapshot.
    const ops = await getOperationsSince(docId, doc.snapshotVersion)
    let state: DocumentState = { content: doc.snapshotContent, version: doc.snapshotVersion }
    for (const op of ops) {
      state = apply(state, op)
    }

    await updateSnapshot(docId, state.content, serverVersion)
    logger.debug({ docId, serverVersion }, 'takeSnapshot: snapshot updated')
  } catch (err) {
    logger.error({ docId, serverVersion, err }, 'takeSnapshot: failed — snapshot skipped')
  }
}
