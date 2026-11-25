import { useQuery } from '@tanstack/react-query';
import { CircleAlertIcon } from 'lucide-react';
import { Empty, Panel, Section } from '@/components/page';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ago } from '@/lib/format';
import { detailsQuery } from '@/lib/queries';
import type { Computer } from '@/lib/types';

const duration = (ms: number) => ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;

export function DiagnosticsTab({ c }: { c: Computer }) {
  const { data } = useQuery(detailsQuery(c.id));
  const audit = data?.audit ?? [], cookies = data?.cookies ?? [], storage = data?.storage ?? [];
  return (
    <div className="flex flex-col gap-8">
      <Section title="Recent calls">
        <Panel>
          {!audit.length ? <Empty>No calls yet.</Empty> : (
            <Table>
              <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Tool</TableHead><TableHead>Result</TableHead><TableHead>Duration</TableHead></TableRow></TableHeader>
              <TableBody>{audit.map((l, i) => (
                <TableRow key={i}>
                  <TableCell className="whitespace-nowrap"><time dateTime={l.ts} title={new Date(l.ts).toLocaleString('en-GB')}>{ago(l.ts)}</time></TableCell>
                  <TableCell className="font-mono text-[13px] whitespace-nowrap">{l.tool}</TableCell>
                  <TableCell className="[overflow-wrap:anywhere]">{l.ok ? 'OK' : <span className="inline-flex items-start gap-1.5 font-medium"><CircleAlertIcon aria-hidden className="mt-0.5 size-4 flex-none" />Failed{l.err ? `, ${l.err}` : ''}</span>}</TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">{l.ms != null ? duration(l.ms) : ''}</TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          )}
        </Panel>
      </Section>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] items-start gap-6">
        <Section title="Cookies" lead="Names only.">
          <Panel>
            {!cookies.length ? <Empty>No cookies stored.</Empty> : (
              <Table>
                <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Domain</TableHead><TableHead>Expires</TableHead><TableHead>Flags</TableHead></TableRow></TableHeader>
                <TableBody>{cookies.map((k, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-[13px] whitespace-nowrap">{k.name}</TableCell>
                    <TableCell className="font-mono text-[13px]">{k.domain}</TableCell>
                    <TableCell className="whitespace-nowrap">{k.session || k.expires < 0 ? 'Session' : new Date(k.expires * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</TableCell>
                    <TableCell>{[k.httpOnly && 'httpOnly', k.secure && 'secure'].filter(Boolean).join(', ')}</TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
            )}
          </Panel>
        </Section>
        <Section title="Local storage">
          <Panel>
            {!storage.length ? <Empty>Nothing stored.</Empty> : (
              <Table>
                <TableHeader><TableRow><TableHead>Origin</TableHead><TableHead>Keys</TableHead></TableRow></TableHeader>
                <TableBody>{storage.map((o) => <TableRow key={o.origin}><TableCell className="font-mono text-[13px]">{o.origin}</TableCell><TableCell className="tabular-nums">{o.localStorageKeys}</TableCell></TableRow>)}</TableBody>
              </Table>
            )}
          </Panel>
        </Section>
      </div>
      <p className="text-[13px] text-ink-3">Container <span className="font-mono">{c.container}</span>, {c.status}</p>
    </div>
  );
}
