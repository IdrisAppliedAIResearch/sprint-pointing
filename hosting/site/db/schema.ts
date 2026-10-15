import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const rooms = sqliteTable('rooms', {
  id: text('id').primaryKey(),
  body: text('body').notNull(),
  credential: text('credential'),
  expiresAt: integer('expires_at').notNull(),
  lease: text('lease'),
  lockUntil: integer('lock_until').notNull().default(0),
}, (table) => [index('rooms_expiry').on(table.expiresAt)]);

export const presence = sqliteTable('presence', {
  roomId: text('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade' }),
  participantId: integer('participant_id').notNull(),
  clientId: text('client_id').notNull(),
  seenAt: integer('seen_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.roomId, table.participantId, table.clientId] }),
  index('presence_seen').on(table.roomId, table.seenAt),
]);
