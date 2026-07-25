import { useEffect } from 'react';

/** Close a modal on Escape — matches the flow-chart modal's behaviour. */
export function useEscapeToClose(onClose) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}
