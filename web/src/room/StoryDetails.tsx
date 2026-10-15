import { pointsLabel, type RoomView, type Story } from '../../../shared/protocol.ts';
import { External, History } from '../icons.tsx';
import { Modal, useConfirm, useToast } from '../ui.tsx';
import { useAct, useEditStory, useSetPoints } from './act.ts';
import Editable from './Editable.tsx';
import Wiki from './Wiki.tsx';

export default function StoryDetails({ room, story, onClose }: { room: RoomView; story: Story; onClose: () => void }) {
  const act = useAct();
  const toast = useToast();
  const confirm = useConfirm();
  const setPoints = useSetPoints();
  const isMod = room.me === room.ownerId;
  const jira = room.mode === 'jira';

  const edit = useEditStory();

  async function vote() {
    if ((room.round === 'voting' || room.round === 'revealed') && !(await confirm('Stop the current vote and vote on this story?', 'Vote'))) return;
    onClose();
    act(`/api/rooms/${room.id}/start`, { storyId: story.id }, () => toast('Session started'));
  }

  return (
    <Modal
      title="Story Details"
      onClose={onClose}
      footer={
        <>
          {isMod && <button className="btn btn-block" onClick={vote}>Vote on this story</button>}
          <button className="btn btn-outline btn-block" onClick={onClose}>Close</button>
        </>
      }
    >
      <dl className="details">
        {story.url && (
          <>
            <dt>Issue:</dt>
            <dd>
              <a href={story.url} target="_blank" rel="noreferrer">{story.key} <External size={16} /></a>
            </dd>
          </>
        )}
        <dt>Summary:</dt>
        <dd>{isMod ? <Editable label="Summary" value={story.summary} onSave={(summary) => edit(story, { summary })}>{story.summary}</Editable> : story.summary}</dd>
        {jira && (
          <>
            <dt>Type:</dt>
            <dd>{story.type}</dd>
            <dt>Status:</dt>
            <dd>{story.status}</dd>
            <dt>Jira points:</dt>
            <dd>{pointsLabel(story.jiraPoints)}</dd>
          </>
        )}
        <dt>Estimate:</dt>
        <dd>{pointsLabel(story.points)}</dd>
        {(isMod || story.description) && (
          <>
            <dt className="wide">Description:</dt>
            <dd className="wide">
              {isMod ? (
                <Editable label="Description" value={story.description} multiline onSave={(description) => edit(story, { description })}>
                  {story.description ? <Wiki text={story.description} /> : <span className="muted">No description</span>}
                </Editable>
              ) : (
                <Wiki text={story.description} />
              )}
            </dd>
          </>
        )}
      </dl>
      {story.revisions.length > 0 && (
        <>
          <h3 className="details-history"><History size={18} /> History</h3>
          <ul className="history">
            {story.revisions.map((r) => (
              <li key={r.id}>
                <span>
                  {pointsLabel(r.from)} → {pointsLabel(r.to)} · {r.by} ·{' '}
                  {new Date(r.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                  {jira && (
                    <>
                      {' · '}
                      <span className={`sync ${r.status}`}>
                        {r.status === 'synced' ? '✓ Saved to Jira' : r.status === 'pending' ? 'Saving…' : `Failed: ${r.error}`}
                      </span>
                    </>
                  )}
                </span>
                {isMod && r.status === 'synced' && r.from !== story.points && (
                  <button className="btn-link" onClick={() => setPoints(story, r.from)}>Revert to {pointsLabel(r.from)}</button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}

