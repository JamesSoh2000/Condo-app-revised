import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    // Verify admin access (this is a system maintenance task)
    const user = await base44.auth.me();
    if (user?.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    // Calculate cutoff date (15 days ago)
    const fifteenDaysAgo = new Date();
    fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);
    const cutoffDate = fifteenDaysAgo.toISOString();

    console.log('[CLEANUP] Starting cleanup for archives older than:', cutoffDate);

    // Fetch all archived records (using service role for full access)
    const allArchives = await base44.asServiceRole.entities.UpdateArchive.list('-archivedAt', 500);

    // Filter archives older than 15 days
    const oldArchives = allArchives.filter(archive => {
      return new Date(archive.archivedAt) < fifteenDaysAgo;
    });

    console.log('[CLEANUP] Found', oldArchives.length, 'archives to delete');

    // Delete old archives
    let deletedCount = 0;
    for (const archive of oldArchives) {
      try {
        await base44.asServiceRole.entities.UpdateArchive.delete(archive.id);
        deletedCount++;
      } catch (error) {
        console.error('[CLEANUP] Failed to delete archive:', archive.id, error.message);
      }
    }

    console.log('[CLEANUP] Successfully deleted', deletedCount, 'archived records');

    return Response.json({
      success: true,
      totalFound: oldArchives.length,
      deleted: deletedCount,
      cutoffDate: cutoffDate
    });
  } catch (error) {
    console.error('[CLEANUP] Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});
