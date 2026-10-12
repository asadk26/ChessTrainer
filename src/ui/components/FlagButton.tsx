import { useState } from 'react';
import type { FeedbackWhere, StoredGame } from '../../domain/types';
import { sameTarget } from '../../coach/feedback';
import { addFeedback, removeFeedback } from '../actions';
import { useApp } from '../store';

/** A small "Seems wrong?" link that saves the player's note with the game. */
export function FlagButton({ game, where, quote, ply }: { game: StoredGame; where: FeedbackWhere; quote: string; ply?: number }) {
  const { refresh } = useApp();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const existing = game.feedback?.find((f) => sameTarget(f, { where, quote }));

  if (existing) {
    return (
      <span className="flag flagged">
        ⚑ Flagged{existing.note ? `: “${existing.note}”` : ''} ·{' '}
        <button className="link" onClick={async () => (await removeFeedback(game.id, existing.id), await refresh())}>
          undo
        </button>
      </span>
    );
  }
  if (!open) {
    return (
      <button className="flag flag-btn" onClick={() => setOpen(true)} title="Tell me this coaching seems wrong">
        ⚑ Seems wrong?
      </button>
    );
  }
  const save = async () => {
    setSaving(true);
    await addFeedback(game.id, { where, quote, note: note.trim(), ply });
    await refresh();
    setSaving(false);
    setOpen(false);
    setNote('');
  };
  return (
    <div className="flag-form">
      <textarea
        autoFocus
        rows={2}
        value={note}
        placeholder="What's off? e.g. “I played this to defend f2” or “the real problem was move 20” (optional)"
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="actions left inline">
        <button className="btn primary small" disabled={saving} onClick={save}>
          Save note
        </button>
        <button className="link" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
