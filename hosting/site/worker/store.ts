import { randomToken, tokenHash } from './credentials.ts';
import { fail, type Database, type Participant, type Room, type RoomRow } from './types.ts';

export const IDLE_MS = 30 * 60_000;
const PRESENCE_MS = 45_000;
const LEASE_MS = 60_000;

export function database(binding: Database) {
  if (!binding?.prepare) fail(503, 'Hosted meeting storage is not configured');
  return binding.withSession?.('first-primary') ?? binding;
}

export async function readRoom(db: Database, id: string) {
  const row = await db.prepare('SELECT * FROM rooms WHERE id = ?').bind(id).first<RoomRow>();
  if (!row) return fail(404, 'Session not found');
  if (row.expires_at <= Date.now() && row.lock_until <= Date.now()) {
    await db.prepare('DELETE FROM rooms WHERE id = ? AND expires_at <= ? AND lock_until <= ?').bind(id, Date.now(), Date.now()).run();
    return fail(404, 'Session not found');
  }
  return row;
}

// A tab that joined by the invite link sends its own token; the moderator's browser sends its cookie.
export async function identify(room: Room, request: Request) {
  const token = request.headers.get('x-participant')
    ?? request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith('participant='))?.slice('participant='.length) ?? '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return fail(401, 'Join the session first');
  const hash = await tokenHash(token);
  return room.participants.find((person) => person.tokenHash === hash) ?? fail(401, 'Join the session first');
}

export function requireModerator(room: Room, person: Participant) {
  if (room.moderator !== person.id) fail(403, 'Only the moderator can do that');
}

export async function addParticipant(room: Room, name: string) {
  if (room.participants.length >= 100) fail(409, 'This meeting has reached its participant limit');
  const token = randomToken();
  const person = { id: room.participants.length + 1, name, tokenHash: await tokenHash(token), observer: false };
  room.participants.push(person);
  return { person, token, cookie: `participant=${token}; Path=/api/rooms/${room.id}; HttpOnly; Secure; SameSite=Lax; Max-Age=86400` };
}

export async function online(db: Database, roomId: string) {
  const { results } = await db.prepare('SELECT DISTINCT participant_id FROM presence WHERE room_id = ? AND seen_at > ?').bind(roomId, Date.now() - PRESENCE_MS).all<{ participant_id: number }>();
  return new Set(results.map((row) => row.participant_id));
}

export async function heartbeat(db: Database, roomId: string, participantId: number, clientId: string) {
  const now = Date.now();
  await db.batch([
    db.prepare('INSERT INTO presence (room_id, participant_id, client_id, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT (room_id, participant_id, client_id) DO UPDATE SET seen_at = excluded.seen_at WHERE presence.seen_at < ?').bind(roomId, participantId, clientId, now, now - 10_000),
    db.prepare('UPDATE rooms SET expires_at = ? WHERE id = ? AND expires_at < ?').bind(now + IDLE_MS, roomId, now + IDLE_MS - 10_000),
  ]);
}

export async function withRoom<T>(db: Database, id: string, operation: (room: Room, row: RoomRow, save: () => Promise<void>, renew: () => Promise<void>) => Promise<T>) {
  const lease = randomToken(16);
  let row: RoomRow | null = null;
  for (let attempt = 0; attempt < 25; attempt++) {
    const now = Date.now();
    row = await db.prepare('UPDATE rooms SET lease = ?, lock_until = ? WHERE id = ? AND lock_until < ? AND expires_at > ? RETURNING *').bind(lease, now + LEASE_MS, id, now, now).first<RoomRow>();
    if (row) break;
    await readRoom(db, id);
    await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 100));
  }
  if (!row) return fail(409, 'Another meeting action is in progress. Please try again.');
  const room: Room = JSON.parse(row.body);
  for (const ticket of room.stories) {
    for (const revision of ticket.revisions) {
      if (revision.status === 'pending') {
        revision.status = 'failed';
        revision.error = 'The previous write was interrupted. Sync Jira and retry if needed.';
      }
    }
  }
  const renew = async () => {
    const now = Date.now();
    const result = await db.prepare('UPDATE rooms SET lock_until = ?, expires_at = ? WHERE id = ? AND lease = ? AND lock_until > ?').bind(now + LEASE_MS, now + IDLE_MS, id, lease, now).run();
    if (!result.meta.changes) fail(409, 'The meeting action expired. Sync and try again.');
  };
  const save = async () => {
    const serialized = JSON.stringify(room);
    if (new TextEncoder().encode(serialized).byteLength > 1_500_000) fail(413, 'This meeting has too much data. Remove stories or start a new meeting.');
    const result = await db.prepare('UPDATE rooms SET body = ? WHERE id = ? AND lease = ? AND lock_until > ?').bind(serialized, id, lease, Date.now()).run();
    if (!result.meta.changes) fail(409, 'The meeting action expired. Sync and try again.');
  };
  try {
    const result = await operation(room, row, save, renew);
    await save();
    return result;
  } finally {
    await db.prepare('UPDATE rooms SET lease = NULL, lock_until = 0 WHERE id = ? AND lease = ?').bind(id, lease).run();
  }
}
