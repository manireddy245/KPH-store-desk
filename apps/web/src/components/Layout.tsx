import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import type { Permission } from '@kph/core';
import { useT } from '../lib/i18n';
import { useSession } from '../lib/session';
import { Logo, SampleBanner, cx } from './ui';

/** `main` items stay in the top bar on computers; the rest go under "More". On phones everything is in the menu. */
export const NAV: { to: string; label: string; perm?: Permission | Permission[]; main?: boolean }[] = [
  { to: '/billing', label: 'Billing', perm: 'billing.create', main: true },
  { to: '/owner', label: 'Owner', perm: 'reports.view', main: true },
  { to: '/dashboard', label: 'Dashboard', main: true },
  { to: '/sales', label: 'Sales', main: true },
  { to: '/khata', label: 'Khata', perm: ['payments.receive', 'reports.view'], main: true },
  { to: '/operations', label: 'Operations', perm: ['billing.create', 'stock.adjust'], main: true },
  { to: '/purchases', label: 'Purchases', perm: 'stock.adjust', main: true },
  { to: '/stock', label: 'Stock', perm: ['stock.adjust', 'reports.view'], main: true },
  { to: '/inventory', label: 'Inventory', main: true },
  { to: '/assistant', label: 'Assistant' },
  { to: '/customers', label: 'Customers' },
  { to: '/partners', label: 'Partners', perm: ['partners.manage', 'reports.view'] },
  { to: '/suppliers', label: 'Suppliers' },
  { to: '/accounts', label: 'Accounts', perm: ['payments.receive', 'payments.make', 'expenses.create', 'reports.view'] },
  { to: '/reports', label: 'Reports', perm: 'reports.view' },
  { to: '/activity', label: 'Activity' },
  { to: '/settings', label: 'Settings', perm: ['settings.manage', 'users.manage'] },
];

export function Layout() {
  const { boot, user, can, lock, setLanguage } = useSession();
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const loc = useLocation();
  const items = NAV.filter((n) => !n.perm || (Array.isArray(n.perm) ? n.perm.some(can) : can(n.perm)));
  const main = items.filter((n) => n.main);
  const more = items.filter((n) => !n.main);
  const roleName = boot?.users.find((u) => u.id === user?.userId)?.role_name ?? user?.roleId;
  const activeMore = more.some((n) => loc.pathname === n.to || loc.pathname.startsWith(n.to + '/'));

  useEffect(() => {
    setMoreOpen(false);
    setMenuOpen(false);
  }, [loc.pathname]);
  useEffect(() => {
    if (!moreOpen) return;
    const close = (e: MouseEvent) => !moreRef.current?.contains(e.target as Node) && setMoreOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [moreOpen]);

  const link = (n: (typeof NAV)[number], inMore = false) => (
    <NavLink
      key={n.to}
      to={n.to}
      className={({ isActive }) =>
        cx(
          inMore ? 'flex h-10 items-center px-4 text-sm text-ink hover:bg-paper' : 'flex h-11 items-center px-3 text-sm md:h-[60px]',
          !inMore && (isActive || loc.pathname.startsWith(n.to + '/') ? 'font-bold text-white shadow-[inset_3px_0_0_#c2491a] md:shadow-[inset_0_-3px_0_#c2491a]' : 'text-nav hover:text-white'),
          inMore && isActive && 'font-bold text-brick',
        )
      }
    >
      {t(n.label)}
    </NavLink>
  );

  return (
    <div className="flex min-h-screen flex-col">
      <header className="no-print flex flex-wrap items-center gap-x-5 gap-y-1 bg-ink px-4 text-white sm:px-5">
        <div className="flex min-h-[60px] items-center gap-3.5">
          <Logo reversed />
          <span className="hidden h-7 w-px bg-[#3a3d42] xl:block" />
          <span className="hidden text-xs font-bold tracking-[.16em] text-nav xl:block">STORE DESK</span>
        </div>
        <button type="button" className="ml-auto flex h-11 items-center gap-2 rounded-[6px] px-3 text-sm font-semibold md:hidden" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
          <svg aria-hidden width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
          {t('Menu')}
        </button>
        {/* phones: everything in one list */}
        {menuOpen && (
          <nav aria-label="Main" className="flex w-full flex-col pb-2 md:hidden">
            {items.map((n) => link(n))}
          </nav>
        )}
        {/* computers: main items + More */}
        <nav aria-label="Main" className="hidden md:flex md:flex-1 md:flex-row">
          {main.map((n) => link(n))}
          {more.length > 0 && (
            <div ref={moreRef} className="relative">
              <button
                type="button"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen((o) => !o)}
                className={cx('flex h-[60px] items-center gap-1 px-3 text-sm', activeMore ? 'font-bold text-white shadow-[inset_0_-3px_0_#c2491a]' : 'text-nav hover:text-white')}
              >
                {t('More')}
                <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m6 9 6 6 6-6" /></svg>
              </button>
              {moreOpen && <div className="absolute left-0 top-full z-40 flex min-w-[200px] flex-col rounded-b-[6px] border border-line bg-white py-1 shadow-xl">{more.map((n) => link(n, true))}</div>}
            </div>
          )}
        </nav>
        <div className={cx('items-center gap-3 pb-2 md:flex md:pb-0', menuOpen ? 'flex' : 'hidden')}>
          <div className="flex flex-col items-end leading-tight">
            <span className="text-sm font-bold">{user?.userName}</span>
            <span className="text-[11px] text-nav">
              {boot?.device?.name} · {roleName}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void setLanguage(user?.language === 'te' ? 'en' : 'te')}
            title={t('Language')}
            className="h-9 rounded-[6px] border border-[#4a4d52] px-2.5 text-[13px] font-semibold hover:bg-white/10"
          >
            {user?.language === 'te' ? 'English' : 'తెలుగు'}
          </button>
          <button type="button" onClick={() => void lock()} className="flex h-9 items-center gap-1.5 rounded-[6px] border border-[#4a4d52] px-3 text-[13px] font-semibold hover:bg-white/10">
            <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
            {t('Lock')} <span className="text-[11px] text-nav">Ctrl+L</span>
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
