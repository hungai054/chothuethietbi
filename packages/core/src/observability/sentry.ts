/**
 * Báo lỗi lên Sentry (hoặc dịch vụ tương thích như GlitchTip) KHÔNG cần SDK: dựng envelope theo giao thức công khai và gửi bằng fetch.
 * Chỉ bật khi có SENTRY_DSN. Tuyệt đối không làm hỏng luồng chính: mọi lỗi khi gửi đều bị nuốt. Dữ liệu nhạy cảm bị lược bỏ trước khi gửi.
 */
export interface Dsn { key: string; url: string; projectId: string }

export function parseDsn(raw: string | undefined | null): Dsn | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    const projectId = u.pathname.split('/').filter(Boolean).pop();
    if (!u.username || !projectId || !/^https?:$/.test(u.protocol)) return null;
    const prefix = u.pathname.split('/').filter(Boolean).slice(0, -1).join('/');
    return { key: u.username, projectId, url: `${u.protocol}//${u.host}${prefix ? `/${prefix}` : ''}/api/${projectId}/envelope/` };
  } catch { return null; }
}

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[_-]?key|master_?key|signature|id_?number|phone|email|otp|totp/i;

/** Xóa giá trị của khóa nhạy cảm (đệ quy, giới hạn độ sâu) và cắt chuỗi dài */
export function scrub(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (typeof value !== 'object') return value;
  if (depth >= 4) return '[quá sâu]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 40).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? '[đã ẩn]' : scrub(v, depth + 1)]));
}

/** Bỏ chuỗi truy vấn (có thể chứa token) khỏi URL */
export const safeUrl = (u: string): string => { try { const x = new URL(u, 'http://x'); return x.pathname; } catch { return u.split('?')[0] ?? ''; } };

export interface CaptureContext { tags?: Record<string, string>; extra?: Record<string, unknown>; level?: 'error' | 'warning' | 'fatal' }

export function buildEvent(err: unknown, ctx: CaptureContext, meta: { environment: string; release?: string; service: string }, now = new Date(), id = crypto.randomUUID().replace(/-/g, '')) {
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'Lỗi không xác định');
  return {
    event_id: id,
    timestamp: now.getTime() / 1000,
    platform: 'node',
    level: ctx.level ?? 'error',
    environment: meta.environment,
    ...(meta.release ? { release: meta.release } : {}),
    server_name: meta.service,
    tags: { service: meta.service, ...ctx.tags },
    exception: { values: [{ type: e.name, value: e.message.slice(0, 1000), stacktrace: { frames: stackFrames(e.stack) } }] },
    extra: scrub(ctx.extra ?? {}),
  };
}

function stackFrames(stack: string | undefined) {
  // Sentry muốn khung cũ nhất trước
  return (stack ?? '').split('\n').slice(1, 40).map((l) => ({ filename: l.trim().replace(/^at\s+/, '').slice(0, 300) })).reverse();
}

export function buildEnvelope(event: { event_id: string; timestamp: number }, dsnRaw: string): string {
  const header = { event_id: event.event_id, sent_at: new Date(event.timestamp * 1000).toISOString(), dsn: dsnRaw };
  const body = JSON.stringify(event);
  return `${JSON.stringify(header)}\n${JSON.stringify({ type: 'event', length: new TextEncoder().encode(body).length })}\n${body}`;
}

export interface ReporterOptions {
  dsn?: string | null; environment?: string; release?: string; service: string;
  fetchImpl?: typeof fetch; now?: () => Date;
  /** Tối đa số sự kiện mỗi phút (mặc định 20) và thời gian gộp lỗi trùng (mặc định 60 giây) */
  maxPerMinute?: number; dedupeSeconds?: number;
}

export interface Reporter { enabled: boolean; capture(err: unknown, ctx?: CaptureContext): Promise<boolean> }

export function createReporter(o: ReporterOptions): Reporter {
  const dsn = parseDsn(o.dsn);
  const doFetch = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const sent: number[] = [];
  const seen = new Map<string, number>();
  const max = o.maxPerMinute ?? 20;
  const dedupeMs = (o.dedupeSeconds ?? 60) * 1000;
  return {
    enabled: dsn !== null,
    async capture(err, ctx = {}) {
      if (!dsn) return false;
      try {
        const now = (o.now ?? (() => new Date()))();
        const t = now.getTime();
        while (sent.length && t - sent[0]! > 60_000) sent.shift();
        const fp = `${err instanceof Error ? `${err.name}:${err.message}` : String(err)}`.slice(0, 200);
        for (const [k, at] of seen) if (t - at > dedupeMs) seen.delete(k);
        if (sent.length >= max || seen.has(fp)) return false;
        sent.push(t);
        seen.set(fp, t);
        const event = buildEvent(err, ctx, { environment: o.environment ?? 'production', release: o.release, service: o.service }, now);
        const auth = `Sentry sentry_version=7, sentry_key=${dsn.key}, sentry_client=rentpro/1.0`;
        const r = await doFetch(dsn.url, { method: 'POST', headers: { 'content-type': 'application/x-sentry-envelope', 'x-sentry-auth': auth }, body: buildEnvelope(event, o.dsn!) });
        return r.ok;
      } catch { return false; }
    },
  };
}
