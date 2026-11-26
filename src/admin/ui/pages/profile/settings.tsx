import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ActionButton } from '@/components/action-button';
import { confirmSensitive } from '@/components/confirm';
import { Section } from '@/components/page';
import { api } from '@/lib/api';
import { closeView } from '@/lib/live';
import { profilePath } from '@/lib/queries';

const CONSEQUENCES = 'Destroys the browser, its cookies, saved logins, OAuth access and API keys. This cannot be undone.';

export function SettingsTab({ id }: { id: string }) {
  const queryClient = useQueryClient(), navigate = useNavigate();
  return (
    <Section title="Delete profile" lead={CONSEQUENCES} actions={
      <ActionButton variant="outline" size="lg" done={`Profile ${id} deleted.`} action={async () => {
        if (!await confirmSensitive({ title: `Delete profile ${id}?`, desc: CONSEQUENCES, typed: id, label: 'Delete permanently', danger: true })) return false;
        closeView();
        await api(`${profilePath(id)}/delete`, 'POST');
        await navigate({ to: '/profiles' });
        await queryClient.invalidateQueries({ queryKey: ['computers'] });
      }}>Delete profile…</ActionButton>
    } />
  );
}
