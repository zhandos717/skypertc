const recent = JSON.parse(localStorage.getItem('skypertc.recent') || '[]');

export function renderRecent() {
  const recentList = document.getElementById('recent');
  recentList.innerHTML = '';
  recent.slice(0, 6).forEach(r => {
    const li = document.createElement('li');
    li.innerHTML = `<div class="avatar small">#</div><div><div class="name">${r}</div><div class="sub">Комната</div></div>`;
    li.onclick = () => { document.getElementById('roomInput').value = r; };
    recentList.appendChild(li);
  });
}

export function addRecent(name) {
  const i = recent.indexOf(name);
  if (i >= 0) recent.splice(i, 1);
  recent.unshift(name);
  localStorage.setItem('skypertc.recent', JSON.stringify(recent.slice(0, 10)));
  renderRecent();
}

export async function refreshPublicRooms() {
  const publicRoomsEl = document.getElementById('publicRooms');
  try {
    const r = await fetch('/rooms', { cache: 'no-store' });
    if (!r.ok) return;
    const list = await r.json();
    publicRoomsEl.innerHTML = '';
    if (!list || !list.length) {
      publicRoomsEl.innerHTML = '<li class="empty">Пока никого</li>';
      return;
    }
    list.sort((a, b) => b.count - a.count);
    for (const item of list) {
      const li = document.createElement('li');
      const initial = (item.name || '#').charAt(0).toUpperCase();
      li.innerHTML = `<div class="avatar small">${initial}</div>
        <div style="flex:1"><div class="name">${item.name}</div><div class="sub">${item.count} в комнате</div></div>
        <span class="count-pill">${item.count}</span>`;
      li.onclick = () => {
        document.getElementById('roomInput').value = item.name;
        document.getElementById('publicChk').checked = true;
      };
      publicRoomsEl.appendChild(li);
    }
  } catch {}
}

export function initRooms() {
  renderRecent();
  refreshPublicRooms();
  setInterval(refreshPublicRooms, 5000);
}
