import { useEffect, useState } from 'react';
import type { RoomView } from '../../shared/protocol.ts';
import { serverConfig, tabToken } from './api.ts';

export function useRoom(id: string, paused: boolean) {
  const [room, setRoom] = useState<RoomView | null>(null);
  const [gone, setGone] = useState<'join' | 'ended' | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (paused) return;
    const token = tabToken(id);
    const headers: Record<string, string> = token ? { 'x-participant': token } : {};
    let ws: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout>;
    let delay = 1000;
    let stopped = false;
    let polling = false;
    let inFlight = false;
    let requested = false;
    const controller = new AbortController();
    const clientId = crypto.randomUUID();
    const leave = () => {
      if (polling) void fetch(`/api/rooms/${id}/leave`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ clientId }), keepalive: true }).catch(() => {});
    };
    const poll = async () => {
      if (stopped) return;
      if (inFlight) {
        requested = true;
        return;
      }
      inFlight = true;
      let next = 750;
      let terminal = false;
      try {
        const response = await fetch(`/api/rooms/${id}/live?client=${clientId}`, { cache: 'no-store', headers, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
        if (stopped) return;
        if (response.status === 401 || response.status === 404) {
          setGone(response.status === 401 ? 'join' : 'ended');
          terminal = true;
          return;
        }
        if (!response.ok) throw new Error('Meeting temporarily unavailable');
        const view = await response.json();
        if (stopped) return;
        setRoom(view);
        setGone(null);
        delay = 1000;
      } catch {
        next = delay;
        delay = Math.min(delay * 2, 10000);
      } finally {
        inFlight = false;
        if (!stopped && !terminal) {
          clearTimeout(timer);
          timer = setTimeout(poll, requested ? 0 : next);
          requested = false;
        }
      }
    };
    const wake = () => {
      if (!polling) return;
      clearTimeout(timer);
      void poll();
    };
    const connect = () => {
      // A WebSocket can't carry headers: a joined tab offers its token as the second protocol.
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/rooms/${id}/live`, token ? ['participant', token] : []);
      ws.onmessage = (e) => {
        delay = 1000;
        setGone(null);
        setRoom(JSON.parse(e.data));
      };
      ws.onclose = (e) => {
        if (e.code === 4401) setGone('join');
        else if (e.code === 4404) setGone('ended');
        else {
          timer = setTimeout(connect, delay);
          delay = Math.min(delay * 2, 10000);
        }
      };
    };
    const initialize = () => {
      void serverConfig().then((config) => {
        if (stopped) return;
        polling = config.transport === 'poll';
        if (polling) void poll();
        else connect();
      }).catch(() => {
        if (!stopped) timer = setTimeout(initialize, 1000);
      });
    };
    window.addEventListener('room-changed', wake);
    window.addEventListener('pagehide', leave);
    initialize();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
      window.removeEventListener('room-changed', wake);
      window.removeEventListener('pagehide', leave);
      leave();
      if (ws) {
        ws.onmessage = ws.onclose = null;
        ws.close();
      }
    };
  }, [id, attempt, paused]);

  return { room, gone, reconnect: () => setAttempt((n) => n + 1) };
}
