import { useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { Move } from '../icons.tsx';

const TEXT = { min: 12, max: 24, step: 2 };
const HEIGHT = { min: 60, max: 800, step: 20 };

// A viewer's own setting, remembered by this browser. Storage can be unavailable (a private window, blocked site data),
// and then it lasts until the page closes.
function useSaved<T extends number | null>(key: string, { min, max }: { min: number; max: number }, fallback: T) {
  const [value, setValue] = useState<number | T>(() => {
    try {
      const saved = Number(localStorage.getItem(key));
      if (saved >= min && saved <= max) return saved;
    } catch {}
    return fallback;
  });
  function change(to: number) {
    const clamped = Math.min(max, Math.max(min, Math.round(to)));
    setValue(clamped);
    try {
      localStorage.setItem(key, String(clamped));
    } catch {}
  }
  return [value, change] as const;
}

export const useTextSize = () => useSaved('description-text-size', TEXT, 14);

// Unset until the viewer resizes the box; until then it fits the text, up to a limit.
export const useBoxHeight = () => useSaved('description-height', HEIGHT, null);

// a and A size the text; the handle resizes the box: drag it, or use the arrow keys.
export default function DescriptionSize({ text, onText, box, onBox }: {
  text: number;
  onText(size: number): void;
  box: RefObject<HTMLElement | null>;
  onBox(height: number): void;
}) {
  const drag = useRef<{ y: number; height: number } | null>(null);

  function grab(e: PointerEvent<HTMLButtonElement>) {
    drag.current = { y: e.clientY, height: box.current!.offsetHeight };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function keys(e: KeyboardEvent) {
    const by = e.key === 'ArrowUp' ? -HEIGHT.step : e.key === 'ArrowDown' ? HEIGHT.step : 0;
    if (!by) return;
    e.preventDefault();
    onBox(box.current!.offsetHeight + by);
  }

  return (
    <div className="description-size" role="group" aria-label="Description size">
      <button className="text-smaller" aria-label="Smaller text" title="Smaller text" disabled={text <= TEXT.min} onClick={() => onText(text - TEXT.step)}>a</button>
      <button className="text-larger" aria-label="Larger text" title="Larger text" disabled={text >= TEXT.max} onClick={() => onText(text + TEXT.step)}>A</button>
      <button
        className="box-resize"
        aria-label="Resize box"
        title="Drag to resize the box"
        onPointerDown={grab}
        onPointerMove={(e) => drag.current && onBox(drag.current.height + e.clientY - drag.current.y)}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onKeyDown={keys}
      >
        <Move size={16} />
      </button>
    </div>
  );
}
