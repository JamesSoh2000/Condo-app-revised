import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Phone, Mail, MapPin, Car, ChevronUp, ChevronDown, X, User, Building2, Shield } from 'lucide-react';
import { Input } from '@/components/ui/input';

export default function Contacts() {
  const [search, setSearch] = useState('');
  const [towerFilter, setTowerFilter] = useState('all');
  const [sortField, setSortField] = useState('unit_number');
  const [sortDir, setSortDir] = useState('asc');
  const [selectedProfile, setSelectedProfile] = useState(null);

  const { data: profiles = [], isLoading } = useQuery({
    queryKey: ['contacts-profiles'],
    queryFn: async () => {
      const allProfiles = await base44.entities.Profile.list('-created_date', 300);
      // Only approved, non-deleted residents
      return allProfiles.filter(p => !p.is_deleted && p.full_name);
    },
    staleTime: 30000,
    refetchOnMount: 'always',
  });

  const { data: units = [] } = useQuery({
    queryKey: ['units-list'],
    queryFn: () => base44.entities.Unit.list('unit_number', 200),
    staleTime: 60000,
  });

  // Build a unit_id → unit lookup
  const unitMap = useMemo(() => {
    const map = {};
    units.forEach(u => { map[u.id] = u; });
    return map;
  }, [units]);

  // Enrich profiles with unit info
  const enriched = useMemo(() => {
    return profiles.map(p => {
      const unit = p.unit_id ? unitMap[p.unit_id] : null;
      const unitNumber = unit?.unit_number || p.unit_number || '—';
      const tower = unit?.tower || (unitNumber.toString().startsWith('1') ? 'E' : 'W');
      const vehicle = p.vehicles?.[0] || null;
      return { ...p, _unitNumber: unitNumber, _tower: tower, _vehicle: vehicle };
    });
  }, [profiles, unitMap]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    let list = enriched.filter(p => {
      const matchTower = towerFilter === 'all' || p._tower === towerFilter;
      if (!matchTower) return false;
      if (!q) return true;
      return (
        p.full_name?.toLowerCase().includes(q) ||
        p._unitNumber?.toString().includes(q) ||
        p.primary_phone?.includes(q) ||
        p._vehicle?.plate_number?.toLowerCase().includes(q)
      );
    });

    list = [...list].sort((a, b) => {
      let va, vb;
      if (sortField === 'unit_number') {
        va = parseInt(a._unitNumber) || 0;
        vb = parseInt(b._unitNumber) || 0;
      } else {
        va = a.full_name?.toLowerCase() || '';
        vb = b.full_name?.toLowerCase() || '';
      }
      if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      return sortDir === 'asc' ? va - vb : vb - va;
    });

    return list;
  }, [enriched, search, towerFilter, sortField, sortDir]);

  const toggleSort = (field) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('asc'); }
  };

  const SortIcon = ({ field }) => {
    if (sortField !== field) return null;
    return sortDir === 'asc' ? <ChevronUp className="w-3 h-3 inline ml-0.5" /> : <ChevronDown className="w-3 h-3 inline ml-0.5" />;
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-zinc-900">Resident Contacts</h2>
        <p className="text-zinc-400 text-sm mt-1">Directory of all registered residents</p>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
          <Input
            placeholder="Name, unit, phone, plate..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 bg-white"
          />
        </div>
        <div className="flex gap-1">
          {['all', 'E', 'W'].map(t => (
            <button key={t} onClick={() => setTowerFilter(t)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all
                ${towerFilter === t ? 'bg-zinc-900 text-white' : 'bg-white text-zinc-500 border border-zinc-200 hover:border-zinc-300'}`}>
              {t === 'all' ? 'All Towers' : `Tower ${t}`}
            </button>
          ))}
        </div>
        <div className="flex gap-1 ml-auto text-xs text-zinc-400">
          <span>{filtered.length} resident{filtered.length !== 1 ? 's' : ''}</span>
        </div>
      </div>

      {/* Main layout: list + detail panel */}
      <div className="flex gap-4 items-start">

        {/* Resident List */}
        <div className={`bg-white rounded-2xl border border-zinc-100 shadow-sm overflow-hidden flex-shrink-0 transition-all duration-300 ${selectedProfile ? 'w-full lg:w-80' : 'w-full'}`}>
          {/* Column headers */}
          <div className="grid grid-cols-[2fr_1fr_1fr] px-4 py-2.5 bg-zinc-50/80 border-b border-zinc-100 text-xs font-semibold text-zinc-400 uppercase tracking-wide">
            <button onClick={() => toggleSort('full_name')} className="text-left hover:text-zinc-700 transition-colors">
              Name <SortIcon field="full_name" />
            </button>
            <button onClick={() => toggleSort('unit_number')} className="text-left hover:text-zinc-700 transition-colors">
              Unit <SortIcon field="unit_number" />
            </button>
            <span className="hidden lg:block">Phone</span>
          </div>

          {isLoading ? (
            <div className="space-y-0">
              {[...Array(8)].map((_, i) => (
                <div key={i} className="grid grid-cols-[2fr_1fr_1fr] px-4 py-3 border-b border-zinc-50">
                  <div className="h-4 bg-zinc-100 rounded animate-pulse w-32" />
                  <div className="h-4 bg-zinc-100 rounded animate-pulse w-12" />
                  <div className="h-4 bg-zinc-100 rounded animate-pulse w-24 hidden lg:block" />
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center text-zinc-400">
              <User className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No residents found</p>
            </div>
          ) : (
            <div className="divide-y divide-zinc-50 max-h-[calc(100vh-18rem)] overflow-y-auto">
              <AnimatePresence mode="popLayout">
                {filtered.map((p, idx) => {
                  const isSelected = selectedProfile?.id === p.id;
                  return (
                    <motion.div
                      key={p.id}
                      layout
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.15, delay: Math.min(idx * 0.01, 0.15) }}
                      onClick={() => setSelectedProfile(isSelected ? null : p)}
                      className={`grid grid-cols-[2fr_1fr_1fr] px-4 py-3 cursor-pointer transition-colors
                        ${isSelected ? 'bg-zinc-900 text-white' : 'hover:bg-zinc-50/80'}`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0
                          ${isSelected ? 'bg-white/20 text-white' : 'bg-zinc-100 text-zinc-600'}`}>
                          {p.full_name?.charAt(0)?.toUpperCase() || '?'}
                        </div>
                        <div className="min-w-0">
                          <p className={`text-sm font-semibold truncate ${isSelected ? 'text-white' : 'text-zinc-800'}`}>{p.full_name}</p>
                          {p.residency_type && (
                            <p className={`text-[11px] capitalize ${isSelected ? 'text-zinc-300' : 'text-zinc-400'}`}>{p.residency_type}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center">
                        <span className={`text-sm font-medium ${isSelected ? 'text-white' : 'text-zinc-700'}`}>
                          {p._unitNumber}
                          {p._tower && (
                            <span className={`ml-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded
                              ${isSelected ? 'bg-white/20 text-white' : 'bg-zinc-100 text-zinc-500'}`}>
                              {p._tower}
                            </span>
                          )}
                        </span>
                      </div>
                      <div className={`hidden lg:flex items-center text-xs ${isSelected ? 'text-zinc-300' : 'text-zinc-500'}`}>
                        {p.primary_phone || '—'}
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          )}
        </div>

        {/* Detail Panel */}
        <AnimatePresence>
          {selectedProfile && (
            <motion.div
              initial={{ opacity: 0, x: 24, filter: 'blur(8px)' }}
              animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, x: 24, filter: 'blur(8px)' }}
              transition={{ duration: 0.28, ease: 'easeOut' }}
              className="hidden lg:block flex-1 min-w-[280px] bg-white rounded-2xl border border-zinc-100 shadow-sm overflow-hidden sticky top-4"
            >
              {/* Panel header */}
              <div className="bg-zinc-900 px-5 py-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center text-white font-bold text-lg">
                    {selectedProfile.full_name?.charAt(0)?.toUpperCase()}
                  </div>
                  <div>
                    <p className="text-white font-bold text-sm">{selectedProfile.full_name}</p>
                    <p className="text-zinc-400 text-xs capitalize">{selectedProfile.residency_type || 'Resident'}</p>
                  </div>
                </div>
                <button onClick={() => setSelectedProfile(null)} className="text-zinc-400 hover:text-white transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Contact details */}
              <div className="p-5 space-y-4">
                <DetailRow icon={MapPin} label="Unit" value={
                  selectedProfile._unitNumber !== '—'
                    ? `${selectedProfile._unitNumber}${selectedProfile._tower ? ` · Tower ${selectedProfile._tower}` : ''}`
                    : '—'
                } />
                <DetailRow icon={Phone} label="Phone" value={selectedProfile.primary_phone} />
                {selectedProfile.secondary_phone && (
                  <DetailRow icon={Phone} label="Alt Phone" value={selectedProfile.secondary_phone} />
                )}
                <DetailRow icon={Mail} label="Email" value={selectedProfile.email || '—'} />

                {/* Vehicle info */}
                {selectedProfile._vehicle ? (
                  <div className="pt-2 border-t border-zinc-50">
                    <p className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">Vehicle</p>
                    <div className="space-y-3">
                      <DetailRow icon={Car} label="Plate" value={selectedProfile._vehicle.plate_number} />
                      {selectedProfile._vehicle.parking_spot && (
                        <DetailRow icon={MapPin} label="Parking Spot" value={selectedProfile._vehicle.parking_spot} />
                      )}
                      {selectedProfile._vehicle.vehicle_type && (
                        <DetailRow icon={Car} label="Type" value={selectedProfile._vehicle.vehicle_type} />
                      )}
                      {selectedProfile._vehicle.region && (
                        <DetailRow icon={Car} label="Region" value={selectedProfile._vehicle.region} />
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="pt-2 border-t border-zinc-50">
                    <p className="text-xs text-zinc-400">No vehicle registered</p>
                  </div>
                )}

                {/* Additional vehicles */}
                {selectedProfile.vehicles?.length > 1 && selectedProfile.vehicles.slice(1).map((v, idx) => (
                  <div key={idx} className="pt-2 border-t border-zinc-50">
                    <p className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">Vehicle {idx + 2}</p>
                    <div className="space-y-3">
                      {v.plate_number && <DetailRow icon={Car} label="Plate" value={v.plate_number} />}
                      {v.parking_spot && <DetailRow icon={MapPin} label="Parking Spot" value={v.parking_spot} />}
                    </div>
                  </div>
                ))}

                {/* Emergency contact */}
                {selectedProfile.emergency_contact_name && (
                  <div className="pt-2 border-t border-zinc-50">
                    <p className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">Emergency Contact</p>
                    <div className="space-y-3">
                      <DetailRow icon={User} label="Name" value={selectedProfile.emergency_contact_name} />
                      {selectedProfile.emergency_contact_phone && (
                        <DetailRow icon={Phone} label="Phone" value={selectedProfile.emergency_contact_phone} />
                      )}
                    </div>
                  </div>
                )}

                {/* Additional occupants */}
                {selectedProfile.additional_occupants?.length > 0 && (
                  <div className="pt-2 border-t border-zinc-50">
                    <p className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">Additional Occupants</p>
                    {selectedProfile.additional_occupants.map((occ, idx) => (
                      <div key={idx} className="flex items-center gap-2 mb-1.5">
                        <div className="w-5 h-5 rounded-full bg-zinc-100 flex items-center justify-center text-[10px] font-bold text-zinc-500">
                          {occ.name?.charAt(0)}
                        </div>
                        <span className="text-sm text-zinc-700">{occ.name}</span>
                        {occ.relationship && <span className="text-xs text-zinc-400">· {occ.relationship}</span>}
                      </div>
                    ))}
                  </div>
                )}

                {/* Residency info */}
                {selectedProfile.move_in_date && (
                  <div className="pt-2 border-t border-zinc-50">
                    <p className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">Residency</p>
                    <DetailRow icon={Building2} label="Move-in" value={selectedProfile.move_in_date} />
                    {selectedProfile.lease_end_date && <DetailRow icon={Building2} label="Lease ends" value={selectedProfile.lease_end_date} />}
                  </div>
                )}
              </div>

              {/* Mobile: tap to expand full card */}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Mobile detail sheet */}
      <AnimatePresence>
        {selectedProfile && (
          <motion.div
            initial={{ opacity: 0, y: '100%' }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className="lg:hidden fixed inset-x-0 bottom-0 z-50 bg-white rounded-t-3xl shadow-2xl border-t border-zinc-100 max-h-[80vh] overflow-y-auto"
          >
            <div className="sticky top-0 bg-zinc-900 px-5 py-4 flex items-center justify-between rounded-t-3xl">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center text-white font-bold text-lg">
                  {selectedProfile.full_name?.charAt(0)?.toUpperCase()}
                </div>
                <div>
                  <p className="text-white font-bold text-sm">{selectedProfile.full_name}</p>
                  <p className="text-zinc-400 text-xs capitalize">{selectedProfile.residency_type || 'Resident'}</p>
                </div>
              </div>
              <button onClick={() => setSelectedProfile(null)} className="text-zinc-400 hover:text-white transition-colors p-1">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <DetailRow icon={MapPin} label="Unit" value={
                selectedProfile._unitNumber !== '—'
                  ? `${selectedProfile._unitNumber}${selectedProfile._tower ? ` · Tower ${selectedProfile._tower}` : ''}`
                  : '—'
              } />
              <DetailRow icon={Phone} label="Phone" value={selectedProfile.primary_phone} />
              <DetailRow icon={Mail} label="Email" value={selectedProfile.email || '—'} />
              {selectedProfile._vehicle && <>
                <DetailRow icon={Car} label="Plate" value={selectedProfile._vehicle.plate_number} />
                {selectedProfile._vehicle.parking_spot && <DetailRow icon={MapPin} label="Parking" value={selectedProfile._vehicle.parking_spot} />}
              </>}
              {selectedProfile.emergency_contact_name && (
                <DetailRow icon={Shield} label="Emergency Contact" value={`${selectedProfile.emergency_contact_name}${selectedProfile.emergency_contact_phone ? ` · ${selectedProfile.emergency_contact_phone}` : ''}`} />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {selectedProfile && <div className="lg:hidden fixed inset-0 bg-black/40 z-40" onClick={() => setSelectedProfile(null)} />}
    </div>
  );
}

function DetailRow({ icon: Icon, label, value }) {
  if (!value || value === '—') return (
    <div className="flex items-center gap-3">
      <div className="w-7 h-7 rounded-lg bg-zinc-50 flex items-center justify-center flex-shrink-0">
        <Icon className="w-3.5 h-3.5 text-zinc-300" />
      </div>
      <div>
        <p className="text-[11px] text-zinc-400 uppercase tracking-wide">{label}</p>
        <p className="text-sm text-zinc-300">—</p>
      </div>
    </div>
  );
  return (
    <div className="flex items-center gap-3">
      <div className="w-7 h-7 rounded-lg bg-zinc-50 flex items-center justify-center flex-shrink-0">
        <Icon className="w-3.5 h-3.5 text-zinc-500" />
      </div>
      <div>
        <p className="text-[11px] text-zinc-400 uppercase tracking-wide">{label}</p>
        <p className="text-sm font-medium text-zinc-800">{value}</p>
      </div>
    </div>
  );
}
