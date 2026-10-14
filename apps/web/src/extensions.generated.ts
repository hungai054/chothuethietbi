// TỰ SINH bởi `pnpm ext:sync` — đừng sửa tay. Đăng ký extension tại thời điểm build.
import { getExtension, registerExtension } from '@rentpro/extension-sdk';
import ext0 from '@rentpro-ext/demo-weekend';

for (const d of [ext0]) if (!getExtension(d.manifest.code)) registerExtension(d);
