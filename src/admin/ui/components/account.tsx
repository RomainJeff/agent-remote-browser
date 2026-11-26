import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { LogOutIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { gatewayAdminQuery, sessionQuery } from '@/lib/session';
import { cn } from '@/lib/utils';

/** A member's initials in a grey circle. Dashed and empty for someone invited who has not joined yet. */
export const Avatar = ({ email, invited, className }: { email: string; invited?: boolean; className?: string }) => (
  <span aria-hidden className={cn('grid size-7 flex-none place-items-center rounded-full bg-line text-[11px] font-bold text-ink',
    invited && 'border border-dashed border-line-strong bg-transparent', className)}>{invited ? '' : email.slice(0, 2).toUpperCase()}</span>
);

export function useSignOut() {
  const queryClient = useQueryClient(), navigate = useNavigate();
  return async () => {
    await api('/api/auth/sign-out', 'POST');
    queryClient.clear();
    await navigate({ to: '/login' });
  };
}

/** Phone only: the avatar in the header bar opens a sheet with the account and Sign out (the sidebar holds them on desktop). */
export function AccountButton() {
  const { data: session } = useQuery(sessionQuery);
  const { data: gatewayAdmin } = useQuery(gatewayAdminQuery);
  const signOut = useSignOut();
  const [open, setOpen] = useState(false);
  const email = session?.email ?? '';
  return (
    <>
      <button type="button" className="-my-2 -mr-2 ml-auto grid size-11 flex-none place-items-center min-[900px]:hidden" aria-label="Account" onClick={() => setOpen(true)}>
        <Avatar email={email} />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false}
          className="top-auto bottom-0 left-0 max-w-none translate-x-0 translate-y-0 gap-[18px] rounded-b-none px-4 pt-5 pb-[calc(28px+env(safe-area-inset-bottom))] sm:max-w-none data-open:zoom-in-100 data-open:slide-in-from-bottom-4">
          <div className="flex items-center gap-3">
            <Avatar email={email} className="size-10 text-[13px]" />
            <div className="flex min-w-0 flex-col">
              <DialogTitle className="truncate text-[15px] font-semibold">{email}</DialogTitle>
              <span className="text-[13px] text-ink-3">{gatewayAdmin ? 'Admin' : 'Member'}</span>
            </div>
          </div>
          <Button variant="outline" className="h-11 text-[15px]" onClick={signOut}><LogOutIcon />Sign out</Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
