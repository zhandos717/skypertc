// Recent rooms (localStorage) + polled public rooms list.
import { state } from '../stores/app.js';

const LS_RECENT = 'skypertc.recent';

export function addRecent(name) {
  const i = state.recent.indexOf(name);
  if (i >= 0) state.recent.splice(i, 1);
  state.recent.unshift(name);
  state.recent = state.recent.slice(0, 10);
  localStorage.setItem(LS_RECENT, JSON.stringify(state.recent));
}

export async function refreshPublicRooms() {
  try {
    const r = await fetch('/rooms', { cache: 'no-store' });
    if (!r.ok) return;
    const list = await r.json();
    if (!Array.isArray(list)) return;
    list.sort((a, b) => b.count - a.count);
    state.publicRooms = list;
  } catch {}
}

let pollTimer = null;
export function startPolling() {
  refreshPublicRooms();
  if (!pollTimer) pollTimer = setInterval(refreshPublicRooms, 5000);
}
export function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

export function useRooms() {
  return { addRecent, refreshPublicRooms, startPolling, stopPolling };
}
