import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    // Only admin users can run this cleanup
    if (user?.role !== 'admin') {
      console.error('[CLEANUP] Forbidden: Admin access required');
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    console.log('[CLEANUP] Starting package cleanup job...');

    // Calculate 30 days ago
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const cutoffDate = thirtyDaysAgo.toISOString();

    console.log('[CLEANUP] Cutoff date:', cutoffDate);

    // Fetch all packages
    const allPackages = await base44.asServiceRole.entities.Package.list('-created_date', 1000);
    console.log('[CLEANUP] Total packages in system:', allPackages.length);

    // Filter packages older than 30 days
    const packagesToDelete = allPackages.filter(pkg => {
      // Use picked_up_at for picked up packages, created_date for unpicked
      const referenceDate = pkg.picked_up_at || pkg.created_date;
      return new Date(referenceDate) < new Date(cutoffDate);
    });

    console.log('[CLEANUP] Packages to delete:', packagesToDelete.length);

    if (packagesToDelete.length === 0) {
      console.log('[CLEANUP] No old packages to delete');
      return Response.json({
        success: true,
        message: 'No packages older than 30 days found',
        deleted: 0
      });
    }

    const deletedPackageIds = [];
    let deletedNotifications = 0;

    // Delete each package and its related data
    for (const pkg of packagesToDelete) {
      try {
        // Delete related notifications
        const notifications = await base44.asServiceRole.entities.Notification.filter({
          related_entity_id: pkg.id
        });

        for (const notif of notifications) {
          await base44.asServiceRole.entities.Notification.delete(notif.id);
          deletedNotifications++;
        }

        // Delete the package
        await base44.asServiceRole.entities.Package.delete(pkg.id);
        deletedPackageIds.push(pkg.id);

        console.log('[CLEANUP] Deleted package:', pkg.id, 'from', pkg.created_date);
      } catch (error) {
        console.error('[CLEANUP] Error deleting package', pkg.id, ':', error.message);
      }
    }

    console.log('[CLEANUP] Cleanup complete. Deleted:', deletedPackageIds.length, 'packages and', deletedNotifications, 'notifications');

    return Response.json({
      success: true,
      message: `Deleted ${deletedPackageIds.length} packages older than 30 days`,
      deleted: deletedPackageIds.length,
      deletedNotifications: deletedNotifications,
      cutoffDate: cutoffDate
    });
  } catch (error) {
    console.error('[CLEANUP] Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});
