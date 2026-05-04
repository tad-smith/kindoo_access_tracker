// Resend email wrapper. Same shape as `lib/messaging.ts` (FCM): a
// narrow `ResendSender` interface, a default sender that calls the
// real SDK, and an `_setSender` test hook so vitest can swap in a fake
// without a network round-trip.
//
// API key is read from `process.env.RESEND_API_KEY` lazily on first
// send. In production the env var is injected by Cloud Functions when
// the trigger declares `secrets: [RESEND_API_KEY]`. In tests the var
// is unset and the fake sender is wired before any real send fires.

import { Resend } from 'resend';

/**
 * Outbound email payload accepted by the wrapper. Mirrors the subset
 * of Resend's `emails.send` we use — plain text only for v1, no HTML,
 * no attachments. `replyTo` optional per Phase 9 plan.
 */
export type EmailPayload = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  replyTo?: string;
};

/**
 * Outcome of a single send. The wrapper deliberately mirrors Resend's
 * own `data | error` shape so tests can produce both branches without
 * synthesising SDK internals. `error.code` is defensive: the SDK
 * documents `error.name` but a few transports (network timeouts) only
 * surface a message string.
 */
export type SendResult =
  | { ok: true; id: string }
  | { ok: false; error: { message: string; code?: string } };

/** Surface the trigger consumes — narrower than the SDK so tests can stub it. */
export type ResendSender = {
  send(payload: EmailPayload): Promise<SendResult>;
};

let cachedClient: Resend | undefined;

function getClient(): Resend {
  if (cachedClient) return cachedClient;
  const apiKey = process.env['RESEND_API_KEY'];
  if (!apiKey) {
    throw new Error(
      'RESEND_API_KEY is not set. Bind the secret on the trigger options or set the env var locally.',
    );
  }
  cachedClient = new Resend(apiKey);
  return cachedClient;
}

const defaultSender: ResendSender = {
  send: async (payload) => {
    try {
      const client = getClient();
      const response = await client.emails.send({
        from: payload.from,
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
        ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
      });
      // Resend SDK returns `{ data, error }`; either may be null.
      if (response.error) {
        const err: { message: string; code?: string } = { message: response.error.message };
        if (response.error.name) err.code = response.error.name;
        return { ok: false, error: err };
      }
      const id = response.data?.id ?? '';
      return { ok: true, id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof Error ? err.name : undefined;
      const errPayload: { message: string; code?: string } = { message };
      if (code) errPayload.code = code;
      return { ok: false, error: errPayload };
    }
  },
};

let activeSender: ResendSender = defaultSender;

/** Active sender — production goes through the real Resend SDK. */
export function getResendSender(): ResendSender {
  return activeSender;
}

/** Test hook — replace the active sender. Returns a restore function. */
export function _setResendSender(sender: ResendSender): () => void {
  const prev = activeSender;
  activeSender = sender;
  return () => {
    activeSender = prev;
    // Drop cached SDK client too so a subsequent test that wants the
    // real path picks up a freshly-set RESEND_API_KEY.
    cachedClient = undefined;
  };
}
