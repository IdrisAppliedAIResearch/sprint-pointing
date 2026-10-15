import { useEffect, useMemo, useState } from 'react';
import type { RoomView } from '../../../shared/protocol.ts';
import { Check, CheckCircle, Clock, Coffee } from '../icons.tsx';
import { useAct } from './act.ts';

export default function Players({ room }: { room: RoomView }) {
  const act = useAct();
  const [menu, setMenu] = useState(false);

  return (
    <>
      <div className="players-head">
        Players:
        <Timer room={room} />
      </div>
      <ul className="players">
        {room.players.map((p) => {
          const face = (
            <>
              {initials(p.name)}
              <i className={`presence ${p.observer ? 'observer' : p.online ? 'online' : 'offline'}`} />
            </>
          );
          return (
            <li key={p.id} className="player">
              {p.id === room.me ? (
                <button className="player-avatar" title={`${p.observer ? 'Observer' : 'Player'} - Click to change`} onClick={() => setMenu(!menu)}>
                  {face}
                </button>
              ) : (
                <span className="player-avatar">{face}</span>
              )}
              <div className="player-info">
                <span className="player-name">
                  <span title={p.name}>{p.name}</span>
                  {p.id === room.ownerId && <span className="muted">&nbsp;(moderator)</span>}
                  {p.voted && <CheckCircle size={18} />}
                </span>
                <span className="player-time">{hms(p.votedAt !== null && room.timerStart !== null ? p.votedAt - room.timerStart : 0)}</span>
              </div>
              {p.vote !== null && <span className="player-vote">{p.vote === '☕' ? <Coffee size={40} /> : p.vote}</span>}
              {p.id === room.me && menu && (
                <>
                  <div className="role-backdrop" onClick={() => setMenu(false)} />
                  <div className="role-menu">
                    {[false, true].map((observer) => (
                      <button
                        key={String(observer)}
                        className={observer === p.observer ? 'menu-item selected' : 'menu-item'}
                        onClick={() => {
                          setMenu(false);
                          if (observer !== p.observer) act(`/api/rooms/${room.id}/observer`, { observer });
                        }}
                      >
                        {observer ? 'Observer' : 'Player'}
                        {observer === p.observer && <Check size={20} />}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Timer({ room }: { room: RoomView }) {
  const skew = useMemo(() => room.now - Date.now(), [room.now]);
  const { timerStart: start, timerStop: stop } = room;
  const running = start !== null && stop === null;
  const [, tick] = useState(0);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  return (
    <span className={stop === null ? 'timer' : 'timer stopped'}>
      <Clock size={18} />
      {hms(start === null ? 0 : (stop ?? Date.now() + skew) - start)}
    </span>
  );
}

function hms(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map(([c]) => c).join('').toUpperCase();
}
