// End-to-end smoke test through the MCP gateway, like Notion would call it.
// Usage: TOKEN=acp_... node smoke.mjs   (profile token from the admin UI; gateway running)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL(process.env.GATEWAY || 'http://localhost:18787/mcp');
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${process.env.TOKEN}` } } }));

const call = async (name, args = {}) => {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  console.log(name, r.isError ? 'refused' : 'ok', Date.now()-t0, 'ms');
  return r;
};

console.log('tools:', (await client.listTools()).tools.map((t) => t.name).join(', '));
await call('open', { url: 'https://example.com' });
await call('snapshot');
await call('open', { url: 'https://wikipedia.org' });           // refused by gateway
await call('click', { ref: '@e1' });                             // follows link to iana.org -> DNS-blocked
await call('get_text');
await call('screenshot');
await call('login', { site: 'herokuapp-demo' });
await call('get_text');
await client.close();
