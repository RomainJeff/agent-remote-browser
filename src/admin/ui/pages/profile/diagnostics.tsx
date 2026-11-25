import { useQuery } from '@tanstack/react-query';
import { Empty, Hint, Panel } from '@/components/page';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ago } from '@/lib/format';
import { detailsQuery } from '@/lib/queries';
import type { Computer } from '@/lib/types';

export function DiagnosticsTab({ c }: { c: Computer }) {
  const { data } = useQuery(detailsQuery(c.id));
  const audit = data?.audit ?? [], cookies = data?.cookies ?? [], storage = data?.storage ?? [];
  return (
    <div className="flex flex-col gap-4">
      <Panel title="Recent calls">
        {!audit.length ? <Empty>No calls.</Empty> : (
          <Table>
            <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Tool</TableHead><TableHead>Result</TableHead><TableHead>Duration</TableHead></TableRow></TableHeader>
            <TableBody>{audit.map((l, i) => (
              <TableRow key={i}>
                <TableCell className="whitespace-nowrap"><time dateTime={l.ts} title={l.ts}>{ago(l.ts)}</time></TableCell>
                <TableCell className="font-mono whitespace-nowrap">{l.tool}</TableCell>
                <TableCell className={l.ok ? 'font-semibold text-ok' : 'text-destructive-ink [overflow-wrap:anywhere]'}>{l.ok ? '✓ ok' : `✗ ${l.err || 'error'}`}</TableCell>
                <TableCell className="whitespace-nowrap">{l.ms != null ? `${l.ms} ms` : ''}</TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        )}
      </Panel>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] items-start gap-6">
        <Panel title="Cookies" aside={<Hint>Names only</Hint>}>
          {!cookies.length ? <Empty>No cookies stored.</Empty> : (
            <Table>
              <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Domain</TableHead><TableHead>Expires</TableHead><TableHead>Options</TableHead></TableRow></TableHeader>
              <TableBody>{cookies.map((k, i) => (
                <TableRow key={i}>
                  <TableCell className="font-mono whitespace-nowrap">{k.name}</TableCell>
                  <TableCell className="font-mono">{k.domain}</TableCell>
                  <TableCell className="whitespace-nowrap">{k.session || k.expires < 0 ? 'session' : new Date(k.expires * 1000).toLocaleDateString('en-GB')}</TableCell>
                  <TableCell>{[k.httpOnly && 'httpOnly', k.secure && 'secure'].filter(Boolean).join(' ')}</TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          )}
        </Panel>
        <Panel title="Local storage">
          {!storage.length ? <Empty>Nothing.</Empty> : (
            <Table>
              <TableHeader><TableRow><TableHead>Origin</TableHead><TableHead>Keys</TableHead></TableRow></TableHeader>
              <TableBody>{storage.map((o) => <TableRow key={o.origin}><TableCell className="font-mono">{o.origin}</TableCell><TableCell>{o.localStorageKeys}</TableCell></TableRow>)}</TableBody>
            </Table>
          )}
        </Panel>
      </div>
      <Hint>Container <span className="font-mono">{c.container} : {c.status}</span></Hint>
    </div>
  );
}
