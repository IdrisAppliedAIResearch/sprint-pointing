import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, Pencil } from '../icons.tsx';

// Shows the value with a pen button that turns it into a field with ✓ (save) and ✕ (cancel). The description is edited
// as raw Jira markup. Enter saves the summary, Cmd/Ctrl+Enter the description; Escape cancels without closing a dialog.
export default function Editable({ label, value, multiline, onSave, children }: {
  label: string;
  value: string;
  multiline?: boolean;
  onSave(value: string): Promise<boolean>;
  children: ReactNode;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (draft === null) {
    return (
      <div className="editable">
        {children}
        <button className="edit-open" aria-label={`Edit ${label.toLowerCase()}`} title={`Edit ${label.toLowerCase()}`} onClick={() => setDraft(value)}>
          <Pencil size={20} />
        </button>
      </div>
    );
  }

  async function save() {
    if (draft === value) return setDraft(null);
    setSaving(true);
    if (await onSave(draft!)) setDraft(null);
    setSaving(false);
  }

  function keys(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setDraft(null);
    } else if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    }
  }

  const props = { className: 'input', 'aria-label': label, value: draft, autoFocus: true, onKeyDown: keys };
  return (
    <div className="editing">
      {multiline ? <textarea {...props} className="input textarea" onChange={(e) => setDraft(e.target.value)} /> : <input {...props} maxLength={255} onChange={(e) => setDraft(e.target.value)} />}
      <div className="edit-actions">
        <button className="edit-save" aria-label={`Save ${label.toLowerCase()}`} title="Save" disabled={saving} onClick={save}><Check size={16} /></button>
        <button className="edit-cancel" aria-label="Cancel" title="Cancel" disabled={saving} onClick={() => setDraft(null)}>✕</button>
      </div>
    </div>
  );
}
