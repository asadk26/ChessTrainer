import { BAND_LABEL, bandOf, barFill } from '../../analysis/evalBand';

/** A small advantage meter plus a word ("Clearly better"). `cp` is from your side. */
export function EvalBar({ cp, label }: { cp: number; label?: string }) {
  const band = bandOf(cp);
  const fill = barFill(cp);
  return (
    <span className={`eval-bar band-${band}`} title={`${label ? `${label}: ` : ''}${BAND_LABEL[band]}`}>
      <span className="eval-track" aria-hidden>
        <span className="eval-fill" style={{ width: `${fill}%` }} />
        <span className="eval-mid" />
      </span>
      <span className="eval-word">{label ? `${label}: ` : ''}{BAND_LABEL[band]}</span>
    </span>
  );
}

/** "Clearly better → Equal" with both bars. */
export function EvalChange({ before, after }: { before: number; after: number }) {
  return (
    <span className="eval-change">
      <EvalBar cp={before} /> <span className="eval-arrow">→</span> <EvalBar cp={after} />
    </span>
  );
}
