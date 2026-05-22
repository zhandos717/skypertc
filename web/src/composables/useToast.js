// Toast notifications. Backed by reactive list, rendered by ToastStack.vue.
import { reactive } from 'vue';

let nextId = 1;
export const toasts = reactive([]); // { id, message, type }

export function dismiss(id) {
  const i = toasts.findIndex(t => t.id === id);
  if (i >= 0) toasts.splice(i, 1);
}

export function toast(message, { type = 'info', duration = 4000 } = {}) {
  const id = nextId++;
  toasts.push({ id, message, type });
  if (duration > 0) setTimeout(() => dismiss(id), duration);
  return () => dismiss(id);
}

export const toastError = (m) => toast(m, { type: 'error', duration: 6000 });
export const toastOk = (m) => toast(m, { type: 'ok' });

export function useToast() {
  return { toast, toastError, toastOk, dismiss, toasts };
}
