import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Package, Wrench, User } from 'lucide-react';
import { useLanguage } from '@/lib/LanguageContext';

const TABS = [
  { labelKey: 'Dashboard', icon: LayoutDashboard, path: '/Dashboard' },
  { labelKey: 'My Packages', icon: Package, path: '/packages' },
  { labelKey: 'Maintenance', icon: Wrench, path: '/Maintenance' },
  { labelKey: 'My Profile', icon: User, path: '/Profile' },
];

export default function BottomTabs() {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useLanguage();

  const handleTabClick = (e, tab) => {
    const isActive = location.pathname === tab.path || (tab.path === '/Dashboard' && location.pathname === '/');
    if (isActive) {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  return (
    <nav
      className="lg:hidden fixed bottom-0 left-0 right-0 z-50 bg-white border-t border-zinc-100 flex items-stretch"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {TABS.map((tab) => {
        const isActive = location.pathname === tab.path || (tab.path === '/Dashboard' && location.pathname === '/');
        return (
          <Link
            key={tab.path}
            to={tab.path}
            onClick={(e) => handleTabClick(e, tab)}
            className={`flex-1 flex flex-col items-center justify-center py-2 gap-0.5 text-xs font-medium transition-colors select-none ${
              isActive ? 'text-zinc-900' : 'text-zinc-400 hover:text-zinc-700'
            }`}
          >
            <tab.icon className={`w-5 h-5 ${isActive ? 'text-zinc-900' : 'text-zinc-400'}`} />
            <span className="leading-tight">{t(tab.labelKey)}</span>
          </Link>
        );
      })}
    </nav>
  );
}