import { apply } from '@realsync/ot-engine'
import type { DocumentState } from '@realsync/ot-engine'
import { getDocument, updateSnapshot } from '../db/documents'
import { getOperationsSince } from '../db/operations'
import { logger } from '../utils/logger'

/** Computes a full document snapshot by replaying operations since the last snapshot, and persists it to the database. */
export async function takeSnapshot(docId: string, serverVersion: number): Promise<void> {
  try {
    const doc = await getDocument(docId)
    if (!doc) {
      logger.warn({ docId }, 'takeSnapshot: document not found — skipping')
      return
    }

    // If the stored snapshot is already at or ahead of target version, a newer job already completed.
    if (doc.snapshotVersion >= serverVersion) {
      logger.debug(
        { docId, snapshotVersion: doc.snapshotVersion, serverVersion },
        'takeSnapshot: already up-to-date — skipping'
      )
      return
    }

    // Replay only the operations that were applied up to and including `serverVersion`.
    const ops = await getOperationsSince(docId, doc.snapshotVersion, serverVersion)
    let state: DocumentState = { content: doc.snapshotContent, version: doc.snapshotVersion }
    for (const op of ops) {
      state = apply(state, op)
    }

    // Guard against an incomplete or corrupt ops range to ensure serverVersion perfectly matches state.version.
    if (state.version !== serverVersion) {
      logger.error(
        { docId, serverVersion, replayedVersion: state.version, opCount: ops.length },
        'takeSnapshot: state.version after replay does not match serverVersion — aborting to prevent corrupt snapshot'
      )
      return
    }

    // Persist serverVersion explicitly to prevent divergence if update logic changes.
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
