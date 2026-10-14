import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    // Admin-only operation
    if (user?.role !== 'admin' && user?.management_role !== 'property_management') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    // Generate all units
    const units = [];
    
    // WEST Tower: floors 2-30
    for (let floor = 2; floor <= 30; floor++) {
      for (let unitNum = 1; unitNum <= 14; unitNum++) {
        const unit_number = `${floor}${unitNum.toString().padStart(2, '0')}`;
        units.push({
          tower: 'W',
          floor: floor,
          unit_number: unit_number,
          unit_suffix: 'W',
          display_unit: `${unit_number} W`,
          active: true
        });
      }
    }
    
    // EST Tower: floors 2-29
    for (let floor = 2; floor <= 29; floor++) {
      for (let unitNum = 1; unitNum <= 14; unitNum++) {
        const unit_number = `${floor}${unitNum.toString().padStart(2, '0')}`;
        units.push({
          tower: 'E',
          floor: floor,
          unit_number: unit_number,
          unit_suffix: 'E',
          display_unit: `${unit_number} E`,
          active: true
        });
      }
    }

    // Check if units already exist
    const existingUnits = await base44.asServiceRole.entities.Unit.list('-created_date', 1);
    if (existingUnits.length > 0) {
      return Response.json({ 
        error: 'Units already exist. Delete existing units first if you want to reseed.' 
      }, { status: 400 });
    }

    // Bulk create all units
    console.log(`Creating ${units.length} units...`);
    await base44.asServiceRole.entities.Unit.bulkCreate(units);

    return Response.json({ 
      success: true, 
      message: `Successfully created ${units.length} units`,
      breakdown: {
        westTower: 29 * 14, // floors 2-30
        estTower: 28 * 14   // floors 2-29
      }
    });
  } catch (error) {
    console.error('Seed units error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});