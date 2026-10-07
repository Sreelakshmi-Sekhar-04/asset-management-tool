import net from 'node:net';

export interface SunkMail { from: string; to: string[]; data: string }

/**
 * A minimal SMTP server for tests: accepts mail on a local port and keeps it in memory, so the
 * worker's real nodemailer path (connect, MAIL FROM, RCPT TO, DATA) is exercised end to end.
 * Recipients listed in `refuse` get a 550, like a mail server rejecting an address.
 */
export async function smtpSink(opts: { refuse?: string[] } = {}) {
  const mails: SunkMail[] = [];
  const server = net.createServer((sock) => {
    let from = '', to: string[] = [], data = '', inData = false, buf = '';
    const say = (s: string) => sock.write(`${s}\r\n`);
    say('220 sink ESMTP');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; mails.push({ from, to, data }); from = ''; to = []; data = ''; say('250 OK queued'); }
          else data += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') say('250 sink');
        else if (cmd === 'MAIL') { from = /<(.*)>/.exec(line)?.[1] ?? ''; say('250 OK'); }
        else if (cmd === 'RCPT') {
          const addr = /<(.*)>/.exec(line)?.[1] ?? '';
          if (opts.refuse?.includes(addr.toLowerCase())) say('550 5.1.1 No such user');
          else { to.push(addr); say('250 OK'); }
        }
        else if (cmd === 'DATA') { inData = true; say('354 End data with <CR><LF>.<CR><LF>'); }
        else if (cmd === 'RSET') { from = ''; to = []; say('250 OK'); }
        else if (cmd === 'QUIT') { say('221 Bye'); sock.end(); }
        else say('250 OK');
      }
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return { port, url: `smtp://127.0.0.1:${port}`, mails, close: () => new Promise<void>((r) => server.close(() => r())) };
}
