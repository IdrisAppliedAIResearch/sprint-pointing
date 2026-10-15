import { useParams } from 'react-router';
import { pointsLabel, type Revision, type Story } from '../../../shared/protocol.ts';
import { api } from '../api.ts';
import { useToast } from '../ui.tsx';

export function useAct() {
  const toast = useToast();
  return <T = void>(path: string, body?: unknown, done?: (result: T) => void, method?: string) =>
    api<T>(path, body, method).then(done, (e: Error) => toast(e.message, 'error'));
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
