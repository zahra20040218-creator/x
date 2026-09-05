import { Authenticated, Refine } from '@refinedev/core';
import routerProvider from '@refinedev/react-router';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router';

import { API_BASE_URL, dataProvider, session } from './api';
import { createAuthProvider } from './auth-provider';
import { ConfigPage } from './pages/config';
import { DisputesPage } from './pages/disputes';
import { DriversPage } from './pages/drivers';
import { LoginPage } from './pages/login';
import { RidesPage } from './pages/rides';

const authProvider = createAuthProvider(API_BASE_URL, session);

/**
 * Resource names here must match the keys in `RESOURCE_PATHS` inside
 * `data-provider.ts`. That mapping is explicit rather than derived, because
 * Refine would otherwise invent REST paths from the resource name and
 * CLAUDE.md §12.1 forbids calling an endpoint that is not in the contract.
 */
export function App(): JSX.Element {
  return (
    <BrowserRouter>
      <Refine
        dataProvider={dataProvider}
        authProvider={authProvider}
        routerProvider={routerProvider}
        resources={[
          { name: 'drivers', list: '/drivers', meta: { label: 'السائقون' } },
          { name: 'rides', list: '/rides', meta: { label: 'الرحلات' } },
          { name: 'disputes', list: '/disputes', meta: { label: 'الشكاوى' } },
          { name: 'config', list: '/config', meta: { label: 'الإعدادات' } },
        ]}
        options={{ disableTelemetry: true, warnWhenUnsavedChanges: true }}
      >
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          <Route
            element={
              <Authenticated key="app" fallback={<Navigate to="/login" replace />}>
                <Shell />
              </Authenticated>
            }
          >
            <Route index element={<Navigate to="/drivers" replace />} />
            <Route path="/drivers" element={<DriversPage />} />
            <Route path="/rides" element={<RidesPage />} />
            <Route path="/disputes" element={<DisputesPage />} />
            <Route path="/config" element={<ConfigPage />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </Refine>
    </BrowserRouter>
  );
}

function Shell(): JSX.Element {
  return (
    <div className="shell">
      <nav>
        <span className="brand">الإدارة</span>
        <a href="/drivers">السائقون</a>
        <a href="/rides">الرحلات</a>
        <a href="/disputes">الشكاوى</a>
        <a href="/config">الإعدادات</a>
        <LogoutButton />
      </nav>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

function LogoutButton(): JSX.Element {
  return (
    <button
      className="logout"
      onClick={() => {
        void authProvider.logout({}).then((result) => {
          if (result.redirectTo) window.location.assign(result.redirectTo);
        });
      }}
    >
      خروج
    </button>
  );
}

function NotFound(): JSX.Element {
  return (
    <div className="state">
      <p>الصفحة غير موجودة.</p>
      <a href="/drivers">العودة</a>
    </div>
  );
}
