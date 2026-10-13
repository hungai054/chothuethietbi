import {
  ForbiddenError, type Permission,
} from '@rentpro/core';
import { assertCan, type FeatureKey, type Limits, type ResolvedFeatures } from '@rentpro/tenancy';
import type { Db } from './client';

/** Mọi service nghiệp vụ nhận ngữ cảnh này: kiểm tra quyền, gói và chế độ chỉ đọc ở đây, không chỉ ở UI. */
export interface ServiceCtx {
  db: Db; // transaction đã đặt app.tenant_id
  tenantId: string;
  tenantStatus: string;
  userId: string | null;
  permissions: ReadonlySet<Permission>;
  features: ResolvedFeatures;
  limits: Limits;
  barcodePattern?: string;
}

export class ReadOnlyError extends Error {
  constructor() {
    super('Tài khoản đang ở chế độ chỉ đọc hoặc bị tạm khóa. Bạn chỉ xem và xuất dữ liệu được.');
    this.name = 'ReadOnlyError';
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`Không tìm thấy ${what}.`);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function guard(ctx: ServiceCtx, perm: Permission, feature: FeatureKey, opts: { write?: boolean } = {}) {
  if (!ctx.permissions.has(perm)) throw new ForbiddenError(perm);
  assertCan(ctx.features, feature);
  if (opts.write && (ctx.tenantStatus === 'READ_ONLY' || ctx.tenantStatus === 'SUSPENDED')) throw new ReadOnlyError();
}

export async function audit(ctx: ServiceCtx, action: string, entity: string, entityId: string, data: object = {}) {
  await ctx.db.query('INSERT INTO audit_log(tenant_id,user_id,action,entity,entity_id,data) VALUES ($1,$2,$3,$4,$5,$6)', [
    ctx.tenantId, ctx.userId, action, entity, entityId, JSON.stringify(data),
  ]);
}
