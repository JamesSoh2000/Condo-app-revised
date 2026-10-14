import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    // Admin-only operation
    if (user?.role !== 'admin' && user?.management_role !== 'property_management') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const results = {
      profilesMigrated: 0,
      residentProfilesMigrated: 0,
      packagesMigrated: 0,
      errors: []
    };

    // Get all units for lookup
    const allUnits = await base44.asServiceRole.entities.Unit.list('-created_date', 1000);
    const unitMap = new Map();
    allUnits.forEach(unit => {
      const key = `${unit.unit_number}_${unit.tower}`;
      unitMap.set(key, unit);
    });

    // Migrate Profile records
    const profiles = await base44.asServiceRole.entities.Profile.list('-created_date', 500);
    for (const profile of profiles) {
      if (profile.unit_id) continue; // Already migrated
      
      if (profile.unit_number) {
        // Parse unit_number like "1314 E" or "1314"
        const parts = profile.unit_number.toString().trim().split(/\s+/);
        const unitNum = parts[0];
        const tower = parts[1] || (unitNum.startsWith('1') ? 'E' : 'W');
        
        const key = `${unitNum}_${tower}`;
        const unit = unitMap.get(key);
        
        if (unit) {
          await base44.asServiceRole.entities.Profile.update(profile.id, {
            unit_id: unit.id
          });
          results.profilesMigrated++;
        } else {
          results.errors.push(`Profile ${profile.id}: No unit found for ${unitNum} ${tower}`);
        }
      }
    }

    // Migrate ResidentProfile records
    const residentProfiles = await base44.asServiceRole.entities.ResidentProfile.list('-created_date', 500);
    for (const residentProfile of residentProfiles) {
      if (residentProfile.unit_id) continue;
      
      if (residentProfile.unit_number) {
        const parts = residentProfile.unit_number.toString().trim().split(/\s+/);
        const unitNum = parts[0];
        const tower = parts[1] || (unitNum.startsWith('1') ? 'E' : 'W');
        
        const key = `${unitNum}_${tower}`;
        const unit = unitMap.get(key);
        
        if (unit) {
          await base44.asServiceRole.entities.ResidentProfile.update(residentProfile.id, {
            unit_id: unit.id
          });
          results.residentProfilesMigrated++;
        } else {
          results.errors.push(`ResidentProfile ${residentProfile.id}: No unit found for ${unitNum} ${tower}`);
        }
      }
    }

    // Migrate Package records
    const packages = await base44.asServiceRole.entities.Package.list('-created_date', 1000);
    for (const pkg of packages) {
      if (pkg.unit_id) continue;
      
      if (pkg.unit_number && pkg.tower) {
        const key = `${pkg.unit_number}_${pkg.tower}`;
        const unit = unitMap.get(key);
        
        if (unit) {
          await base44.asServiceRole.entities.Package.update(pkg.id, {
            unit_id: unit.id
          });
          results.packagesMigrated++;
        } else {
          results.errors.push(`Package ${pkg.id}: No unit found for ${pkg.unit_number} ${pkg.tower}`);
        }
      }
    }

    return Response.json({ 
      success: true, 
      ...results
    });
  } catch (error) {
    console.error('Migration error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});