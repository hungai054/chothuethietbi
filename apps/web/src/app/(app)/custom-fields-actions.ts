'use server';

import type { FieldEntity } from '@rentpro/core';
import { listFieldDefs, setCustomFile, setCustomValues } from '@rentpro/db';
import { okUrl, readCustomForm } from '@/lib/forms';
import { run, withService } from '@/lib/service';

/** Lưu trường tùy chỉnh của một bản ghi (giá trị + tệp đính kèm) trong một giao dịch. */
export async function saveCustomFieldsAction(entity: FieldEntity, id: string, back: string, f: FormData) {
  await run(back, async () => {
    // Đọc nội dung các tệp trước khi vào giao dịch (không giữ File trong closure của server action)
    const uploads = new Map<string, { data: Uint8Array; name: string }>();
    for (const [k, v] of f.entries()) {
      if (k.startsWith('cffile_') && typeof v !== 'string' && v.size > 0) uploads.set(k.slice(7), { data: new Uint8Array(await v.arrayBuffer()), name: v.name });
    }
    await withService(async (c) => {
      const defs = await listFieldDefs(c, entity);
      await setCustomValues(c, entity, id, readCustomForm(f, defs));
      for (const d of defs.filter((x) => x.kind === 'FILE')) {
        const up = uploads.get(d.key);
        if (up) await setCustomFile(c, entity, id, d.key, up);
        else if (f.get(`cfdel_${d.key}`) === 'on') await setCustomFile(c, entity, id, d.key, null);
      }
    });
    return okUrl(back, 'Đã lưu trường tùy chỉnh.');
  });
}
