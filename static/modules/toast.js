// Minimal toast notification system. Replaces alert() for non-blocking feedback.

let container = null;
function ensureContainer() {
  if (container) return container;
  container = document.createElement('div');
  container.className = 'toast-stack';
  document.body.appendChild(container);
  return container;
}

export function toast(message, { type = 'info', duration = 4000 } = {}) {
  const root = ensureContainer();
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.textContent = message;
  root.appendChild(el);
  // trigger enter animation on next frame
  requestAnimationFrame(() => el.classList.add('in'));
  const close = () => {
    el.classList.remove('in');
    el.classList.add('out');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  };
  el.addEventListener('click', close);
  setTimeout(close, duration);
  return close;
}

export const toastError = (m) => toast(m, { type: 'error', duration: 6000 });
export const toastOk = (m) => toast(m, { type: 'ok' });
