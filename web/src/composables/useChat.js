// Chat: appends to store.chatMessages, fires badge for incoming when chat
// panel is not active.
import { state, wsSend } from '../stores/app.js';

export function addChat(from, text, mine) {
  state.chatMessages.push({ from, text, mine });
  if (!mine) {
    const chatActive = state.mobileTab === 'chat' || state.chatOpen;
    if (!chatActive) state.chatBadge = true;
  }
}

export function sendChat(text) {
  const t = String(text || '').trim();
  if (!t) return;
  wsSend({ type: 'chat', payload: JSON.stringify(t) });
  addChat('Вы', t, true);
}

export function useChat() {
  return { addChat, sendChat };
}
