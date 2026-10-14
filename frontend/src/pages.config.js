/**
 * pages.config.js - Page routing configuration
 * 
 * This file is AUTO-GENERATED. Do not add imports or modify PAGES manually.
 * Pages are auto-registered when you create files in the ./pages/ folder.
 * 
 * THE ONLY EDITABLE VALUE: mainPage
 * This controls which page is the landing page (shown when users visit the app).
 * 
 * Example file structure:
 * 
 *   import HomePage from './pages/HomePage';
 *   import Dashboard from './pages/Dashboard';
 *   import Settings from './pages/Settings';
 *   
 *   export const PAGES = {
 *       "HomePage": HomePage,
 *       "Dashboard": Dashboard,
 *       "Settings": Settings,
 *   }
 *   
 *   export const pagesConfig = {
 *       mainPage: "HomePage",
 *       Pages: PAGES,
 *   };
 * 
 * Example with Layout (wraps all pages):
 *
 *   import Home from './pages/Home';
 *   import Settings from './pages/Settings';
 *   import __Layout from './Layout.jsx';
 *
 *   export const PAGES = {
 *       "Home": Home,
 *       "Settings": Settings,
 *   }
 *
 *   export const pagesConfig = {
 *       mainPage: "Home",
 *       Pages: PAGES,
 *       Layout: __Layout,
 *   };
 *
 * To change the main page from HomePage to Dashboard, use find_replace:
 *   Old: mainPage: "HomePage",
 *   New: mainPage: "Dashboard",
 *
 * The mainPage value must match a key in the PAGES object exactly.
 */
import BoardOverview from './pages/BoardOverview';
import Concierge from './pages/Concierge';
import CreateIncidentReport from './pages/CreateIncidentReport';
import CreateShiftReport from './pages/CreateShiftReport';
import Dashboard from './pages/Dashboard';
import Gameroom from './pages/Gameroom';
import Home from './pages/Home';
import Maintenance from './pages/Maintenance';
import ManagementMaintenance from './pages/ManagementMaintenance';
import ManagementReports from './pages/ManagementReports';
import ManagementSpeakeasy from './pages/ManagementSpeakeasy';
import MoveInspection from './pages/MoveInspection';
import MoveRequest from './pages/MoveRequest';
import Onboarding from './pages/Onboarding';
import Packages from './pages/Packages';
import Profile from './pages/Profile';
import ResidentSetup from './pages/ResidentSetup';
import Residents from './pages/Residents';
import SecurityGameroom from './pages/SecurityGameroom';
import SecurityMoveRequests from './pages/SecurityMoveRequests';
import SecurityPackages from './pages/SecurityPackages';
import SecurityReport from './pages/SecurityReport';
import SecuritySpeakeasy from './pages/SecuritySpeakeasy';
import Speakeasy from './pages/Speakeasy';
import VisitorAccess from './pages/VisitorAccess';
import VisitorVerification from './pages/VisitorVerification';
import securityReports from './pages/security-reports';
import ManagementNotices from './pages/ManagementNotices';
import __Layout from './Layout.jsx';


export const PAGES = {
    "BoardOverview": BoardOverview,
    "Concierge": Concierge,
    "CreateIncidentReport": CreateIncidentReport,
    "CreateShiftReport": CreateShiftReport,
    "Dashboard": Dashboard,
    "Gameroom": Gameroom,
    "Home": Home,
    "Maintenance": Maintenance,
    "ManagementMaintenance": ManagementMaintenance,
    "ManagementReports": ManagementReports,
    "ManagementSpeakeasy": ManagementSpeakeasy,
    "MoveInspection": MoveInspection,
    "MoveRequest": MoveRequest,
    "Onboarding": Onboarding,
    "Packages": Packages,
    "Profile": Profile,
    "ResidentSetup": ResidentSetup,
    "Residents": Residents,
    "SecurityGameroom": SecurityGameroom,
    "SecurityMoveRequests": SecurityMoveRequests,
    "SecurityPackages": SecurityPackages,
    "SecurityReport": SecurityReport,
    "SecuritySpeakeasy": SecuritySpeakeasy,
    "Speakeasy": Speakeasy,
    "VisitorAccess": VisitorAccess,
    "VisitorVerification": VisitorVerification,
    "security-reports": securityReports,
    "ManagementNotices": ManagementNotices,
}

export const pagesConfig = {
    mainPage: "Dashboard",
    Pages: PAGES,
    Layout: __Layout,
};