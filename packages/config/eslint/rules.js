const TENANT_PROPS = new Set(['slug', 'tenantId', 'tenant_id', 'tenantSlug', 'tenantCode']);

function propName(node) {
  if (!node) return null;
  if (node.type === 'ChainExpression') return propName(node.expression);
  if (node.type === 'MemberExpression') {
    if (!node.computed && node.property.type === 'Identifier') return node.property.name;
    if (node.computed && node.property.type === 'Literal') return String(node.property.value);
  }
  if (node.type === 'Identifier') return node.name;
  return null;
}

// `tenant.id` / `ctx.tenant.id` cũng tính; `user.id` thì không.
function isTenantRef(node) {
  if (node.type === 'ChainExpression') return isTenantRef(node.expression);
  const p = propName(node);
  if (p && TENANT_PROPS.has(p)) return true;
  if (node.type === 'MemberExpression' && p === 'id') {
    const base = propName(node.object);
    return base !== null && /^tenant$/i.test(base);
  }
  return false;
}

const isStringy = (n) =>
  (n.type === 'Literal' && typeof n.value === 'string') || (n.type === 'TemplateLiteral' && n.expressions.length === 0);

export const noHardcodedTenant = {
  meta: {
    type: 'problem',
    messages: {
      hardcoded:
        'Không so sánh với slug/ID tenant cụ thể trong code lõi. Dùng cấu hình, cờ tính năng (can) hoặc extension.',
    },
    schema: [],
  },
  create(context) {
    const report = (node) => context.report({ node, messageId: 'hardcoded' });
    return {
      BinaryExpression(node) {
        if (!['===', '!==', '==', '!='].includes(node.operator)) return;
        if ((isTenantRef(node.left) && isStringy(node.right)) || (isTenantRef(node.right) && isStringy(node.left))) report(node);
      },
      SwitchStatement(node) {
        if (isTenantRef(node.discriminant) && node.cases.some((c) => c.test && isStringy(c.test))) report(node);
      },
      CallExpression(node) {
        const c = node.callee;
        if (c.type !== 'MemberExpression' || propName(c.property) === null) return;
        const name = c.property.name;
        // ['abc','def'].includes(tenant.slug)
        if (name === 'includes' && c.object.type === 'ArrayExpression' && node.arguments[0] && isTenantRef(node.arguments[0]) &&
            c.object.elements.some((e) => e && isStringy(e))) report(node);
        // tenant.slug.startsWith('abc') / endsWith / includes
        if (['startsWith', 'endsWith', 'includes'].includes(name) && isTenantRef(c.object) && node.arguments[0] && isStringy(node.arguments[0])) report(node);
      },
    };
  },
};

const EXT_RE = /(^|\/)extensions\/|^@rentpro-ext\//;

export const noExtensionImport = {
  meta: {
    type: 'problem',
    messages: { forbidden: 'Code lõi không được import từ extensions/*. Extension phải đăng ký qua registry của SDK.' },
    schema: [],
  },
  create(context) {
    const check = (node, src) => {
      if (typeof src === 'string' && EXT_RE.test(src)) context.report({ node, messageId: 'forbidden' });
    };
    return {
      ImportDeclaration: (n) => check(n, n.source.value),
      ExportNamedDeclaration: (n) => n.source && check(n, n.source.value),
      ExportAllDeclaration: (n) => check(n, n.source.value),
      ImportExpression: (n) => n.source.type === 'Literal' && check(n, n.source.value),
      CallExpression: (n) => {
        if (n.callee.type === 'Identifier' && n.callee.name === 'require' && n.arguments[0]?.type === 'Literal') check(n, n.arguments[0].value);
      },
    };
  },
};
