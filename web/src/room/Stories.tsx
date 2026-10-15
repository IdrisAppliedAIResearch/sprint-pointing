import { useState, type MouseEvent } from 'react';
import { cardPoints, pointsLabel, type RoomView, type Story } from '../../../shared/protocol.ts';
import { Download, Plus, Refresh, Trash } from '../icons.tsx';
import { useConfirm, useToast } from '../ui.tsx';
import { useAct, useSetPoints } from './act.ts';

const TABS = { active: 'Active', completed: 'Completed', all: 'All' };

type Tab = keyof typeof TABS;

export default function Stories({ room, onAdd, onOpen }: { room: RoomView; onAdd: () => void; onOpen: (id: number) => void }) {
  const act = useAct();
  const toast = useToast();
  const confirm = useConfirm();
  const [tab, setTab] = useState<Tab>('active');
  const [syncing, setSyncing] = useState(false);
  const isMod = room.me === room.ownerId;
  const jira = room.mode === 'jira';
  const lists = {
    active: room.stories.filter((s) => s.points === null),
    completed: room.stories.filter((s) => s.points !== null),
    all: room.stories,
  };
  const completed = tab === 'completed';

  function sync() {
    setSyncing(true);
    act(`/api/rooms/${room.id}/sync`, {}, () => toast('Synced with Jira')).finally(() => setSyncing(false));
  }

  async function remove(story: Story) {
    if (await confirm('Are you sure you want to delete this story?', 'Delete')) {
      act(`/api/rooms/${room.id}/stories/${story.id}`, undefined, undefined, 'DELETE');
    }
  }

  function open(e: MouseEvent, story: Story) {
    if (!(e.target as Element).closest('a, button, select')) onOpen(story.id);
  }

  function rowClass(story: Story) {
    if (story.id === room.storyId) return 'current';
    if (tab === 'all') return story.points === null ? 'open' : 'estimated';
  }

  return (
    <section className="panel stories">
      <nav className="stories-tabs">
        {(Object.keys(TABS) as Tab[]).map((t) => (
          <button key={t} className={t === tab ? 'stories-tab active' : 'stories-tab'} aria-pressed={t === tab} onClick={() => setTab(t)}>
            <span>{TABS[t]}<span className="hide-sm"> Stories</span></span>
            <span className="badge">{lists[t].length}</span>
          </button>
        ))}
        {isMod && (
          <span className="stories-actions">
            <button aria-label="Add Tickets" onClick={onAdd}>
              <Plus />
              <span className="hide-sm">Add Tickets</span>
            </button>
            {jira && (
              <button title="Sync" className={syncing ? 'spin' : undefined} disabled={syncing} onClick={sync}>
                <Refresh />
              </button>
            )}
            <button title="Export" onClick={() => exportCsv(room.stories)}>
              <Download />
            </button>
          </span>
        )}
      </nav>
      {room.stories.length === 0 ? (
        <div className="stories-empty">
          {isMod ? (
            <>
              <p>You don't have stories yet, {jira ? 'add some from Jira' : 'create one'}!</p>
              <button onClick={onAdd}>
                <Plus /> Add Tickets
              </button>
            </>
          ) : (
            <p>No stories yet</p>
          )}
        </div>
      ) : (
        <table className="stories-table">
          {completed && (
            <thead>
              <tr>
                <th>Title</th>
                <th>Est.</th>
                {jira && <th>Jira</th>}
                {isMod && <th />}
              </tr>
            </thead>
          )}
          <tbody>
            {lists[tab].map((s) => (
              <tr key={s.id} className={rowClass(s)} onClick={(e) => open(e, s)}>
                <td>
                  <div className="stories-title">
                    {s.url && <a href={s.url} target="_blank" rel="noreferrer">{s.key}</a>}{' '}
                    <button onClick={() => onOpen(s.id)}>{s.summary}</button>
                  </div>
                  {jira && <div className="stories-meta">{s.type} · {s.status}</div>}
                </td>
                {completed ? (
                  <>
                    <td>{isMod ? <Estimate cards={room.cards} story={s} /> : pointsLabel(s.points)}</td>
                    {jira && <td><JiraBadge story={s} isMod={isMod} /></td>}
                  </>
                ) : (
                  jira && <td><span className="chip">Jira: {pointsLabel(s.jiraPoints)}</span></td>
                )}
                {isMod && (
                  <td className="stories-icon">
                    {s.id !== room.storyId && (
                      <button title="Delete story" aria-label="Delete story" onClick={() => remove(s)}><Trash /></button>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {completed && (
              <tr className="stories-total">
                <td>Total</td>
                <td>{lists.completed.reduce((sum, s) => sum + s.points!, 0)}</td>
                {jira && <td />}
                {isMod && <td />}
              </tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}

function exportCsv(stories: Story[]) {
  const cell = (v: string) => {
    const text = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v; // keep spreadsheets from running summaries as formulas
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const rows = [['Key', 'Summary', 'Estimate'], ...stories.map((s) => [s.key ?? '', s.summary, String(s.points ?? '')])];
  const a = document.createElement('a');
  a.href = `data:text/csv;charset=utf-8,${encodeURIComponent('\uFEFF' + rows.map((r) => r.map(cell).join(',')).join('\n'))}`;
  a.download = 'sprint-planning-estimates.csv';
  a.click();
}

function Estimate({ cards, story }: { cards: string[]; story: Story }) {
  const setPoints = useSetPoints();
  const values = cards.map(cardPoints).filter((n) => n !== null);
  const options = values.includes(story.points!) ? values : [...values, story.points!].sort((a, b) => a - b);
  return (
    <select
      className="select"
      aria-label={`Estimate for ${story.key ?? story.summary}`}
      value={story.points!}
      onChange={(e) => setPoints(story, Number(e.target.value))}
    >
      {options.map((n) => <option key={n} value={n}>{pointsLabel(n)}</option>)}
    </select>
  );
}

function JiraBadge({ story, isMod }: { story: Story; isMod: boolean }) {
  const setPoints = useSetPoints();
  const rev = story.revisions[0];
  const resend = (label: string) => isMod && <button className="btn-link" onClick={() => setPoints(story, story.points)}>{label}</button>;
  if (rev?.status === 'pending') return <span className="sync pending">Saving…</span>;
  if (rev?.status === 'failed') {
    return (
      <>
        <span className="sync failed" title={rev.error ?? undefined}>Failed</span>
        {resend('Retry')}
      </>
    );
  }
  if (story.jiraPoints === story.points) return <span className="sync synced">✓ In Jira</span>;
  return (
    <>
      <span className="sync drift">Jira has {pointsLabel(story.jiraPoints)}</span>
      {resend('Push')}
    </>
  );
}
