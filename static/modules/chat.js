export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

export function addChat(from, text, mine) {
  const chatMsgs = document.getElementById('chatMsgs');
  const div = document.createElement('div');
  div.className = 'msg' + (mine ? ' mine' : '');
  div.innerHTML = `<div class="from">${escapeHtml(from)}</div>${escapeHtml(text)}`;
  chatMsgs.appendChild(div);
  chatMsgs.scrollTop = chatMsgs.scrollHeight;
  if (!mine) window._onChatMsg?.();
}

export function wireChatForm(send) {
  const chatForm = document.getElementById('chatForm');
  const chatText = document.getElementById('chatText');
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const t = chatText.value.trim();
    if (!t) return;
    send({ type: 'chat', payload: JSON.stringify(t) });
    addChat('Вы', t, true);
    chatText.value = '';
  });
}
