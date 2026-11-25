import { useEffect, useState, type ReactNode } from 'react';
import { leftMin } from '@/lib/format';
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

const TAB: Record<Driver, string> = {
  agent: 'border-agent bg-agent text-white',
  you: 'border-ink bg-ink text-white',
  recording: 'border-ink bg-ink text-white',
  waiting: 'border-dashed border-needs-you bg-needs-you-soft text-needs-you-ink',
  nobody: 'border-line-strong bg-surface-2 text-ink-2',
  stopped: 'border-dashed border-line-strong bg-surface text-ink-3',
};
const FRAME: Record<Driver, string> = {
  agent: 'border-agent', you: 'border-ink', recording: 'border-ink',
  waiting: 'border-dashed border-needs-you', nobody: 'border-line-strong', stopped: 'border-dashed border-line-strong',
};

/** The tab on top of a frame: who drives. It overlaps the frame's top border so the two read as one shape. */
export function ControlTab({ driver, children }: { driver: Driver; children: ReactNode }) {
  return <span className={cn('relative z-[1] -mb-0.5 inline-flex h-[30px] items-center gap-2.5 rounded-t-lg border-2 border-b-0 px-3 text-[13px] font-semibold', TAB[driver])}>{children}</span>;
}

export function ControlFrame({ driver, className, children }: { driver: Driver; className?: string; children: ReactNode }) {
  return <div className={cn('flex flex-col overflow-hidden rounded-xl rounded-tl-none border-2', FRAME[driver], className)}>{children}</div>;
}
