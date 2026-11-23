import { request } from 'node:http';

/** Exercise virtual-host routing over real HTTP; fetch may replace the supplied Host header. */
export function requestWithHost(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  let body: string | undefined;
  if (typeof init.body === 'string') body = init.body;
  else if (init.body instanceof URLSearchParams) body = init.body.toString();
  else if (init.body != null) throw new TypeError('Test HTTP helper supports only text or URLSearchParams bodies');
  return new Promise((resolve, reject) => {
    const outgoing = request(new URL(url), { method: init.method ?? 'GET', headers: Object.fromEntries(headers) }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('error', reject);
      incoming.on('end', () => {
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          responseHeaders.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
        }
        const status = incoming.statusCode ?? 500;
        const empty = init.method === 'HEAD' || [204, 205, 304].includes(status);
        resolve(new Response(empty ? null : new Uint8Array(Buffer.concat(chunks)), {
          status, statusText: incoming.statusMessage, headers: responseHeaders,
        }));
      });
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}
