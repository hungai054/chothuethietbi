import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const APPS = ['web', 'admin', 'worker'];
export const CODE_RE = /^[a-z][a-z0-9-]{1,30}$/;

/** Các extension thật (thư mục extensions/<mã> có package.json; bỏ qua thư mục bắt đầu bằng "_"). */
export function listExtensionDirs() {
  const base = join(ROOT, 'extensions');
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_') && existsSync(join(base, d.name, 'package.json')))
    .map((d) => d.name)
    .sort();
}

const pkgName = (code) => `@rentpro-ext/${code}`;

/**
 * Đồng bộ danh sách extension vào các ứng dụng: file đăng ký sinh sẵn (nơi DUY NHẤT được import extension, ESLint cho phép đúng file này),
 * phụ thuộc workspace trong package.json và danh sách transpilePackages cho Next.
 */
export function syncExtensions() {
  const codes = listExtensionDirs();
  const changed = [];
  for (const app of APPS) {
    const dir = join(ROOT, 'apps', app);
    if (!existsSync(dir)) continue;
    const imports = codes.map((c, i) => `import ext${i} from '${pkgName(c)}';`).join('\n');
    const body = codes.length
      ? `import { getExtension, registerExtension } from '@rentpro/extension-sdk';\n${imports}\n\nfor (const d of [${codes.map((_, i) => `ext${i}`).join(', ')}]) if (!getExtension(d.manifest.code)) registerExtension(d);\n`
      : `export {};\n`;
    const file = join(dir, 'src', 'extensions.generated.ts');
    const text = `// TỰ SINH bởi \`pnpm ext:sync\` — đừng sửa tay. Đăng ký extension tại thời điểm build.\n${body}`;
    if (!existsSync(file) || readFileSync(file, 'utf8') !== text) { writeFileSync(file, text); changed.push(file); }

    const pj = join(dir, 'package.json');
    const j = JSON.parse(readFileSync(pj, 'utf8'));
    const deps = Object.fromEntries(Object.entries(j.dependencies ?? {}).filter(([k]) => !k.startsWith('@rentpro-ext/')));
    for (const c of codes) deps[pkgName(c)] = 'workspace:*';
    j.dependencies = Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)));
    const next = JSON.stringify(j, null, 2) + '\n';
    if (readFileSync(pj, 'utf8').replace(/\r\n/g, '\n') !== next) { writeFileSync(pj, next); changed.push(pj); }

    if (app !== 'worker') {
      const list = join(dir, 'extensions.json');
      const t = JSON.stringify(codes.map(pkgName), null, 2) + '\n';
      if (!existsSync(list) || readFileSync(list, 'utf8').replace(/\r\n/g, '\n') !== t) { writeFileSync(list, t); changed.push(list); }
    }
  }
  return { codes, changed };
}
