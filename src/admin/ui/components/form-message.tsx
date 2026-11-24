import { useEffect, useRef, useState, type FormEvent } from 'react';
import { message } from '@/lib/format';
import { cn } from '@/lib/utils';

/** A form submitted with one async call: its outcome shows next to the submit button, success fading after 3 s.
 *  The handler returns the success message; a thrown error shows as is. The form resets on success. */
export function useFormAction(handler: (data: FormData) => Promise<string>) {
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    clearTimeout(timer.current);
    setBusy(true);
    try {
      const text = await handler(new FormData(form));
      form.reset();
      setMsg({ text, error: false });
      timer.current = setTimeout(() => setMsg(null), 3000);
    } catch (err) { setMsg({ text: message(err), error: true }); }
    finally { setBusy(false); }
  };
  const status = <p aria-live="polite" className={cn('min-h-5 text-[13px] text-muted-foreground', msg?.error && 'font-semibold text-destructive-ink')}>{msg?.text}</p>;
  return { onSubmit, busy, status };
}
