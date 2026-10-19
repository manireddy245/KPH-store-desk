import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { ApiError } from './lib/api';
import { OverrideProvider } from './lib/override';
import { SessionProvider, useSession } from './lib/session';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/ui';
import { Gate } from './pages/Gate';
import { Billing } from './pages/Billing';
import { Dashboard } from './pages/Dashboard';
import { Sales } from './pages/Sales';
import { Inventory } from './pages/Inventory';
import { Customers } from './pages/Customers';
import { Suppliers } from './pages/Suppliers';
import { Activity } from './pages/Activity';
import { Settings } from './pages/Settings';
import { InvoicePrint } from './pages/InvoicePrint';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (n, e) => !(e instanceof ApiError && e.status > 0 && e.status < 500) && n < 2,
    },
  },
});

function App() {
  const { phase, can } = useSession();
  if (phase !== 'ready') return <Gate />;
  const home = can('billing.create') ? '/billing' : '/dashboard';
  return (
    <OverrideProvider>
      <Routes>
        <Route path="/print/invoice/:id" element={<InvoicePrint />} />
        <Route element={<Layout />}>
          <Route path="/billing" element={<Billing />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/sales" element={<Sales />} />
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/suppliers" element={<Suppliers />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/settings/*" element={<Settings />} />
          <Route path="*" element={<Navigate to={home} replace />} />
        </Route>
      </Routes>
    </OverrideProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <SessionProvider>
            <App />
          </SessionProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
