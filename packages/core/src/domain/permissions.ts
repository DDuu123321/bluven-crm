// Roles and access rules. Pure functions, safe for browser code.
import { isSalesEditableStage, type OrderStage, type SideState } from './stages';

export const ROLES = ['SALES', 'MANAGER', 'FINANCE', 'OPS', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  SALES: 'Sales',
  MANAGER: 'Manager',
  FINANCE: 'Finance',
  OPS: 'Operations',
  ADMIN: 'Admin',
};

export interface Principal {
  id: string;
  roles: readonly Role[];
}

export function hasRole(u: Principal, role: Role): boolean {
  return u.roles.includes(role);
}

/** Managers and admins see and manage every order. */
export function isManager(u: Principal): boolean {
  return hasRole(u, 'MANAGER') || hasRole(u, 'ADMIN');
}

export function isAdmin(u: Principal): boolean {
  return hasRole(u, 'ADMIN');
}

export type Capability =
  | 'orders.work' // has a pipeline of their own or manages one
  | 'orders.create'
  | 'orders.assign'
  | 'orders.restoreLost'
  | 'leads.import'
  | 'dashboard.view'
  | 'audit.view'
  | 'config.manage' // checklist, lost reasons
  | 'finance.deposits'
  | 'ops.handoffs'
  | 'admin.users'
  | 'admin.leadSources'
  | 'admin.settings'
  | 'admin.pylon';

export function can(u: Principal, capability: Capability): boolean {
  switch (capability) {
    case 'orders.work':
    case 'orders.create':
      return hasRole(u, 'SALES') || isManager(u);
    case 'orders.assign':
    case 'orders.restoreLost':
    case 'leads.import':
    case 'dashboard.view':
    case 'audit.view':
    case 'config.manage':
      return isManager(u);
    case 'finance.deposits':
      return hasRole(u, 'FINANCE');
    case 'ops.handoffs':
      return hasRole(u, 'OPS');
    case 'admin.users':
    case 'admin.leadSources':
    case 'admin.settings':
    case 'admin.pylon':
      return isAdmin(u);
  }
}

/** How much of an order a user may see. */
export type OrderView = 'FULL' | 'OPS' | 'FINANCE';

export interface OrderAccessFacts {
  ownerId: string | null;
  stage: OrderStage;
  sideState: SideState;
  /** Set once the order has been pushed to operations at least once. */
  firstPushedAt: Date | null;
  /** Whether any deposit record exists (any status). */
  hasDepositRecord: boolean;
}

/**
 * The widest view the user is entitled to, or null when the order is invisible to them.
 *  - FULL: the owning salesperson, managers and admins.
 *  - OPS: operations, but only once the order has been pushed.
 *  - FINANCE: finance, only for orders with a deposit record, and only the deposit-related parts.
 */
export function orderViewFor(u: Principal, o: OrderAccessFacts): OrderView | null {
  if (isManager(u)) return 'FULL';
  if (hasRole(u, 'SALES') && o.ownerId === u.id) return 'FULL';
  if (hasRole(u, 'OPS') && o.firstPushedAt) return 'OPS';
  if (hasRole(u, 'FINANCE') && o.hasDepositRecord) return 'FINANCE';
  return null;
}

/** The owning salesperson or a manager. */
export function isOrderStaff(u: Principal, o: Pick<OrderAccessFacts, 'ownerId'>): boolean {
  return isManager(u) || (hasRole(u, 'SALES') && o.ownerId === u.id);
}

/** Whether the order's content (details, documents, quotes, contract, deposit) may be changed. */
export function canEditOrder(u: Principal, o: OrderAccessFacts): boolean {
  if (!isOrderStaff(u, o)) return false;
  if (o.sideState === 'LOST' || o.sideState === 'CANCELLED') return false;
  return isSalesEditableStage(o.stage);
}

/** Notes and call logs stay possible for the owner and managers in every state. */
export function canLogActivity(u: Principal, o: OrderAccessFacts): boolean {
  return isOrderStaff(u, o);
}

/** Document type keys the finance view is limited to. */
export const FINANCE_VISIBLE_DOC_TYPES: readonly string[] = ['deposit_proof', 'signed_contract', 'quote'];
