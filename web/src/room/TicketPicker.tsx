import { useEffect, useState } from 'react';
import { pointsLabel, type Issue, type RoomView, type Sprint } from '../../../shared/protocol.ts';
import { api } from '../api.ts';
import { Modal } from '../ui.tsx';
import { useAct } from './act.ts';

export default function TicketPicker({ room, onClose }: { room: RoomView; onClose: () => void }) {
  const act = useAct();
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [sprint, setSprint] = useState('');
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState(new Set<string>());
  const [adding, setAdding] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const base = `/api/rooms/${room.id}`;

  // "Try again" (attempt) reloads the sprints until they have loaded, then the chosen sprint's issues.
  useEffect(() => {
    if (sprint) return;
    setError('');
    api<Sprint[]>(`${base}/sprints`).then((list) => {
      setSprints(list);
      if (list.length) setSprint(list[0].id);
      else setIssues([]);
    }, (e: Error) => setError(e.message));
  }, [attempt]);

  useEffect(() => {
    if (!sprint) return;
    let live = true;
    setIssues(null);
    setError('');
    api<Issue[]>(`${base}/sprints/${sprint}/issues`).then(
      (list) => live && setIssues(list),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [sprint, attempt]);

  const inRoom = new Set(room.stories.map((s) => s.key));
  const query = filter.trim().toLowerCase();
  const shown = (issues ?? []).filter((i) => `${i.key} ${i.summary}`.toLowerCase().includes(query));
  const free = shown.filter((i) => !inRoom.has(i.key));
  const allPicked = free.length > 0 && free.every((i) => picked.has(i.key));
  const keys = (issues ?? []).filter((i) => picked.has(i.key) && !inRoom.has(i.key)).map((i) => i.key);

  function pick(list: Issue[], on: boolean) {
    setPicked((prev) => {
      const next = new Set(prev);
      for (const i of list) {
        if (on) next.add(i.key);
        else next.delete(i.key);
      }
      return next;
    });
  }

  function add() {
    setAdding(true);
    act(`${base}/stories`, { tickets: keys }, onClose).finally(() => setAdding(false));
  }

  return (
    <Modal
      wide
      title="Add Tickets from Jira"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-block" disabled={!keys.length || adding} onClick={add}>
            Add {keys.length} {keys.length === 1 ? 'Ticket' : 'Tickets'}
          </button>
          <button className="btn btn-outline btn-block" onClick={onClose}>Cancel</button>
        </>
      }
    >
      <div className="picker-bar">
        <select
          className="select"
          aria-label="Sprint"
          value={sprint}
          onChange={(e) => {
            setSprint(e.target.value);
            setPicked(new Set());
          }}
        >
          {sprints.map((s) => (
            <option key={s.id} value={s.id}>{s.state === 'active' ? `${s.name} (active)` : s.name}</option>
          ))}
        </select>
        <input className="input" placeholder="Filter tickets..." value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <label className="picker-all">
        <input type="checkbox" checked={allPicked} disabled={!free.length} onChange={() => pick(free, !allPicked)} />
        Select all issues
      </label>
      {error ? (
        <div className="error-bar picker-error">
          {error}
          <button className="btn-link" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
        </div>
      ) : issues === null ? (
        <p className="picker-note">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="picker-note">There's no result for your search</p>
      ) : (
        <ul className="picker-list">
          {shown.map((i) => (
            <li key={i.key}>
              <label className={inRoom.has(i.key) ? 'added' : undefined}>
                <input
                  type="checkbox"
                  checked={inRoom.has(i.key) || picked.has(i.key)}
                  disabled={inRoom.has(i.key)}
                  onChange={(e) => pick([i], e.target.checked)}
                />
                <span>
                  <b>{i.key}</b> {i.summary}
                  <small>{i.type} · {i.status} · {i.assignee ?? 'Unassigned'} · Jira: {pointsLabel(i.points)}</small>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
