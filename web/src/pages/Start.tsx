import { useEffect, useState, type SubmitEvent } from 'react';
import { useNavigate } from 'react-router';
import { cardPoints, DECKS, type DeckId, pointsLabel } from '../../../shared/protocol.ts';
import { api, serverConfig } from '../api.ts';
import { Lock, User } from '../icons.tsx';
import './start.css';

export default function Start() {
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [pending, setPending] = useState<'jira' | 'custom'>();
  const [deck, setDeck] = useState<DeckId>('scrum');
  const [range, setRange] = useState<[number, number]>(); // the whole deck until one is picked
  const [encrypted, setEncrypted] = useState(false);
  useEffect(() => {
    void serverConfig().then((config) => setEncrypted(config.credentialStorage === 'encrypted')).catch(() => {});
  }, []);
  const points = DECKS[deck].cards.map(cardPoints).filter((n) => n !== null);
  const [min, max] = range ?? [points[0], points.at(-1)!];

  async function start(form: HTMLFormElement, mode: 'jira' | 'custom') {
    if (mode === 'jira' && !isSecureContext) return setError('Open this page over HTTPS to connect Jira, or your token would travel unencrypted.');
    const data = new FormData(form);
    setPending(mode);
    try {
      const { id } = await api<{ id: string }>('/api/rooms', { name: data.get('name'), deck, min, max, token: mode === 'jira' ? data.get('token') : undefined });
      navigate(`/rooms/${id}`);
    } catch (e) {
      setError((e as Error).message);
      setPending(undefined);
    }
  }

  return (
    <form
      className="panel start"
      onSubmit={(e) => {
        e.preventDefault();
        start(e.currentTarget, 'jira');
      }}
    >
      <h1>Let's start!</h1>
      <p>Plan your sprint with Jira or custom tickets:</p>
      <NameField />
      <select
        className="select"
        aria-label="Card deck"
        value={deck}
        onChange={(e) => {
          setDeck(e.target.value as DeckId);
          setRange(undefined);
        }}
      >
        {Object.entries(DECKS).map(([id, deck]) => <option key={id} value={id}>{deck.name}</option>)}
      </select>
      <div className="start-range">
        Points from
        <select className="select" aria-label="Points from" value={min} onChange={(e) => setRange([Number(e.target.value), max])}>
          {points.filter((n) => n < max).map((n) => <option key={n} value={n}>{pointsLabel(n)}</option>)}
        </select>
        to
        <select className="select" aria-label="Points to" value={max} onChange={(e) => setRange([min, Number(e.target.value)])}>
          {points.filter((n) => n > min).map((n) => <option key={n} value={n}>{pointsLabel(n)}</option>)}
        </select>
      </div>
      <div className="start-field">
        <Lock />
        <input className="input" name="token" type="password" placeholder="Jira personal access token" autoComplete="one-time-code" />
      </div>
      {error && <div className="error-bar">{error}</div>}
      <button className="btn btn-block" disabled={!!pending}>{pending === 'jira' ? 'Connecting to Jira…' : 'Connect Jira'}</button>
      <div className="start-or">Or</div>
      <button type="button" className="btn-outline btn-block" disabled={!!pending} onClick={(e) => start(e.currentTarget.form!, 'custom')}>
        Use custom tickets
      </button>
      <p className="start-note">{encrypted ? 'Your token is encrypted for this meeting. End the meeting and revoke the token afterward. It is never included in the site build.' : 'Your token is used only for this meeting. It is never included in the site build.'}</p>
    </form>
  );
}

export function Join({ id, onJoined }: { id: string; onJoined: () => void }) {
  const [error, setError] = useState('');

  async function join(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    try {
      const { token } = await api<{ token: string }>(`/api/rooms/${id}/join`, { name: new FormData(e.currentTarget).get('name') });
      sessionStorage.setItem(`participant:${id}`, token);
      onJoined();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <form className="panel start" onSubmit={join}>
      <h1>Let's start!</h1>
      <p>Join the session:</p>
      <NameField />
      {error && <div className="error-bar">{error}</div>}
      <button className="btn btn-block">Enter</button>
    </form>
  );
}

export function Ended() {
  const navigate = useNavigate();
  return (
    <div className="panel start">
      <h1>This session has ended.</h1>
      <button className="btn btn-block" onClick={() => navigate('/')}>Start a new session</button>
    </div>
  );
}

function NameField() {
  return (
    <div className="start-field">
      <User />
      <input className="input" name="name" placeholder="Enter your name" maxLength={50} autoFocus />
    </div>
  );
}
