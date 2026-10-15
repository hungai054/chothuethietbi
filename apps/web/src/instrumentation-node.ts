import { createReporter, safeUrl } from '@rentpro/core/sentry';

const reporter = createReporter({
  dsn: process.env.SENTRY_DSN, environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV, release: process.env.SENTRY_RELEASE, service: 'web',
});

const USER_ERRORS = /^(ValidationError|NotFoundError|ForbiddenError|ReadOnlyError|FeatureDisabledError|LimitExceededError|AvailabilityError|PlatformError)$/;
const CONTROL_FLOW = /^(NEXT_REDIRECT|NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK)/;

/** Chỉ chạy ở Node (cần node:crypto của @rentpro/core). Lỗi nghiệp vụ đã có thông báo tiếng Việt và chuyển hướng không báo. */
export async function report(err: unknown, request: { path: string; method: string }, context: { routePath?: string; routeType?: string }) {
  const digest = (err as { digest?: unknown } | null)?.digest;
  if (typeof digest === 'string' && CONTROL_FLOW.test(digest)) return;
  if (USER_ERRORS.test((err as Error | null)?.name ?? '')) return;
  await reporter.capture(err, { tags: { method: request.method, route: context.routePath ?? '', type: context.routeType ?? '' }, extra: { path: safeUrl(request.path) } });
}
