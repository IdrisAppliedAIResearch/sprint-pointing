import { useParams } from 'react-router';
import { pointsLabel, type Revision, type RoomView, type Story } from '../../../shared/protocol.ts';
import { api } from '../api.ts';
import { useConfirm, useToast } from '../ui.tsx';

export function useAct() {
  const toast = useToast();
  return <T = void>(path: string, body?: unknown, done?: (result: T) => void, method?: string) =>
    api<T>(path, body, method).then(done, (e: Error) => toast(e.message, 'error'));
}

// Moves everyone to any story, estimated or not, and starts voting on it. Asks first only when that would drop votes
// already cast this round. Resolves whether it went ahead.
export function useVoteOn() {
  const act = useAct();
  const toast = useToast();
  const confirm = useConfirm();
  return async (room: RoomView, story: Story) => {
    const voted = (room.round === 'voting' || room.round === 'revealed') && room.players.some((p) => p.voted);
    if (voted && !(await confirm('Stop the current vote and vote on this story?', 'Vote'))) return false;
    act(`/api/rooms/${room.id}/start`, { storyId: story.id }, () => toast(room.round === 'idle' ? 'Session started' : 'Story changed'));
    return true;
  };
}

// One field per save: every Jira write notifies the ticket's watchers. Resolves whether it saved.
export function useEditStory() {
  const toast = useToast();
  const { id } = useParams();
  return (story: Story, changes: { summary: string } | { description: string }) =>
    api(`/api/rooms/${id}/stories/${story.id}`, changes, 'PATCH').then(
      () => (toast(story.key ? `Jira updated: ${story.key}` : 'Story updated'), true),
      (e: Error) => (toast(e.message, 'error'), false),
    );
}

export function useSetPoints() {
  const act = useAct();
  const toast = useToast();
  const { id } = useParams();
  return (story: Story, points: number | null) =>
    act<{ revision: Revision }>(`/api/rooms/${id}/stories/${story.id}/points`, { points }, ({ revision }) => {
      if (revision.status === 'failed') toast(`Jira update failed: ${revision.error}`, 'error');
      else toast(story.key ? `Jira updated: ${story.key} = ${pointsLabel(revision.to)}` : 'Story updated');
    });
}
