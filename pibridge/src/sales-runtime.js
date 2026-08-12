// Loads admin-authored "sales.js" (CoreSettings.ai_sales_code) — same trust model
// as helpdesk-runtime.js. System-agnostic ERP quotations (Odoo Sales, etc.).
import vm from "node:vm";

export function loadSales(code, config, context) {
  if (!code || !code.trim()) return null;
  const exportsObj = {};
  const sandbox = {
    exports: exportsObj,
    module: { exports: exportsObj },
    sales: {
      baseUrl: (config?.base_url || "").replace(/\/+$/, ""),
      apiKey: config?.api_key || "",
      context: context || {},
    },
    // Alias so copy-pasted helpdesk-style code that expects `helpdesk` still works.
    helpdesk: {
      baseUrl: (config?.base_url || "").replace(/\/+$/, ""),
      apiKey: config?.api_key || "",
      context: context || {},
    },
    fetch,
    console: { log: () => {}, error: () => {}, warn: () => {} },
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Buffer,
    atob,
    btoa,
    setTimeout,
    clearTimeout,
    JSON,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { timeout: 5000, filename: "sales.js" });

  const ex = sandbox.module.exports && Object.keys(sandbox.module.exports).length
    ? sandbox.module.exports
    : sandbox.exports;
  const operations = ex.operations || {};
  const names = Object.keys(operations).filter((k) => typeof operations[k] === "function");
  if (!names.length) throw new Error("sales.js defined no exports.operations functions");
  return {
    operations,
    names,
    meta: ex.meta || {},
    mutating: new Set(ex.mutating || names),
    opClasses: ex.opClasses || {},
    apiKey: sandbox.sales.apiKey,
  };
}
