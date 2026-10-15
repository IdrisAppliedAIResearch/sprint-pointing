import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { cardPoints, pointsLabel, type Revision, type RoomView } from '../../../shared/protocol.ts';
import { ChevronDown } from '../icons.tsx';
import { useConfirm, useToast } from '../ui.tsx';
import { useAct, useSetPoints } from './act.ts';
import Players from './Players.tsx';

export default function Panel({ room, onAdd }: { room: RoomView; onAdd: () => void }) {
  const act = useAct();
  const toast = useToast();
  const confirm = useConfirm();
  const setPoints = useSetPoints();
  const navigate = useNavigate();
  const isMod = room.me === room.ownerId;
  const base = `/api/rooms/${room.id}`;
  const story = room.stories.find((s) => s.id === room.storyId);
  const rev = room.mode === 'jira' && room.round === 'done' ? story?.revisions[0] : undefined;
  const waiting = room.players.filter((p) => !p.observer && !p.voted);
  const status = {
    idle: !isMod ? 'Waiting for moderator' : room.stories.length ? 'Click "Start" to begin voting' : 'No stories created',
    voting: waiting.length === 1 ? `Waiting for ${waiting[0].name} to vote` : `Waiting on ${waiting.length} players to vote`,
    revealed: 'Waiting for moderator to finalise vote',
    done: 'Story voting completed',
  }[room.round];

  const next = () => act(`${base}/next`, {}, () => toast('Next story'));
  const skip = async () => (await confirm('Are you sure you want to skip this story?', 'Skip')) && next();
  const end = async () =>
    (await confirm('End this session for everyone?', 'End session')) && act(base, undefined, () => navigate('/'), 'DELETE');

  return (
    <aside className="panel ctrl">
      <h3 className="ctrl-status">{status}</h3>
      {isMod && (
        <div className="ctrl-body">
          {room.round === 'idle' ? (
            room.stories.length ? (
              <button className="btn btn-block ctrl-start" onClick={() => act(`${base}/start`, {}, () => toast('Session started'))}>
                Start
              </button>
            ) : (
              <button className="btn btn-block ctrl-start" onClick={onAdd}>Add Stories</button>
            )
          ) : (
            <>
              {room.round === 'revealed' && <Finish room={room} />}
              <div className="ctrl-actions">
                {room.round !== 'done' && (
                  <button className={room.round === 'revealed' ? 'btn btn-outline full' : 'btn btn-outline'} onClick={() => act(`${base}/timer`, {})}>
                    Reset Timer
                  </button>
                )}
                {room.round === 'voting' && <button className="btn btn-outline" onClick={() => act(`${base}/reveal`, {})}>Flip Cards</button>}
                <button className="btn btn-outline" onClick={() => act(`${base}/clear`, {}, () => toast('Story voting reset', 'info'))}>
                  Clear Votes
                </button>
                {room.round === 'done' ? (
                  <button className="btn btn-outline" onClick={next}>Next Story</button>
                ) : (
                  <button className="btn btn-outline" onClick={skip}>Skip Story</button>
                )}
              </div>
              {story && rev && (
                <p className={`ctrl-jira sync ${rev.status}`}>
                  {rev.status === 'pending'
                    ? 'Saving to Jira…'
                    : rev.status === 'synced'
                      ? `✓ Saved ${pointsLabel(rev.to)} to ${story.key}`
                      : `Jira update failed: ${rev.error}`}
                  {rev.status === 'failed' && <button className="btn-link" onClick={() => setPoints(story, story.points)}>Retry</button>}
                </p>
              )}
            </>
          )}
        </div>
      )}
      <Players room={room} />
      <Invite id={room.id} />
      {isMod && (
        <div className="ctrl-end">
          <button className="btn-link" onClick={end}>End session</button>
        </div>
      )}
    </aside>
  );
}

function Finish({ room }: { room: RoomView }) {
  const act = useAct();
  const toast = useToast();
  const cards = room.cards.filter((c) => cardPoints(c) !== null);
  const count = (card: string) => room.players.filter((p) => p.vote === card).length;
  // The most common numeric vote; iterating in deck order makes ties go to the higher card.
  const [card, setCard] = useState(() => cards.reduce((best, c) => (count(c) && count(c) >= count(best) ? c : best), ''));

  const finish = () =>
    act<{ revision: Revision }>(`/api/rooms/${room.id}/finish`, { points: cardPoints(card) }, ({ revision }) =>
      revision.status === 'failed' ? toast(`Jira update failed: ${revision.error}`, 'error') : toast('Story estimate was saved'));

  return (
    <div className="ctrl-finish">
      <select className="select" aria-label="Final estimate" value={card} onChange={(e) => setCard(e.target.value)}>
        <option value="" hidden />
        {cards.map((c) => <option key={c}>{c}</option>)}
      </select>
      <button className="btn" disabled={!card} onClick={finish}>Finish Voting</button>
    </div>
  );
}

function Invite({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const url = `${location.origin}/rooms/${id}?join`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      input.current?.select(); // no clipboard API outside HTTPS/localhost
    }
  }

  return (
    <div className="invite">
      <button className={open ? 'invite-toggle open' : 'invite-toggle'} aria-expanded={open} onClick={() => setOpen(!open)}>
        Invite a teammate
        <ChevronDown />
      </button>
      {open && (
        <div className="invite-body">
          <input ref={input} className="input" aria-label="Invite link" value={url} readOnly onFocus={(e) => e.target.select()} />
          <button className="btn btn-outline" onClick={copy}>{copied ? 'Copied!' : 'Copy URL'}</button>
        </div>
      )}
    </div>
  );
}
