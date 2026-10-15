import { createContext, useContext, useEffect, useId, useState, type ReactNode } from 'react';
import { Check, Info, XCircle } from './icons.tsx';

type Kind = 'success' | 'info' | 'error';
type Ui = {
  toast(message: string, kind?: Kind): void;
  confirm(title: string, confirmLabel: string): Promise<boolean>;
};

const UiContext = createContext<Ui>(null!);
const icons = { success: Check, info: Info, error: XCircle };
let lastId = 0;

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; message: string; kind: Kind }[]>([]);
  const [ask, setAsk] = useState<{ title: string; confirmLabel: string; resolve(ok: boolean): void }>();
  const dismiss = (id: number) => setToasts((list) => list.filter((t) => t.id !== id));
  const [ui] = useState<Ui>(() => ({
    toast(message, kind = 'success') {
      const id = ++lastId;
      setToasts((list) => [...list, { id, message, kind }]);
      setTimeout(() => dismiss(id), 4000);
    },
    confirm: (title, confirmLabel) => new Promise((resolve) => setAsk({ title, confirmLabel, resolve })),
  }));
  const answer = (ok: boolean) => {
    ask!.resolve(ok);
    setAsk(undefined);
  };

  return (
    <UiContext value={ui}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map(({ id, message, kind }) => {
          const Icon = icons[kind];
          return (
            <div key={id} className={`toast toast-${kind}`}>
              <Icon size={28} />
              <span>{message}</span>
              <button className="toast-close" aria-label="Close" onClick={() => dismiss(id)}>×</button>
            </div>
          );
        })}
      </div>
      {ask && (
        <div
          className="modal-overlay confirm-overlay"
          onMouseDown={(e) => e.target === e.currentTarget && answer(false)}
          onKeyDown={(e) => e.key === 'Escape' && answer(false)}
        >
          <div className="confirm" role="alertdialog" aria-modal="true" aria-label={ask.title}>
            <div className="confirm-icon">!</div>
            <h2>{ask.title}</h2>
            <button className="confirm-ok" autoFocus onClick={() => answer(true)}>{ask.confirmLabel}</button>
            <button className="confirm-cancel" onClick={() => answer(false)}>Cancel</button>
          </div>
        </div>
      )}
    </UiContext>
  );
}

export const useToast = () => useContext(UiContext).toast;
export const useConfirm = () => useContext(UiContext).confirm;

export function Modal({ title, onClose, footer, children, wide }: {
  title: ReactNode;
  onClose(): void;
  footer: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={wide ? 'modal modal-wide' : 'modal'} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="modal-header">{title}</h2>
        <div className="modal-body">{children}</div>
        <div className="modal-footer">{footer}</div>
      </div>
    </div>
  );
}
