import React, { useState, useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import EmergencyAlertPopup from './EmergencyAlertPopup';

// Per-user persisted dismissed IDs — keyed by userId
function getSeenKey(userId) {
  return `seen_emergency_ids_${userId || 'anon'}`;
}

function getSeenIds(userId) {
  try { return new Set(JSON.parse(localStorage.getItem(getSeenKey(userId)) || '[]')); } catch { return new Set(); }
}

function markSeen(userId, id) {
  const seen = getSeenIds(userId);
  seen.add(id);
  localStorage.setItem(getSeenKey(userId), JSON.stringify([...seen].slice(-500)));
}

function isAlertValid(alert) {
  if (!alert) return false;
  if (alert.isActive !== true) return false;   // must be explicitly true
  if (alert.is_deleted) return false;           // deleted = gone forever
  if (alert.is_resolved) return false;
  if (alert.expiresAt && new Date(alert.expiresAt) <= new Date()) return false;
  return (alert.type || '').toLowerCase() === 'emergency';
}

export default function EmergencyListener({ user }) {
  const [pendingAlerts, setPendingAlerts] = useState([]);
  // initializedRef ensures the startup fetch runs only ONCE per user session,
  // not on every re-render/route change (which would re-queue dismissed alerts)
  const initializedRef = useRef(false);
  const userIdRef = useRef(null);

  const isResident = !!(user && user.account_type === 'resident');
  const userId = user?.id;

  // --- One-time startup fetch: only runs once per userId, never again on navigation ---
  useEffect(() => {
    if (!isResident || !userId) return;
    // If user changed (e.g. logout/login), reset
    if (userIdRef.current !== userId) {
      userIdRef.current = userId;
      initializedRef.current = false;
      setPendingAlerts([]);
    }
    if (initializedRef.current) return;
    initializedRef.current = true;

    const fetchOnStartup = async () => {
      try {
        const seen = getSeenIds(userId);
        // Fetch active building updates
        const updates = await base44.entities.BuildingUpdate.filter({ isActive: true }, '-created_date', 50);
        const validEmergencies = updates.filter(u => isAlertValid(u));

        // Also fetch this user's archive records to exclude archived emergencies
        const archives = await base44.entities.UpdateArchive.filter({ userId }, '-archivedAt', 100);
        const archivedIds = new Set(archives.map(a => a.updateId));

        const toQueue = validEmergencies.filter(u =>
          !seen.has(u.id) &&
          !archivedIds.has(u.id)
        );

        if (toQueue.length > 0) {
          setPendingAlerts(toQueue.map(u => ({ ...u, type: 'emergency' })));
        }
      } catch (e) {
        console.error('[EmergencyListener] startup fetch error:', e);
      }
    };

    fetchOnStartup();
  }, [isResident, userId]);

  // --- Real-time subscription: add new, purge deleted/deactivated ---
  useEffect(() => {
    if (!isResident || !userId) return;

    const unsubscribe = base44.entities.BuildingUpdate.subscribe(async (event) => {
      if (event.type === 'delete') {
        const id = event.id || event.data?.id;
        if (id) {
          markSeen(userId, id);
          setPendingAlerts(prev => prev.filter(a => a.id !== id));
        }
        return;
      }

      if (event.type === 'update') {
        const data = event.data;
        const id = event.id || data?.id;
        if (id && data && (!data.isActive || data.is_deleted || data.is_resolved)) {
          markSeen(userId, id);
          setPendingAlerts(prev => prev.filter(a => a.id !== id));
        }
        return;
      }

      if (event.type !== 'create') return;

      let alertData = event.data;
      if (!alertData && event.id) {
        try {
          const records = await base44.entities.BuildingUpdate.filter({ id: event.id });
          alertData = records.length > 0 ? records[0] : null;
        } catch (e) { /* ignore */ }
      }

      if (!isAlertValid(alertData)) return;
      const seen = getSeenIds(userId);
      if (seen.has(alertData.id)) return;

      setPendingAlerts(prev => {
        if (prev.find(a => a.id === alertData.id)) return prev;
        return [...prev, { ...alertData, type: 'emergency' }];
      });
    });

    return () => unsubscribe();
  }, [isResident, userId]);

  const handleDismiss = (id) => {
    markSeen(userId, id);
    setPendingAlerts(prev => prev.filter(a => a.id !== id));
  };

  if (!isResident) return null;

  return (
    <EmergencyAlertPopup
      alerts={pendingAlerts}
      onDismiss={handleDismiss}
    />
  );
}
