import { Router, Request, Response, NextFunction } from 'express';
import { processWebhook } from '../services/gmail.service';
import { logEvent } from '../services/monitoring.service';

const router = Router();

// Trim a multiline stack to the top 10 frames — enough to identify the call
// site, short enough to keep SystemLog.details rows compact.
function shortenStack(err: unknown): string | undefined {
  if (!(err instanceof Error) || !err.stack) return undefined;
  return err.stack.split('\n').slice(0, 10).join('\n');
}

// Best-effort extraction of the Pub/Sub notification payload so handler
// errors carry enough breadcrumbs to debug after the fact.
function extractNotification(body: unknown): {
  emailAddress?: string;
  historyId?: string;
} {
  try {
    const message = (body as { message?: { data?: string } } | undefined)?.message;
    if (!message?.data) return {};
    const decoded = Buffer.from(message.data, 'base64').toString('utf-8');
    const parsed = JSON.parse(decoded) as { emailAddress?: string; historyId?: string };
    return {
      emailAddress: parsed.emailAddress,
      historyId: parsed.historyId,
    };
  } catch {
    return {};
  }
}

// POST /api/webhooks/gmail — Google Cloud Pub/Sub push endpoint.
//
// Always returns 200 so Pub/Sub doesn't retry. The actual sync work runs
// after we've ack'd, and any error inside it lands in SystemLog as
// WEBHOOK_HANDLER_ERROR (instead of disappearing into Vercel's truncated
// runtime logs). The dashboard sync-health tile surfaces a 24h count of
// these so silent drops are visible.
router.post('/gmail', async (req: Request, res: Response, _next: NextFunction) => {
  try {
    if (!req.body?.message?.data) {
      res.status(200).json({ success: true, message: 'No data' });
      return;
    }

    const body = req.body;
    // Fire-and-forget so we ack Pub/Sub quickly (its push deadline is 10s
    // by default and classification + Claude can take longer). Errors are
    // logged to SystemLog inside the catch.
    void processWebhook(body).catch(async (err: unknown) => {
      const notification = extractNotification(body);
      console.error('[Webhook] Gmail processing error:', err);
      await logEvent(
        'WEBHOOK_HANDLER_ERROR',
        {
          error: err instanceof Error ? err.message : String(err),
          stack: shortenStack(err),
          emailAddress: notification.emailAddress,
          historyId: notification.historyId,
        },
        'ERROR'
      );
    });

    res.status(200).json({ success: true });
  } catch (err) {
    // Synchronous failure before we even kicked off processWebhook
    // (JSON parsing, etc.). Log + still 200 to silence Pub/Sub retries.
    const notification = extractNotification(req.body);
    await logEvent(
      'WEBHOOK_HANDLER_ERROR',
      {
        error: err instanceof Error ? err.message : String(err),
        stack: shortenStack(err),
        emailAddress: notification.emailAddress,
        historyId: notification.historyId,
        phase: 'pre-dispatch',
      },
      'ERROR'
    );
    res.status(200).json({ success: true });
  }
});

export default router;
