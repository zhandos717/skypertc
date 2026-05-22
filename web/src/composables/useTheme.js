// Theme cycler: auto → dark → light → auto. Persisted in localStorage and
// applied via data-theme attribute on <html>. The body styles already react.
import { state } from '../stores/app.js';

const LS_KEY = 'skypertc.theme';

function apply(theme) {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  state.theme = theme;
  localStorage.setItem(LS_KEY, theme);
}

export function initTheme() {
  apply(localStorage.getItem(LS_KEY) || 'auto');
}

export function cycleTheme() {
  const cur = state.theme;
  const next = cur === 'auto' ? 'dark' : (cur === 'dark' ? 'light' : 'auto');
  apply(next);
}

export function themeLabel() {
  return state.theme === 'auto' ? 'авто' : (state.theme === 'dark' ? 'тёмная' : 'светлая');
}

export function useTheme() {
  return { initTheme, cycleTheme, themeLabel };
}
