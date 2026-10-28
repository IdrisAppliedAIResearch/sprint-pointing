import type { RoomView } from '../../../shared/protocol.ts';
import { Coffee } from '../icons.tsx';

const COLORS = ['#f8e61b', '#225277', '#1694a2', '#7ec851', '#9cf81b', '#0b756a', '#4a99e8', '#6f4aa5', '#e845d0', '#e8457e', '#9b2c48', '#e51515', '#f8b21b'];

export default function Results({ room }: { room: RoomView }) {
  const votes = room.players.flatMap((p) => (p.vote === null ? [] : [p.vote]));
  const slices = room.cards
    .filter((card) => votes.includes(card))
    .map((card, i) => {
      const count = votes.filter((v) => v === card).length;
      return { card, count, color: COLORS[i], pct: (count / votes.length) * 100 };
    });
  let at = 0;
  const stops = slices.map((s) => `${s.color} ${at}% ${(at += s.pct)}%`);

  return (
    <section className="panel">
      <div className="results-body">
        <div className="donut" style={stops.length ? { background: `conic-gradient(${stops.join(', ')})` } : undefined}>
          <div className="donut-center">
            <span className="donut-players">{votes.length} {votes.length === 1 ? 'Player' : 'Players'}</span>
            <span className="donut-voted">voted</span>
          </div>
        </div>
        <ul className={slices.length > 5 ? 'legend two' : 'legend'}>
          {slices.map((s) => (
            <li key={s.card}>
              <span className="legend-value">
                <i style={{ background: s.color }} />
                {s.card === '☕' ? <Coffee size={20} /> : s.card}
              </span>
              <span className="legend-share">
                {s.pct.toFixed(1)}% <b>({s.count} {s.count === 1 ? 'vote' : 'votes'})</b>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
