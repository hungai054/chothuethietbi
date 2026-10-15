'use client';
import { useActionState, useState } from 'react';
import { btn, btnGhost, card, input } from '@/components/ui';
import { createKeyAction, createWebhookAction, rotateSecretAction, type SecretResult } from './actions';

export interface Opt { value: string; label: string }

function SecretBox({ r }: { r: SecretResult }) {
  return (
    <>
      {r.error && <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">{r.error}</p>}
      {r.secret && (
        <div className="space-y-1 rounded border border-amber-300 bg-amber-50 p-3 text-sm" data-testid="secret-box">
          <p><b>{r.label}</b> chỉ hiện MỘT lần. Hãy sao chép và cất giữ cẩn thận:</p>
          <code className="block break-all rounded bg-white p-2 font-mono" data-testid="secret-value">{r.secret}</code>
        </div>
      )}
    </>
  );
}

export function KeyForm({ scopes }: { scopes: Opt[] }) {
  const [r, act, pending] = useActionState(createKeyAction, {});
  return (
    <form action={act} className={`${card} space-y-3`} data-testid="key-form">
      <h2 className="font-medium">Tạo khóa API</h2>
      <SecretBox r={r} />
      <label className="block text-sm">Tên khóa (*)<input name="name" required maxLength={80} placeholder="VD: Website đặt lịch" className={`${input} mt-1 max-w-sm`} /></label>
      <fieldset className="space-y-1 text-sm"><legend className="mb-1">Phạm vi quyền (*)</legend>
        {scopes.map((s) => <label key={s.value} className="flex items-center gap-2"><input type="checkbox" name="scopes" value={s.value} /> <code>{s.value}</code> {s.label}</label>)}
      </fieldset>
      <label className="block text-sm">Hết hạn sau (ngày, bỏ trống = không hết hạn)<input name="days" type="number" min={1} max={3650} className={`${input} mt-1 max-w-[10rem]`} /></label>
      <button className={btn} disabled={pending}>Tạo khóa</button>
    </form>
  );
}

export function WebhookForm({ events }: { events: Opt[] }) {
  const [r, act, pending] = useActionState(createWebhookAction, {});
  return (
    <form action={act} className={`${card} space-y-3`} data-testid="webhook-form">
      <h2 className="font-medium">Thêm địa chỉ nhận webhook</h2>
      <SecretBox r={r} />
      <label className="block text-sm">Địa chỉ HTTPS (*)<input name="url" required placeholder="https://example.com/hooks/rentpro" className={`${input} mt-1`} /></label>
      <label className="block text-sm">Mô tả<input name="description" maxLength={200} className={`${input} mt-1`} /></label>
      <fieldset className="space-y-1 text-sm"><legend className="mb-1">Sự kiện (*)</legend>
        {events.map((e) => <label key={e.value} className="flex items-center gap-2"><input type="checkbox" name="events" value={e.value} defaultChecked /> <code>{e.value}</code> {e.label}</label>)}
      </fieldset>
      <button className={btn} disabled={pending}>Thêm webhook</button>
    </form>
  );
}

export function RotateButton({ id }: { id: string }) {
  const [r, setR] = useState<SecretResult | null>(null);
  return (
    <div className="space-y-2">
      <button type="button" className={btnGhost} onClick={async () => { if (confirm('Đổi bí mật ký? Bí mật cũ sẽ ngừng hiệu lực ngay.')) setR(await rotateSecretAction(id)); }}>Đổi bí mật ký</button>
      {r && <SecretBox r={r} />}
    </div>
  );
}
