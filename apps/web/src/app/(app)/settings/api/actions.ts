'use server';
import { revalidatePath } from 'next/cache';
import { createApiKey, createWebhook, rotateWebhookSecret } from '@rentpro/db';
import { safe, withService } from '@/lib/service';

export interface SecretResult { error?: string; secret?: string; label?: string }

const insecure = () => process.env.WEBHOOK_ALLOW_PRIVATE === 'true';

/** Trả khóa/bí mật về cho client để hiện MỘT lần (không đưa lên URL, không lưu lại). */
export async function createKeyAction(_: SecretResult, f: FormData): Promise<SecretResult> {
  const days = Number(f.get('days') ?? 0);
  const r = await safe(() => withService((c) => createApiKey(c, {
    name: String(f.get('name') ?? ''), scopes: f.getAll('scopes').map(String),
    expiresAt: days > 0 ? new Date(Date.now() + days * 86_400_000) : null,
  })));
  if (!r.ok) return { error: r.error };
  revalidatePath('/settings/api');
  return { secret: r.data.key, label: 'Khóa API' };
}

export async function createWebhookAction(_: SecretResult, f: FormData): Promise<SecretResult> {
  const allow = insecure();
  const r = await safe(() => withService((c) => createWebhook(c, {
    url: String(f.get('url') ?? ''), description: String(f.get('description') ?? ''), events: f.getAll('events').map(String),
  }, { allowInsecure: allow })));
  if (!r.ok) return { error: r.error };
  revalidatePath('/settings/api');
  return { secret: r.data.secret, label: 'Bí mật ký webhook' };
}

export async function rotateSecretAction(id: string): Promise<SecretResult> {
  const r = await safe(() => withService((c) => rotateWebhookSecret(c, id)));
  if (!r.ok) return { error: r.error };
  revalidatePath('/settings/api');
  return { secret: r.data.secret, label: 'Bí mật ký webhook mới' };
}
