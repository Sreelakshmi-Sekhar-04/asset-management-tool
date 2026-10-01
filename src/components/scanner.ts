'use client';
import { useApi } from './api';

/** FR-REG-09: keyboard-wedge scanners type then send Enter or Tab; advance focus on the configured key. */
export function useScannerAdvance() {
  const { data } = useApi<{ scannerAdvanceKey: 'Enter' | 'Tab' }>('/api/settings/public');
  const key = data?.scannerAdvanceKey ?? 'Enter';
  return (e: React.KeyboardEvent<HTMLInputElement>, next?: () => void) => {
    if (e.key === key) {
      e.preventDefault();
      if (next) next();
      else {
        const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[data-scan]'));
        const i = inputs.indexOf(e.currentTarget);
        inputs[i + 1]?.focus();
      }
    }
  };
}
