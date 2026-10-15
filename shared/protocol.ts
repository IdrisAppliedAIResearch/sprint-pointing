export const DECKS = {
  scrum: { name: 'Scrum', cards: ['0', '½', '1', '2', '3', '5', '8', '13', '20', '40', '100', '?', '☕'] },
  fibonacci: { name: 'Fibonacci', cards: ['0', '1', '2', '3', '5', '8', '13', '21', '34', '55', '89', '?', '☕'] },
  sequential: { name: 'Sequential', cards: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '?', '☕'] },
} as const;

export type DeckId = keyof typeof DECKS;

// Story points a card stands for: null for ? and ☕ (coffee).
export function cardPoints(card: string): number | null {
  if (card === '½') return 0.5;
  return /^\d+$/.test(card) ? Number(card) : null;
}

// The deck's cards from min to max points, plus ? and ☕.
export function rangeCards(deck: DeckId, min: number, max: number) {
  return DECKS[deck].cards.filter((card) => {
    const points = cardPoints(card);
    return points === null || (min <= points && points <= max);
  });
}

export function pointsLabel(points: number | null): string {
  return points === null ? '—' : points === 0.5 ? '½' : String(points);
}

export type Round = 'idle' | 'voting' | 'revealed' | 'done';

export type Revision = {
  id: number;
  from: number | null;
  to: number | null;
  by: string;
  at: number;
  status: 'pending' | 'synced' | 'failed';
  error: string | null;
};

export type Story = {
  id: number;
  key: string | null; // null for custom tickets
  summary: string;
  description: string; // Jira wiki markup for Jira tickets
  type: string;
  status: string;
  url: string | null;
  jiraPoints: number | null; // last known value in Jira
  points: number | null; // the team's estimate
  revisions: Revision[]; // newest first
};

export type Player = {
  id: number;
  name: string;
  online: boolean;
  observer: boolean;
  voted: boolean;
  vote: string | null; // hidden (null) until reveal, except your own
  votedAt: number | null;
};

export type RoomView = {
  id: string;
  mode: 'jira' | 'custom';
  cards: string[];
  ownerId: number;
  me: number;
  now: number; // server clock, to correct client skew
  round: Round;
  storyId: number | null;
  timerStart: number | null;
  timerStop: number | null;
  players: Player[];
  stories: Story[];
};

export type Sprint = { id: string; name: string; state: 'active' | 'future' };

export type Issue = {
  key: string;
  summary: string;
  description: string;
  type: string;
  status: string;
  assignee: string | null;
  points: number | null;
};
