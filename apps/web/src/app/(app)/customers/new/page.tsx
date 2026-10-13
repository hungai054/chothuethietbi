import { createCustomer, listGroups } from '@rentpro/db';
import { Notice } from '@/components/ui';
import { run, withService } from '@/lib/service';
import { CustomerForm, customerFromForm } from '../customer-form';

export const dynamic = 'force-dynamic';

async function create(form: FormData) {
  'use server';
  await run('/customers/new', async () => {
    const id = await withService((c) => createCustomer(c, customerFromForm(form)));
    return `/customers/${id}?ok=${encodeURIComponent('Đã tạo khách hàng.')}`;
  });
}

export default async function NewCustomer({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const f = await searchParams;
  const groups = await withService((c) => listGroups(c));
  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <h1 className="text-2xl font-semibold">Thêm khách hàng</h1>
      <Notice error={f.error} />
      <CustomerForm action={create} groups={groups} submit="Tạo khách hàng" />
    </div>
  );
}
