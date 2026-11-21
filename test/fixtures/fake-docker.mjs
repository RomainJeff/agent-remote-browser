// Fake `docker` CLI: appends its argv to $FAKE_DOCKER_LOG (one JSON array per line) and prints canned output.
// Containers "exist" once a `run --name X` is in the log. Stdin is only read for --password-stdin, and only its
// sha256 is logged, so tests can prove the password travelled through stdin without writing it anywhere.
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const LOG = process.env.FAKE_DOCKER_LOG;
if (!LOG) { console.error('FAKE_DOCKER_LOG not set'); process.exit(2); }
const args = process.argv.slice(2);
const calls = existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
appendFileSync(LOG, JSON.stringify(args) + '\n');
const created = (name) => calls.some((c) => c[0] === 'run' && c[c.indexOf('--name') + 1] === name);
const ok = (data) => process.stdout.write(JSON.stringify({ success: true, data }));

const [cmd] = args;
if (cmd === 'inspect') {
  const name = args.at(-1);
  if (!created(name)) { process.stderr.write(`Error: No such object: ${name}\n`); process.exit(1); }
  process.stdout.write(args[2].includes('NetworkMode') ? 'true none\n' : 'true\n');
} else if (cmd === 'run') {
  process.stdout.write('0123456789ab\n');
} else if (cmd === 'exec') {
  const i = args.indexOf('agent-browser');
  if (i < 0) process.exit(0); // cat / rm / node relay
  const rest = args.slice(i + 1);
  while (rest[0]?.startsWith('--')) rest.splice(0, rest[0] === '--json' ? 1 : 2); // --json, --profile X, --restore X, --args X
  if (rest.includes('--password-stdin'))
    appendFileSync(LOG, JSON.stringify(['#stdin-sha256', createHash('sha256').update(readFileSync(0)).digest('hex')]) + '\n');
  const [op, sub] = rest;
  const origin = 'https://example.com';
  if (op === 'open') ok({ title: 'Fake page', url: rest[1] });
  else if (op === 'get' && sub === 'url') ok({ url: origin + '/' });
  else if (op === 'get' && sub === 'title') ok({ title: 'Fake page' });
  else if (op === 'get' && sub === 'text') ok({ origin, text: 'hello' });
  else if (op === 'snapshot') ok({ origin, snapshot: '- button "OK" [ref=e1]' });
  else if (op === 'stream') ok({ port: 9223 });
  else ok({});
}
// ps, volume ls, start, stop, rm...: empty output, exit 0.
