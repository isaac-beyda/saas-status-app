/* Minimal SMTP client — no dependencies.
   Supports plain (port 25 / smtp_secure:"none"), STARTTLS (587) and
   implicit TLS (465), with AUTH LOGIN and AUTH PLAIN. Used by the
   alerting engine's email channel. Credentials live in alerts.json,
   which is gitignored; never log them. */
'use strict';

const net = require('node:net');
const tls = require('node:tls');

class SmtpError extends Error {}

function readLine(sock, buf, timeoutMs) {
  return new Promise((resolve, reject) => {
    /* Data may already be buffered from a previous multi-line reply. */
    const idx0 = buf.data.indexOf('\r\n');
    if (idx0 >= 0) {
      const line = buf.data.slice(0, idx0);
      buf.data = buf.data.slice(idx0 + 2);
      return resolve(line);
    }
    const timer = setTimeout(() => reject(new SmtpError('SMTP read timeout')), timeoutMs);
    const onData = (chunk) => {
      buf.data += chunk.toString('utf8');
      const idx = buf.data.indexOf('\r\n');
      if (idx >= 0) {
        const line = buf.data.slice(0, idx);
        buf.data = buf.data.slice(idx + 2);
        clearTimeout(timer);
        sock.off('data', onData);
        resolve(line);
      }
    };
    sock.on('data', onData);
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function readReply(sock, buf, timeoutMs) {
  /* Multi-line replies use "250-..." with a final "250 ..." line. */
  let last = '';
  for (;;) {
    const line = await readLine(sock, buf, timeoutMs);
    last = line;
    if (/^\d{3} /.test(line)) break;
    if (!/^\d{3}-/.test(line)) break;
  }
  return last;
}

async function cmd(sock, buf, text, expect, timeoutMs) {
  sock.write(text + '\r\n');
  const reply = await readReply(sock, buf, timeoutMs);
  const code = parseInt(reply.slice(0, 3), 10);
  if (expect && code !== expect) throw new SmtpError('SMTP ' + text.split(' ')[0] + ' failed: ' + reply);
  return reply;
}

async function sendMail(opts, mail, timeoutMs = 15000) {
  const host = opts.smtp_host;
  const port = opts.smtp_port || (opts.smtp_secure === 'tls' ? 465 : 587);
  const secure = opts.smtp_secure || (port === 465 ? 'tls' : 'starttls');
  return new Promise((resolve, reject) => {
    const done = (err, res) => { try { sock.destroy(); } catch {} if (err) reject(err); else resolve(res); };
    let sock = net.connect(port, host);
    const buf = { data: '' };
    sock.setTimeout(timeoutMs, () => done(new SmtpError('SMTP connect timeout')));
    sock.on('error', (e) => done(new SmtpError('SMTP connection failed: ' + e.message)));
    sock.on('connect', async () => {
      try {
        const banner = await readReply(sock, buf, timeoutMs);
        if (parseInt(banner.slice(0, 3), 10) !== 220) throw new SmtpError('SMTP banner: ' + banner);
        if (secure === 'tls') {
          sock = tls.connect({ socket: sock, servername: host });
          await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
        }
        await cmd(sock, buf, 'EHLO saas-status-app', 250, timeoutMs);
        if (secure === 'starttls') {
          await cmd(sock, buf, 'STARTTLS', 220, timeoutMs);
          sock = tls.connect({ socket: sock, servername: host });
          await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
          await cmd(sock, buf, 'EHLO saas-status-app', 250, timeoutMs);
        }
        if (opts.smtp_user) {
          const userB64 = Buffer.from(opts.smtp_user).toString('base64');
          const passB64 = Buffer.from(opts.smtp_pass || '').toString('base64');
          const authReply = await cmd(sock, buf, 'AUTH LOGIN', null, timeoutMs);
          if (parseInt(authReply.slice(0, 3), 10) === 334) {
            await cmd(sock, buf, userB64, 334, timeoutMs);
            await cmd(sock, buf, passB64, 235, timeoutMs);
          } else {
            throw new SmtpError('AUTH LOGIN rejected: ' + authReply);
          }
        }
        await cmd(sock, buf, 'MAIL FROM:<' + mail.from + '>', 250, timeoutMs);
        for (const to of mail.to) await cmd(sock, buf, 'RCPT TO:<' + to + '>', null, timeoutMs);
        await cmd(sock, buf, 'DATA', 354, timeoutMs);
        const body = [
          'From: ' + mail.from,
          'To: ' + mail.to.join(', '),
          'Subject: ' + mail.subject,
          'Date: ' + new Date().toUTCString(),
          'Content-Type: text/plain; charset=utf-8',
          '',
          mail.text,
          ''
        ].join('\r\n').replace(/\r?\n\./g, '\r\n..');
        sock.write(body + '.\r\n');
        await readReply(sock, buf, timeoutMs);
        await cmd(sock, buf, 'QUIT', 221, timeoutMs);
        done(null, { ok: true });
      } catch (e) {
        done(e instanceof SmtpError ? e : new SmtpError(String(e && e.message || e)));
      }
    });
  });
}

module.exports = { sendMail, SmtpError };
