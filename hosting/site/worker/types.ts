import type { Revision, Round, Story } from '../shared/protocol.ts';

export type Statement = {
  bind(...values: unknown[]): Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
};

export type Database = {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<unknown[]>;
  withSession?(constraint: string): Database;
};

export type Environment = {
  DB: Database;
  JIRA_URL: string;
  JIRA_BOARD_ID: string;
  JIRA_POINTS_FIELD: string;
  JIRA_PROJECT_KEY: string;
  SPRINT_SESSION_KEY: string;
};

export type Participant = { id: number; name: string; tokenHash: string; observer: boolean };
export type Ticket = Omit<Story, 'url'> & { votes: Record<string, { value: string; at: number }> };
export type Room = {
  id: string;
  cards: string[];
  moderator: number;
  participants: Participant[];
  stories: Ticket[];
  round: Round;
  storyId: number | null;
  timerStart: number | null;
  timerStop: number | null;
  jira: boolean;
  seq: { story: number; revision: number };
};

export type RoomRow = { id: string; body: string; credential: string | null; expires_at: number; lease: string | null; lock_until: number };
export function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}
