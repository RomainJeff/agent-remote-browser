import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ActionButton } from '@/components/action-button';
import { confirmSensitive } from '@/components/confirm';
import { Panel } from '@/components/page';
import { api } from '@/lib/api';
import { closeView } from '@/lib/live';
import { profilePath } from '@/lib/queries';

const CONSEQUENCES = 'The container, cookies, saved logins, OAuth access and API keys of this profile are destroyed. This cannot be undone.';

export function SettingsTab({ id }: { id: string }) {
  const queryClient = useQueryClient(), navigate = useNavigate();
  return (
    <Panel pad danger title="Danger zone">
      <div className="flex flex-wrap items-center gap-4">
        <div className="min-w-0 flex-[1_1_280px]"><b>Delete profile</b><p className="text-muted-foreground">{CONSEQUENCES}</p></div>
        <ActionButton variant="danger" size="lg" done={`Profile ${id} deleted.`} action={async () => {
          if (!await confirmSensitive({ title: `Delete profile "${id}"?`, desc: CONSEQUENCES, typed: id, label: 'Delete permanently', danger: true })) return false;
          closeView();
          await api(`${profilePath(id)}/delete`, 'POST');
          await navigate({ to: '/profiles' });
          await queryClient.invalidateQueries({ queryKey: ['computers'] });
        }}>Delete profile</ActionButton>
      </div>
    </Panel>
  );
}
