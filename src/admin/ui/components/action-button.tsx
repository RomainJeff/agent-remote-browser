import { useState, type ComponentProps } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { message } from '@/lib/format';

/** A button running one async action: busy while it runs, errors as a toast, `done` as a toast on success.
 *  The action returning false means cancelled: no success toast. */
export function ActionButton({ action, done, disabled, ...props }: Omit<ComponentProps<typeof Button>, 'onClick'> & { action: () => Promise<unknown>; done?: string }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { if (await action() !== false && done) toast(done); }
    catch (e) { toast.error(message(e)); }
    finally { setBusy(false); }
  };
  return <Button type="button" {...props} disabled={busy || disabled} aria-busy={busy || undefined} onClick={run} />;
}
