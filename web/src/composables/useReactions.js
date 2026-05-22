// Floating-emoji reactions. Self reactions emit a transient overlay on the
// local tile (handled by VideoTile.vue via reactiveOverlay list). Remote
// reactions are routed by useSignaling/usePeers to the matching tile.
import { reactive } from 'vue';
import { state, internals, wsSend } from '../stores/app.js';

/** Per-peer-id (or 'self') queue of { id, emoji }. VideoTile listens. */
export const reactionOverlays = reactive(new Map());

let nextId = 1;
function push(target, emoji) {
  if (!reactionOverlays.has(target)) reactionOverlays.set(target, []);
  const list = reactionOverlays.get(target);
  const id = nextId++;
  list.push({ id, emoji });
  // Remove after animation (~2.4s).
  setTimeout(() => {
    const idx = list.findIndex(r => r.id === id);
    if (idx >= 0) list.splice(idx, 1);
  }, 2600);
}

export function showLocalReaction(emoji) {
  push('self', emoji);
  const msg = JSON.stringify({ type: 'react', emoji });
  let sent = 0;
  for (const dc of internals.events.values()) {
    if (dc && dc.readyState === 'open') {
      try { dc.send(msg); sent++; } catch {}
    }
  }
  if (sent === 0 && state.ws && state.ws.readyState === WebSocket.OPEN) {
    wsSend({ type: 'react', payload: JSON.stringify(emoji) });
  }
}

export function showRemoteReaction(peerId, emoji) {
  push(peerId, emoji);
}

export function useReactions() {
  return { showLocalReaction, showRemoteReaction, reactionOverlays };
}
