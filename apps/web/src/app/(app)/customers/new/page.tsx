import { createCustomer, listFieldDefs, listGroups, setCustomValues } from '@rentpro/db';
import { CustomFieldInputs } from '@/components/custom-fields';
import { readCustomForm } from '@/lib/forms';
import { Notice } from '@/components/ui';
import { run, withService } from '@/lib/service';
import { CustomerForm, customerFromForm } from '../customer-form';

export const dynamic = 'force-dynamic';

async function create(form: FormData) {
  'use server';
  await run('/customers/new', async () => {
    const id = await withService(async (c) => {
      const id = await createCustomer(c, customerFromForm(form));
      const defs = await listFieldDefs(c, 'CUSTOMER');
      if (defs.length) await setCustomValues(c, 'CUSTOMER', id, readCustomForm(form, defs), true);
      return id;
    });
    return `/customers/${id}?ok=${encodeURIComponent('Đã tạo khách hàng.')}`;
  });
}

export default async function NewCustomer({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const f = await searchParams;
  const { groups, defs } = await withService(async (c) => ({ groups: await listGroups(c), defs: await listFieldDefs(c, 'CUSTOMER') }));
  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <h1 className="text-2xl font-semibold">Thêm khách hàng</h1>
      <Notice error={f.error} />
      <CustomerForm action={create} groups={groups} submit="Tạo khách hàng" extra={<CustomFieldInputs defs={defs} />} />
    </div>
  );
}
