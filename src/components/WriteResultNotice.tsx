import type { WriteResult, WriteSkip } from '../data/contract';

export interface WriteResultNoticeProps {
  result: WriteResult;
}

/** Readable English for a skip reason — nobody outside this codebase should
 *  ever see the bare enum value. `'line-changed'` gets the most explanation:
 *  it means the note changed under Tyler and the write was refused rather
 *  than applied to whatever is there now, which he needs to know rather than
 *  assume it went through. */
const SKIP_REASON_TEXT: Record<WriteSkip['reason'], string> = {
  'line-changed':
    "the line in your note changed since this was proposed, so nothing was written rather than overwriting what's there now — check the task and try again",
  'file-missing': 'the file this task lived in is gone',
  'not-a-task': "that line isn't a checkbox any more",
  'needs-splitting': "this task needs more than one sitting, which this version can't write yet",
};

/**
 * What actually happened on the last accept. Skips are surfaced plainly, in
 * readable English rather than the raw `WriteSkip['reason']` value — a
 * refused write that looks like success is worse than no write at all.
 */
export function WriteResultNotice({ result }: WriteResultNoticeProps) {
  if (result.skipped.length === 0 && result.errors.length === 0) return null;

  return (
    <div className="weekfit-writeresult weekfit-notice weekfit-notice--warning" role="alert">
      {result.written > 0 && (
        <p className="weekfit-writeresult__written">
          Wrote {result.written} {result.written === 1 ? 'block' : 'blocks'}.
        </p>
      )}
      {result.skipped.length > 0 && (
        <ul className="weekfit-writeresult__list">
          {result.skipped.map((s) => (
            <li key={s.key}>
              <strong>{s.title}</strong> wasn&rsquo;t written — {SKIP_REASON_TEXT[s.reason]}.
            </li>
          ))}
        </ul>
      )}
      {result.errors.length > 0 && (
        <ul className="weekfit-writeresult__list weekfit-writeresult__list--errors">
          {result.errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
