import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ago } from '@/lib/format';
import { detailsQuery } from '@/lib/queries';
import type { Computer } from '@/lib/types';
import { LiveView } from './live-view';
import { Recorder } from './recorder';

/** The view on the left, what the agent did on the right. */
export function SessionTab({ c }: { c: Computer }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_300px] gap-6 max-[1180px]:grid-cols-1">
      <LiveView c={c} />
      <aside className="flex min-w-0 flex-col gap-4 min-[1181px]:border-l min-[1181px]:pl-5" aria-label="Activity">
        <Recorder id={c.id} />
        <Activity id={c.id} />
      </aside>
    </div>
  );
}

function Activity({ id }: { id: string }) {
  const { data } = useQuery(detailsQuery(id));
  const calls = data?.audit.slice(0, 8) ?? [];
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13.5px] font-semibold">Activity</h2>
        {calls.length > 0 && <Link to="/profiles/$id" params={{ id }} search={{ tab: 'diagnostics' }} className="text-[13px] text-ink-2 underline-offset-2 hover:underline">See all</Link>}
      </div>
      {!calls.length ? (
        <p className="text-[13px] text-ink-3">No calls yet. <Link to="/access" className="font-medium text-ink underline underline-offset-2">Connect an agent</Link></p>
      ) : (
        <ol>
          {calls.map((l, i) => (
            <li key={i} className="grid grid-cols-[72px_minmax(0,1fr)] gap-2.5 border-b border-line-soft py-2 text-[13.5px] leading-[19px] last:border-b-0">
              <time className="text-[12.5px] text-ink-3 tabular-nums" dateTime={l.ts} title={new Date(l.ts).toLocaleString('en-GB')}>{ago(l.ts)}</time>
              <span className="min-w-0 [overflow-wrap:anywhere]"><span className="font-mono text-[12.5px]">{l.tool}</span>{!l.ok && <span className="text-ink-2">, failed</span>}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
