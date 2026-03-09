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

    // If the stored snapshot is already at or ahead of the target version, a
    // newer job already completed — this one is a no-op.  Return early to avoid
    // running getOperationsSince() (which would return an empty list) and then
    // tripping the state.version !== serverVersion assertion with a noisy error.
    if (doc.snapshotVersion >= serverVersion) {
      logger.debug(
        { docId, snapshotVersion: doc.snapshotVersion, serverVersion },
        'takeSnapshot: already up-to-date — skipping'
      )
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

    // Guard against an incomplete or corrupt ops range.  apply() increments
    // state.version by 1 for each op, so after replaying all ops up to
    // serverVersion the result must equal serverVersion exactly.  A mismatch
    // means ops had gaps (missing versions) or the ops range was incomplete —
    // persisting mismatched content/version would corrupt the snapshot and
    // produce incorrect document state for every future client join.
    if (state.version !== serverVersion) {
      logger.error(
        { docId, serverVersion, replayedVersion: state.version, opCount: ops.length },
        'takeSnapshot: state.version after replay does not match serverVersion — aborting to prevent corrupt snapshot'
      )
      return
    }

    // Persist serverVersion explicitly rather than state.version.  They are
    // equal after the assertion above, but using the job's target version as
    // the authoritative label makes the intent unambiguous and prevents any
    // future divergence if apply() semantics change.
    const updated = await updateSnapshot(docId, state.content, serverVersion)
    if (updated === 0) {
      logger.debug(
        { docId, snapshotVersion: serverVersion },
        'takeSnapshot: skipped — a newer snapshot already exists'
      )
    } else {
      logger.debug({ docId, snapshotVersion: serverVersion }, 'takeSnapshot: snapshot updated')
    }
  } catch (err) {
    logger.error({ docId, serverVersion, err }, 'takeSnapshot: failed — snapshot skipped')
  }
}
