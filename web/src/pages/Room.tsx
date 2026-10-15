import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { tabToken } from '../api.ts';
import { useAct, useEditStory } from '../room/act.ts';
import CustomTickets from '../room/CustomTickets.tsx';
import Deck from '../room/Deck.tsx';
import Editable from '../room/Editable.tsx';
import Panel from '../room/Panel.tsx';
import Results from '../room/Results.tsx';
import Stories from '../room/Stories.tsx';
import StoryDetails from '../room/StoryDetails.tsx';
import TicketPicker from '../room/TicketPicker.tsx';
import Wiki from '../room/Wiki.tsx';
import '../room/room.css';
import { useRoom } from '../useRoom.ts';
import { Ended, Join } from './Start.tsx';

export default function Room() {
  const { id = '' } = useParams();
  // The invite link (?join) always asks for a name, even in a browser that already holds the moderator's cookie.
  const [joining, setJoining] = useState(() => new URLSearchParams(location.search).has('join') && !tabToken(id));
  const { room, gone, reconnect } = useRoom(id, joining);
  const act = useAct();
  const edit = useEditStory();
  const [adding, setAdding] = useState(false);
  const [detailsId, setDetailsId] = useState<number | null>(null);
  const greeted = useRef('');

  // Once per room, the moderator gets the add dialog while there are no stories, else fresh Jira data.
  useEffect(() => {
    if (!room || room.me !== room.ownerId || greeted.current === room.id) return;
    greeted.current = room.id;
    if (!room.stories.length) setAdding(true);
    else if (room.mode === 'jira') act(`/api/rooms/${room.id}/sync`, {});
  }, [room]);

  if (joining || gone === 'join') {
    return (
      <Join
        id={id}
        onJoined={() => {
          setJoining(false);
          reconnect();
        }}
      />
    );
  }
  if (gone === 'ended') return <Ended />;
  if (!room) return null;

  const isMod = room.me === room.ownerId;
  const story = room.stories.find((s) => s.id === room.storyId);
  const details = room.stories.find((s) => s.id === detailsId);
  const about = story && (isMod || story.description) && (
    <div className="story-description">
      {isMod ? (
        <Editable label="Description" value={story.description} multiline onSave={(description) => edit(story, { description })}>
          {story.description ? <Wiki text={story.description} /> : <span className="muted">No description</span>}
        </Editable>
      ) : (
        <Wiki text={story.description} />
      )}
    </div>
  );

  return (
    <div className="room">
      <h1 className="room-name">Sprint planning</h1>
      <div className="room-grid">
        <div className="room-main">
          {/* Above both the deck and the results, so a flip mid-edit keeps the description draft. */}
          {story && (
            <h2 className="story-title">
              {story.url && <a href={story.url} target="_blank" rel="noreferrer">{story.key}</a>}{' '}
              <button className="story-open" onClick={() => setDetailsId(story.id)}>{story.summary}</button>
            </h2>
          )}
          {about}
          {room.round === 'revealed' || room.round === 'done' ? (
            <Results room={room} />
          ) : (
            <>
              {room.round === 'voting' || isMod ? (
                <Deck room={room} />
              ) : (
                <div className="waiting">
                  <span className="clock" />
                  <p>Waiting for moderator<br />to start the session</p>
                </div>
              )}
            </>
          )}
        </div>
        <Panel room={room} onAdd={() => setAdding(true)} />
        <Stories room={room} onAdd={() => setAdding(true)} onOpen={setDetailsId} />
      </div>
      {details && <StoryDetails room={room} story={details} onClose={() => setDetailsId(null)} />}
      {adding && room.mode === 'jira' && <TicketPicker room={room} onClose={() => setAdding(false)} />}
      {adding && room.mode === 'custom' && <CustomTickets room={room} onClose={() => setAdding(false)} />}
    </div>
  );
}
