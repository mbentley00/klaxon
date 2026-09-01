// ---------------------------------------------------------------------------
// Transactional email: SMTP first, Resend as a fallback, and a clean no-op when
// neither is configured (callers then tell the user to email directly rather
// than pretending a message was sent).
//
// The environment variable names match the Buzzpoints app deliberately, so one
// set of mail credentials serves both.
// ---------------------------------------------------------------------------

import nodemailer from 'nodemailer';

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
// Must be a mailbox the mail server is willing to send as, or it gets rejected
// (or spam-filed).
const EMAIL_FROM = process.env.EMAIL_FROM || 'Klaxon <klaxon@doc-ent.com>';

// Where feedback lands.
export const FEEDBACK_TO = process.env.FEEDBACK_EMAIL || 'bentley.michael.j@gmail.com';

const smtpConfigured = () => !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
export const emailEnabled = () => smtpConfigured() || !!RESEND_API_KEY;

// One transport per process; feedback is low volume, so no pooling needed.
let tx = null;
const transport = () =>
  (tx ??= nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,   // 465 is implicit TLS; 587 upgrades via STARTTLS
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  }));

export async function sendEmail({ to, subject, html, text, replyTo }) {
  if (smtpConfigured()) {
    try {
      await transport().sendMail({ from: EMAIL_FROM, to, subject, html, text, ...(replyTo ? { replyTo } : {}) });
      return true;
    } catch (e) {
      console.warn('[email] smtp send failed:', e.message);
      tx = null;                 // a bad connection stays bad; reconnect next time
      if (!RESEND_API_KEY) return false;
    }
  }
  if (!RESEND_API_KEY) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: EMAIL_FROM, to, subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) })
    });
    if (!r.ok) {
      console.warn('[email] resend failed', r.status, await r.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[email] send error:', e.message);
    return false;
  }
}

const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

// The message is user-written: escaped, with newlines preserved by the style
// rather than by markup.
export const feedbackBody = ({ from, kind, page, message }) =>
  `<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;color:#17130d;line-height:1.5;max-width:520px">` +
  `<p><strong>${esc(from)}</strong> sent ${kind === 'bug' ? 'a bug report' : 'feedback'}` +
  `${page ? ` from <a href="${esc(page)}">${esc(page)}</a>` : ''}.</p>` +
  `<blockquote style="margin:0;padding:10px 14px;border-left:3px solid #ddd5c5;color:#333;white-space:pre-wrap">${esc(message)}</blockquote>` +
  `<hr style="border:none;border-top:1px solid #eee;margin:20px 0">` +
  `<p style="font-size:12px;color:#888">Klaxon</p></div>`;
