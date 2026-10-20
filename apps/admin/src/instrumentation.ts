/** Next gọi hàm này cho mọi lỗi không xử lý khi render/route/server action; báo lên Sentry khi có SENTRY_DSN (xem docs/VAN_HANH.md). */
export async function onRequestError(
  err: unknown,
  request: { path: string; method: string },
  context: { routePath?: string; routeType?: string; routerKind?: string },
) {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || !process.env.SENTRY_DSN) return;
  const { report } = await import('./instrumentation-node');
  await report(err, request, context);
}
