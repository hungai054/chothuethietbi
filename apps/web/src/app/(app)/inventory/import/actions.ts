'use server';

import { commitImport, previewImport, type ImportPreview } from '@rentpro/db';
import { safe, withService } from '@/lib/service';

export type ImportState =
  | { kind: 'idle' }
  | { kind: 'preview'; total: number; valid: number; errors: ImportPreview['errors']; sample: { row: number; model: string; barcode: string | null; serial: string | null }[] }
  | { kind: 'done'; created: number }
  | { kind: 'error'; message: string };

const MAX_BYTES = 5 * 1024 * 1024;

async function fileOf(form: FormData): Promise<ArrayBuffer | string> {
  const f = form.get('file');
  if (!(f instanceof File) || f.size === 0) return 'Hãy chọn file Excel (.xlsx).';
  if (f.size > MAX_BYTES) return 'File quá lớn (tối đa 5 MB).';
  return f.arrayBuffer();
}

export async function previewAction(_: ImportState, form: FormData): Promise<ImportState> {
  const file = await fileOf(form);
  if (typeof file === 'string') return { kind: 'error', message: file };
  const r = await safe(() => withService((c) => previewImport(c, file)));
  if (!r.ok) return { kind: 'error', message: r.error };
  if (r.data.fileError) return { kind: 'error', message: r.data.fileError };
  return {
    kind: 'preview', total: r.data.total, valid: r.data.valid, errors: r.data.errors.slice(0, 200),
    sample: r.data.items.slice(0, 10).map((i) => ({ row: i.row, model: i.item.model, barcode: i.item.barcode, serial: i.item.serial })),
  };
}

export async function commitAction(_: ImportState, form: FormData): Promise<ImportState> {
  const file = await fileOf(form);
  if (typeof file === 'string') return { kind: 'error', message: file };
  const r = await safe(() => withService((c) => commitImport(c, file)));
  return r.ok ? { kind: 'done', created: r.data.created } : { kind: 'error', message: r.error };
}
