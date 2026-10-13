'use client';

import { useState, useTransition } from 'react';
import { commitAction, previewAction, type ImportState } from './actions';
import { btn, btnGhost, card } from '@/components/ui';

const idle: ImportState = { kind: 'idle' };

export function ImportForm() {
  // Giữ File trong state: form của React tự xóa ô chọn file sau mỗi lần gửi, nên bước "Nhập" sẽ mất file nếu đọc từ <input>.
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<ImportState>(idle);
  const [validated, setValidated] = useState<{ valid: number } | null>(null);
  const [pending, start] = useTransition();

  const send = (kind: 'preview' | 'commit') => {
    if (!file) return setState({ kind: 'error', message: 'Hãy chọn file Excel (.xlsx).' });
    const fd = new FormData();
    fd.set('file', file);
    start(async () => {
      const r = await (kind === 'preview' ? previewAction(idle, fd) : commitAction(idle, fd));
      setState(r);
      if (r.kind === 'preview') setValidated(r.errors.length === 0 && r.valid > 0 ? { valid: r.valid } : null);
      else if (r.kind === 'done') setValidated(null);
    });
  };

  return (
    <div className={`${card} space-y-4`}>
      <input
        type="file" accept=".xlsx" className="block w-full text-sm" aria-label="File Excel"
        onChange={(e) => { setFile(e.target.files?.[0] ?? null); setState(idle); setValidated(null); }}
      />
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => send('preview')} disabled={pending || !file} className={btnGhost}>{pending ? 'Đang xử lý…' : 'Xem trước & kiểm tra'}</button>
        <button type="button" onClick={() => send('commit')} disabled={pending || !validated} className={btn}>Nhập {validated ? `${validated.valid} ` : ''}thiết bị</button>
      </div>
      {state.kind === 'error' && <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">{state.message}</p>}
      {state.kind === 'done' && <p role="status" className="rounded bg-green-50 p-3 text-sm text-green-700">Đã nhập {state.created} thiết bị. <a className="underline" href="/inventory">Xem danh sách</a></p>}
      {state.kind === 'preview' && (
        <div className="space-y-3 text-sm">
          <p>Tổng {state.total} dòng: <b className="text-green-700">{state.valid} hợp lệ</b>, <b className={state.errors.length ? 'text-red-700' : ''}>{new Set(state.errors.map((e) => e.row)).size} dòng lỗi</b>.
            {state.errors.length > 0 && ' Sửa file rồi kiểm tra lại: hệ thống chỉ nhập khi không còn lỗi.'}</p>
          {state.errors.length > 0 && (
            <table className="w-full text-left"><thead className="text-slate-500"><tr><th>Dòng</th><th>Cột</th><th>Lỗi</th></tr></thead>
              <tbody>{state.errors.map((e, i) => <tr key={i} className="border-t"><td className="py-1">{e.row}</td><td>{e.field}</td><td className="text-red-700">{e.message}</td></tr>)}</tbody></table>
          )}
          {state.sample.length > 0 && (
            <details><summary className="cursor-pointer text-slate-600">Xem 10 dòng hợp lệ đầu tiên</summary>
              <ul className="mt-1">{state.sample.map((s) => <li key={s.row}>Dòng {s.row}: {s.model}{s.serial ? ` · ${s.serial}` : ''}{s.barcode ? ` · ${s.barcode}` : ' · mã tự sinh'}</li>)}</ul></details>
          )}
        </div>
      )}
    </div>
  );
}
