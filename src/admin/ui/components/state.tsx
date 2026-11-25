import { useEffect, useState } from 'react';
import { leftMin, plural } from '@/lib/format';
import type { Computer } from '@/lib/types';
import { cn } from '@/lib/utils';

/** Who drives a profile's browser: the control tab of docs/design.md. */
export type Driver = 'agent' | 'you' | 'recording' | 'waiting' | 'nobody' | 'stopped';

/** live: this page's own view of the profile, passed by the live view only (a list knows nothing of it). */
export function driverOf(c: Computer, live?: { control: boolean; recording: boolean }): Driver {
  if (live?.recording) return 'recording';
  if (c.handoff?.state === 'pending') return 'waiting';
  if (live?.control || c.handoff) return 'you';
  if (c.leasedUntil) return 'agent';
  return c.state === 'running' ? 'nobody' : 'stopped';
}

export const driverLabel = (d: Driver, c: Computer) => ({
  agent: 'An agent is driving', you: 'You have control', recording: 'You are recording', waiting: 'An agent is waiting',
  nobody: 'Nobody', stopped: c.state === 'none' ? 'Never started' : 'Stopped',
})[d];

const TOKEN: Record<Driver, string> = {
  agent: 'border-agent bg-agent-soft text-agent-ink',
  you: 'border-ink bg-line-soft text-ink',
  recording: 'border-ink bg-line-soft text-ink',
  waiting: 'border-needs-you bg-needs-you-soft text-needs-you-ink',
  nobody: 'border-line-strong text-ink-2',
  stopped: 'border-dashed border-line-strong text-ink-3',
};

/** One per table row: who drives, with the time left for an agent. */
export function DriverToken({ c }: { c: Computer }) {
  const d = driverOf(c);
  const left = d === 'agent' ? `, ${leftMin(c.leasedUntil!)} min` : d === 'waiting' ? `, ${leftMin(c.handoff!.deadline)} min left` : '';
  return <span className={cn('inline-flex h-6 items-center rounded-t-md border-b-2 px-2 text-[12.5px] font-semibold whitespace-nowrap', TOKEN[d])}>{driverLabel(d, c)}{left}</span>;
}

export function useNow(ms: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

/** The lease time left, mm:ss. */
export function LeaseClock({ until }: { until: string }) {
  const now = useNow(1000), s = Math.max(0, Math.round((Date.parse(until) - now) / 1000));
  const end = new Date(until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return <span className="font-medium tabular-nums opacity-80" title={`Renewed on every agent call, ends at ${end}`}>{String(Math.floor(s / 60)).padStart(2, '0')}:{String(s % 60).padStart(2, '0')}</span>;
}

export const stateNote = (c: Computer) => c.viewers ? plural(c.viewers, 'viewer')
  : c.state === 'running' && c.idleStopInS != null ? `Auto-stop in ${Math.ceil(c.idleStopInS / 60)} min`
  : !c.profile ? 'No saved data' : '';
