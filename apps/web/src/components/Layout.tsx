import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import type { Permission } from '@kph/core';
import { useSession } from '../lib/session';
import { Logo, SampleBanner, cx } from './ui';

export const NAV: { to: string; label: string; perm?: Permission | Permission[] }[] = [
  { to: '/billing', label: 'Billing', perm: 'billing.create' },
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/assistant', label: 'Assistant' },
  { to: '/sales', label: 'Sales' },
  { to: '/purchases', label: 'Purchases', perm: 'stock.adjust' },
  { to: '/inventory', label: 'Inventory' },
  { to: '/customers', label: 'Customers' },
  { to: '/suppliers', label: 'Suppliers' },
  { to: '/accounts', label: 'Accounts', perm: ['payments.receive', 'payments.make', 'expenses.create', 'reports.view'] },
  { to: '/reports', label: 'Reports', perm: 'reports.view' },
  { to: '/activity', label: 'Activity' },
  { to: '/settings', label: 'Settings', perm: ['settings.manage', 'users.manage'] },
];

export function Layout() {
  const { boot, user, can, lock } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const loc = useLocation();
  const items = NAV.filter((n) => !n.perm || (Array.isArray(n.perm) ? n.perm.some(can) : can(n.perm)));
  const roleName = boot?.users.find((u) => u.id === user?.userId)?.role_name ?? user?.roleId;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="no-print flex flex-wrap items-center gap-x-5 gap-y-1 bg-ink px-4 text-white sm:px-5">
        <div className="flex min-h-[60px] items-center gap-3.5">
          <Logo reversed />
          <span className="hidden h-7 w-px bg-[#3a3d42] lg:block" />
          <span className="hidden text-xs font-bold tracking-[.16em] text-nav lg:block">STORE DESK</span>
        </div>
        <button
          type="button"
          className="ml-auto flex h-11 items-center gap-2 rounded-[6px] px-3 text-sm font-semibold md:hidden"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
        >
          <svg aria-hidden width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
          Menu
        </button>
        <nav aria-label="Main" className={cx('w-full flex-col md:flex md:w-auto md:flex-1 md:flex-row md:flex-wrap', menuOpen ? 'flex pb-2' : 'hidden')}>
          {items.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              onClick={() => setMenuOpen(false)}
              className={({ isActive }) =>
                cx(
                  'flex h-11 items-center px-3 text-sm md:h-[60px]',
                  isActive || loc.pathname.startsWith(n.to + '/') ? 'font-bold text-white shadow-[inset_3px_0_0_#c2491a] md:shadow-[inset_0_-3px_0_#c2491a]' : 'text-nav hover:text-white',
                )
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className={cx('items-center gap-3 pb-2 md:flex md:pb-0', menuOpen ? 'flex' : 'hidden')}>
          <div className="flex flex-col items-end leading-tight">
            <span className="text-sm font-bold">{user?.userName}</span>
            <span className="text-[11px] text-nav">
              {boot?.device?.name} · {roleName}
            </span>
          </div>
          <button type="button" onClick={() => void lock()} className="flex h-9 items-center gap-1.5 rounded-[6px] border border-[#4a4d52] px-3 text-[13px] font-semibold hover:bg-white/10">
            <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
            Lock <span className="text-[11px] text-nav">Ctrl+L</span>
          </button>
        </div>
      </header>
      {boot?.workspace === 'sample' && <SampleBanner />}
      <div className="flex flex-1 flex-col">
        <Outlet />
      </div>
    </div>
  );
}

/** Standard page body width and padding. */
export function Page({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return <main className={cx('mx-auto flex w-full flex-col gap-4 px-4 py-6 sm:px-5', wide ? 'max-w-[1500px]' : 'max-w-[1400px]')}>{children}</main>;
}
