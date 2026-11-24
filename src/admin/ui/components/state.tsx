import { Badge } from '@/components/ui/badge';
import { Hint } from '@/components/page';
import { leftMin, plural } from '@/lib/format';
import type { Computer } from '@/lib/types';

export function StatePill({ c }: { c: Computer }) {
  return <Badge dot variant={c.state === 'running' ? 'up' : 'muted'}>{c.state === 'running' ? 'Running' : c.state === 'none' ? 'Never started' : 'Stopped'}</Badge>;
}

export function LeasePill({ c }: { c: Computer }) {
  if (c.handoff) return <Badge dot variant="warn">{c.handoff.state === 'pending' ? 'Needs you' : 'With you'}</Badge>;
  if (c.leasedUntil) return <Badge dot variant="agent">Lease · {leftMin(c.leasedUntil)} min left</Badge>;
  return <Hint>No lease</Hint>;
}

export const stateNote = (c: Computer) => c.viewers ? plural(c.viewers, 'viewer')
  : c.state === 'running' && c.idleStopInS != null ? `Auto-stop in ${Math.ceil(c.idleStopInS / 60)} min`
  : !c.profile ? 'No saved data' : '';
