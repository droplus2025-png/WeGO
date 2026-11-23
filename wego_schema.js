/* wego_schema.js — structure of the local database (IndexedDB).
   Conventions:
   - every record has a uuid `id` (except meta/settings which use `key`)
   - money = integer cents (1 DH = 100); quantity = integer in units of 1/QTY_SCALE
   - booleans are stored as 0/1 (IndexedDB cannot index booleans)
   - dates: ISO-8601 UTC strings; `day` = local business day YYYY-MM-DD
   - id, created_at, updated_at, device_id, rev are present everywhere so that
     synchronisation can be added later without changing the structure */
(function (root) {
  'use strict';

  const SCHEMA_VERSION = 2;
  const QTY_SCALE = 100;   // quantities are stored in hundredths of a unit (1.5 m = 150), like money in cents

  const SYNC = ['created_at', 'updated_at', 'device_id', 'rev'];

  const stores = {
    meta: { keyPath: 'key', indexes: {}, fields: ['key', 'value'] },

    settings: { keyPath: 'key', indexes: {}, fields: ['key', 'value', 'updated_at'] },

    users: {
      keyPath: 'id',
      indexes: { role: 'role' },
      // PIN codes are added in a later update; pin_hash stays null for now
      fields: ['id', 'name', 'role', 'pin_hash', 'is_active', ...SYNC],
    },

    categories: {
      keyPath: 'id',
      indexes: { prefix: 'prefix' },
      fields: ['id', 'prefix', 'name_ar', 'name_fr', 'sort', 'active', ...SYNC],
    },

    products: {
      keyPath: 'id',
      indexes: { sku: 'sku', category: 'category_id', name_norm: 'name_norm', deleted: 'is_deleted' },
      fields: [
        'id', 'sku', 'sku_num', 'category_id', 'name', 'name_norm',
        'buy_cents', 'sell_cents', 'qty',
        'is_deleted', 'deleted_at', 'category_changed_at', ...SYNC,
      ],
    },

    customers: {
      keyPath: 'id',
      indexes: { phone: 'phone_norm', name_norm: 'name_norm' },
      fields: ['id', 'name', 'name_norm', 'phone', 'phone_norm', 'note', 'is_deleted', ...SYNC],
    },

    suppliers: {
      keyPath: 'id',
      indexes: { phone: 'phone_norm', name_norm: 'name_norm' },
      fields: ['id', 'name', 'name_norm', 'phone', 'phone_norm', 'note', 'is_deleted', ...SYNC],
    },

    // One row per operation: sale, quick_sale, purchase, return_customer, return_supplier,
    // deposit, withdrawal, expense (see INVOICE_TYPES). number = ammjjxxx, -1/-2 if duplicated.
    invoices: {
      keyPath: 'id',
      indexes: {
        number: 'number', day: 'day', type: 'type', client_ref: 'client_ref',
        party: ['party_type', 'party_id'], original: 'original_invoice_id', detailed: 'has_detail',
      },
      fields: [
        'id', 'number', 'seq', 'type', 'at', 'day',
        'party_type', 'party_id', 'party_name', 'party_phone',
        'total_cents', 'paid_cents', 'due_cents', 'cost_cents', 'profit_cents',
        'profit_mode', 'has_detail', 'original_invoice_id', 'client_ref', 'status', 'note', 'user_id', ...SYNC,
      ],
    },

    // category_id, sku, name, list_price_cents and unit_cost_cents are SNAPSHOTS taken at sale time:
    // reports by category never change retroactively, and returns can be compared with the stock.
    // unit_price_cents = price actually charged (may differ from list_price_cents after negotiation).
    invoice_lines: {
      keyPath: 'id',
      indexes: { invoice: 'invoice_id', product: 'product_id', category: 'category_id' },
      fields: [
        'id', 'invoice_id', 'line_no', 'product_id', 'sku', 'name', 'category_id',
        'qty', 'unit_price_cents', 'list_price_cents', 'unit_cost_cents', 'line_total_cents',
        'is_external', 'is_generic', 'returned_qty', 'original_line_id', ...SYNC,
      ],
    },

    // Payments / collections, allocated invoice by invoice (oldest first)
    payments: {
      keyPath: 'id',
      indexes: { party: ['party_type', 'party_id'], invoice: 'invoice_id', day: 'day' },
      fields: ['id', 'party_type', 'party_id', 'invoice_id', 'source_invoice_id', 'direction', 'amount_cents', 'at', 'day', 'note', ...SYNC],
    },

    cash_entries: {
      keyPath: 'id',
      indexes: { day: 'day', ref: 'ref_id' },
      fields: ['id', 'at', 'day', 'kind', 'amount_cents', 'ref_id', 'note', 'user_id', ...SYNC],
    },

    cash_counts: {
      keyPath: 'id',
      indexes: { day: 'day' },
      fields: ['id', 'at', 'day', 'expected_cents', 'counted_cents', 'diff_cents', 'user_id', ...SYNC],
    },

    expenses: {
      keyPath: 'id',
      indexes: { day: 'day' },
      fields: ['id', 'at', 'day', 'label', 'amount_cents', 'user_id', ...SYNC],
    },

    // Journal of every quantity change (sale, purchase, return, count adjustment, manual).
    stock_movements: {
      keyPath: 'id',
      indexes: { product: 'product_id', at: 'at', ref: 'ref_id' },
      fields: ['id', 'product_id', 'category_id', 'qty_delta', 'qty_after', 'reason', 'ref_id', 'at', 'user_id', ...SYNC],
    },

    // Inventory is done by the owner, one category at a time.
    stock_counts: {
      keyPath: 'id',
      indexes: { category: 'category_id', status: 'status' },
      fields: ['id', 'category_id', 'status', 'started_at', 'finished_at', 'user_id', 'shortage_cost_cents', ...SYNC],
    },

    stock_count_lines: {
      keyPath: 'id',
      indexes: { count: 'count_id', product: 'product_id' },
      fields: ['id', 'count_id', 'product_id', 'sku', 'name', 'unit_cost_cents', 'expected_qty', 'counted_qty', 'diff_qty', ...SYNC],
    },

    audit_log: {
      keyPath: 'id',
      indexes: { at: 'at', entity: ['entity', 'entity_id'] },
      fields: ['id', 'at', 'device_id', 'user_id', 'action', 'entity', 'entity_id', 'details'],
    },
  };

  const INVOICE_TYPES = [
    'sale', 'quick_sale', 'purchase', 'return_customer', 'return_supplier',
    'deposit', 'withdrawal', 'expense',
  ];

  const SEED_CATEGORIES = [
    { id: 'DG', prefix: '',   name_ar: 'عقاقير عامة',   name_fr: 'Droguerie générale', sort: 1 },
    { id: 'E',  prefix: 'E',  name_ar: 'كهرباء',        name_fr: 'Électricité',        sort: 2 },
    { id: 'P',  prefix: 'P',  name_ar: 'سباكة',         name_fr: 'Plomberie',          sort: 3 },
    { id: 'S',  prefix: 'S',  name_ar: 'صباغة',         name_fr: 'Peinture',           sort: 4 },
    { id: 'M',  prefix: 'M',  name_ar: 'نجارة',         name_fr: 'Menuiserie',         sort: 5 },
    { id: 'O',  prefix: 'O',  name_ar: 'أدوات',         name_fr: 'Outillage',          sort: 6 },
    { id: 'EM', prefix: 'EM', name_ar: 'إلكتروميناجير', name_fr: 'Électroménager',     sort: 7 },
  ];

  const DEFAULT_SETTINGS = {
    shop_name: '',
    shop_address: '',
    shop_phone: '',
    currency: 'DH',
    quick_sale_profit_pct: 20,   // flat profit % for quick sales that have no detail yet
    allow_negative_stock: 1,     // a sale never stops because stock is 0 or negative
    return_match_buy_price: 0,   // 1 = a changed buy price also blocks a direct return (off: WAC moves it constantly)
    beep: 0,                     // 1 = short sound on every button
    cost_method: 'wac',          // 'wac' = weighted average cost, 'last' = last purchase price
  };

  const schema = {
    version: SCHEMA_VERSION, qtyScale: QTY_SCALE, stores,
    invoiceTypes: INVOICE_TYPES, seedCategories: SEED_CATEGORIES, defaultSettings: DEFAULT_SETTINGS,
  };

  root.WeGo = root.WeGo || {};
  root.WeGo.schema = schema;
  if (typeof module !== 'undefined' && module.exports) module.exports = schema;
})(typeof globalThis !== 'undefined' ? globalThis : this);
