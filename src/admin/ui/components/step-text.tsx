import type { ReactNode } from 'react';
import type { Part } from '@/lib/playbook';

/** A step sentence (lib/playbook describeStep): code in mono, page elements in semibold, typed values and inputs as tokens. */
export function StepText({ parts }: { parts: Part[] }) {
  return <>{parts.map((p, i) => typeof p === 'string' ? <span key={i}>{p}</span>
    : 'code' in p ? <span key={i} className="font-mono text-[12.5px] [overflow-wrap:anywhere]">{p.code}</span>
    : 'el' in p ? <b key={i} className="font-semibold [overflow-wrap:anywhere]">{p.el}</b>
    : 'val' in p ? <span key={i} className="rounded-sm bg-line-soft px-1 font-mono text-[12.5px] [overflow-wrap:anywhere]">{p.val}</span>
    : <InputToken key={i} name={p.input} />)}</>;
}

/** An input the agent fills: the agent's color (docs/design.md). */
export const InputToken = ({ name }: { name: string }) => <span className="rounded-sm bg-agent-soft px-1 font-mono text-[12.5px] text-agent-ink">{`{${name}}`}</span>;

/** A numbered step row (recorder, playbook detail). No n: a dashed circle, for what is not a step yet. */
export function NumberedStep({ n, action, children }: { n?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-start gap-2.5 border-b border-line-soft py-2.5 text-[13.5px] leading-5 last:border-b-0">
      {n ? <i className="grid size-[22px] place-items-center rounded-full bg-line-soft text-[11.5px] font-semibold not-italic tabular-nums">{n}</i>
        : <i className="size-[22px] rounded-full border border-dashed border-line-strong" />}
      <span className="min-w-0">{children}</span>
      {action}
    </li>
  );
}
