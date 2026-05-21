// Document Picture-in-Picture: pop the entire .video-area into a floating window.
// Chrome 116+ only. Graceful no-op elsewhere.

let pipWindow = null;
let moved = []; // [{ el, parent, nextSibling }]

export function isDocPipSupported() {
  return 'documentPictureInPicture' in window;
}

export async function toggleDocPip() {
  if (!isDocPipSupported()) {
    throw new Error('Браузер не поддерживает Document PiP');
  }
  if (pipWindow) {
    pipWindow.close();
    return false;
  }

  const targets = [
    document.getElementById('videoArea'),
    document.getElementById('reactionsBar'),
    document.querySelector('.controls'),
  ].filter(Boolean);
  if (!targets.length) return false;

  const rect = targets[0].getBoundingClientRect();
  const width = Math.min(820, Math.max(400, Math.round(rect.width / 1.4)));
  const height = Math.round(width * 0.78); // include controls/reactions vertical space

  pipWindow = await window.documentPictureInPicture.requestWindow({ width, height });

  // Copy styles
  for (const link of document.querySelectorAll('link[rel="stylesheet"], style')) {
    pipWindow.document.head.appendChild(link.cloneNode(true));
  }
  pipWindow.document.body.style.margin = '0';
  pipWindow.document.body.style.background = '#05080f';
  pipWindow.document.body.style.height = '100vh';
  pipWindow.document.body.style.display = 'flex';
  pipWindow.document.body.style.flexDirection = 'column';
  pipWindow.document.body.style.color = '#e2e8f4';

  // Move each target preserving order; remember origin for restore.
  moved = [];
  for (const el of targets) {
    moved.push({ el, parent: el.parentNode, nextSibling: el.nextSibling });
    pipWindow.document.body.appendChild(el);
  }

  pipWindow.addEventListener('pagehide', () => {
    for (const m of moved) {
      try {
        if (m.nextSibling && m.nextSibling.parentNode === m.parent) {
          m.parent.insertBefore(m.el, m.nextSibling);
        } else {
          m.parent.appendChild(m.el);
        }
      } catch (e) { console.warn('PiP restore:', e); }
    }
    moved = [];
    pipWindow = null;
  }, { once: true });

  return true;
}
