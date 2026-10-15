import { useState } from 'react';
import type { RoomView } from '../../../shared/protocol.ts';
import { Modal } from '../ui.tsx';
import { useAct } from './act.ts';

export default function CustomTickets({ room, onClose }: { room: RoomView; onClose: () => void }) {
  const act = useAct();
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const tickets = text.split('\n').map((line) => line.trim()).filter(Boolean);

  function add() {
    setAdding(true);
    act(`/api/rooms/${room.id}/stories`, { tickets }, onClose).finally(() => setAdding(false));
  }

  return (
    <Modal
      title="Add Custom Tickets"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-block" disabled={!tickets.length || adding} onClick={add}>Add Tickets</button>
          <button className="btn btn-outline btn-block" onClick={onClose}>Cancel</button>
        </>
      }
    >
      <textarea
        className="input textarea"
        placeholder="Put your tickets here. Each line contains a new ticket."
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
      />
    </Modal>
  );
}
