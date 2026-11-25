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
