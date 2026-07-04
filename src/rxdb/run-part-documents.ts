import type { TrackerRunPartDocument } from '@tmrxjd/platform/tools';

type RunPartRxDocumentLike = TrackerRunPartDocument & {
  toJSON?: () => TrackerRunPartDocument;
};

/** RxDB returns document instances; spread/stitch must use plain JSON payloads. */
export function toRunPartPlainDocument(
  doc: TrackerRunPartDocument | RunPartRxDocumentLike | null | undefined,
): TrackerRunPartDocument | null {
  if (!doc) return null;
  if (typeof doc.toJSON === 'function') {
    return doc.toJSON();
  }
  return doc;
}
