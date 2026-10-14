import type { Page } from '@playwright/test';

/**
 * Gọi HTTP từ BÊN TRONG trình duyệt. Chrome tự phân giải *.localhost về máy bạn, còn `page.request` chạy bằng Node
 * và phụ thuộc bộ phân giải DNS của hệ điều hành (có máy phân giải được, có máy không).
 */
export async function pageFetch(page: Page, path: string) {
  return page.evaluate(async (p) => {
    const r = await fetch(p, { credentials: 'include', redirect: 'manual' });
    const bytes = Array.from(new Uint8Array(await r.arrayBuffer()));
    return { status: r.status, headers: Object.fromEntries(r.headers.entries()), bytes };
  }, path);
}
