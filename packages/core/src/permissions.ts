/**
 * Permissions. Roles get these by default; Admin can change them in Settings → Roles.
 * The server checks them on every request. The screen only hides what you can't use.
 */

export const PERMISSIONS = {
  'billing.create': 'Create bills and take payments',
  'billing.discount_over_limit': 'Give discount above the product max discount',
  'billing.cancel': 'Cancel a bill',
  'returns.create': 'Take back goods (sales return / credit note)',
  'payments.receive': 'Receive customer payments',
  'customers.manage': 'Add and edit customers',
  'suppliers.manage': 'Add and edit suppliers',
  'products.manage': 'Add and edit products (not prices)',
  'products.edit_price': 'Edit selling prices and max discounts',
  'products.view_cost': 'See cost price and profit',
  'stock.adjust': 'Purchases and stock adjustments',
  'payments.make': 'Pay suppliers, bank deposits and transfers',
  'expenses.create': 'Enter shop expenses',
  'accounts.manage': 'Bank accounts, expense heads, journals and opening balances',
  'reports.view': 'Accounts, ledgers, reports and GST',
  'activity.view': 'See the full activity log',
  'settings.manage': 'Store settings, import and backups',
  'users.manage': 'Users, roles and counters',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export type RoleId = 'admin' | 'counter' | 'stock';

export const DEFAULT_ROLES: Record<RoleId, { name: string; permissions: Permission[] }> = {
  admin: { name: 'Admin', permissions: ALL_PERMISSIONS },
  counter: {
    name: 'Counter staff',
    permissions: ['billing.create', 'payments.receive', 'customers.manage'],
  },
  stock: {
    name: 'Stock staff',
    permissions: ['stock.adjust', 'suppliers.manage'],
  },
};

/** Things staff can't do themselves but an admin can approve on the spot with their PIN. */
export const OVERRIDABLE: Permission[] = ['billing.discount_over_limit', 'billing.cancel', 'returns.create'];

export function hasPermission(granted: readonly string[], p: Permission): boolean {
  return granted.includes(p);
}
