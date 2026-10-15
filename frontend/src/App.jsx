import './App.css'
import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import VisualEditAgent from '@/lib/VisualEditAgent'
import NavigationTracker from '@/lib/NavigationTracker'
import { pagesConfig } from './pages.config'
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import { LanguageProvider } from '@/lib/LanguageContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import Contacts from './pages/Contacts';
import { isDemoPage } from '@/app/routeScope';

const { Pages: AllPages, Layout, mainPage } = pagesConfig;
// Only demo-scope pages are routed; the rest render the 404 page (src/app/routeScope.ts).
const Pages = Object.fromEntries(Object.entries(AllPages).filter(([name]) => isDemoPage(name)));
// A hidden mainPage falls back to the first demo page instead of a blank "/".
const mainPageKey = mainPage && isDemoPage(mainPage) ? mainPage : Object.keys(Pages)[0];
const MainPage = mainPageKey ? Pages[mainPageKey] : <></>;

const LayoutWrapper = ({ children, currentPageName }) => Layout ?
  <Layout currentPageName={currentPageName}>{children}</Layout>
  : <>{children}</>;

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, isAuthenticated, navigateToLogin } = useAuth();

  // Show loading spinner while checking app public settings or auth
  if (isLoadingPublicSettings || isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
      </div>
    );
  }

  // Handle authentication errors
  if (authError) {
    if (authError.type === 'user_not_registered') {
      return <UserNotRegisteredError />;
    } else if (authError.type === 'auth_required') {
      // Redirect to login automatically
      navigateToLogin();
      return null;
    }
  }

  // Render the main app
  return (
    <Routes>
      <Route path="/" element={
        <LayoutWrapper currentPageName={mainPageKey}>
          <MainPage />
        </LayoutWrapper>
      } />
      {Object.entries(Pages).map(([path, Page]) => (
        <Route
          key={path}
          path={`/${path}`}
          element={
            <LayoutWrapper currentPageName={path}>
              <Page />
            </LayoutWrapper>
          }
        />
      ))}
      {isDemoPage('Contacts') && <Route path="/Contacts" element={<LayoutWrapper currentPageName="Contacts"><Contacts /></LayoutWrapper>} />}
      <Route path="*" element={<PageNotFound />} />
    </Routes>
  );
};


function App() {

  return (
    <AuthProvider>
      <LanguageProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          {/* Base44 editor helpers, dev only: they post to window.parent with target '*' and log page
              views to Base44, and VisualEditAgent's message handler has no origin check. */}
          {import.meta.env.DEV && <NavigationTracker />}
          <AuthenticatedApp />
        </Router>
        <Toaster />
        {import.meta.env.DEV && <VisualEditAgent />}
      </QueryClientProvider>
      </LanguageProvider>
    </AuthProvider>
  )
}

export default App