import type { RoomView } from '../../../shared/protocol.ts';
import { Coffee } from '../icons.tsx';
import { useAct } from './act.ts';

export default function Deck({ room }: { room: RoomView }) {
  const act = useAct();
  const mine = room.players.find((p) => p.id === room.me)?.vote;
  return (
    <ul className="deck">
      {room.cards.map((card) => {
        const corner = card === '☕' ? 'C' : card;
        return (
          <li key={card}>
            <button
              className={card === mine ? 'deck-card selected' : 'deck-card'}
              aria-label={card === '☕' ? 'Coffee' : card}
              aria-pressed={card === mine}
              disabled={room.round !== 'voting'}
              onClick={() => card !== mine && act(`/api/rooms/${room.id}/vote`, { value: card })}
            >
              <span className="card-corner">{corner}</span>
              <span className="card-face">
                {card === '☕' ? <Coffee size={50} /> : <span style={{ fontSize: `${Math.max(55, 100 - 9 * card.length)}%` }}>{card}</span>}
              </span>
              <span className="card-corner">{corner}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
