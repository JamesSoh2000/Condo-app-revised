import { base44 } from '@/api/base44Client';

/**
 * Helper to create notifications with optional email alerts
 * @param {Object} notification - Notification data (title, message, type, target_unit, target_role, link)
 * @param {Object} options - { sendEmail: boolean, recipientEmail: string, recipientName: string }
 */
export async function createNotification(notification, options = {}) {
  // Create in-app notification
  const notif = await base44.entities.Notification.create(notification);

  // Send email if requested
  if (options.sendEmail && options.recipientEmail) {
    try {
      await base44.integrations.Core.SendEmail({
        to: options.recipientEmail,
        subject: `EstWest: ${notification.title}`,
        body: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: linear-gradient(135deg, #18181b 0%, #27272a 100%); padding: 30px; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 24px;">EstWest Condominiums</h1>
            </div>
            <div style="padding: 30px; background: #ffffff;">
              <h2 style="color: #18181b; margin-top: 0;">${notification.title}</h2>
              <p style="color: #52525b; line-height: 1.6; font-size: 16px;">${notification.message}</p>
              ${notification.link ? `
                <div style="margin-top: 30px;">
                  <a href="${import.meta.env.VITE_APP_URL || 'https://app.base44.com'}/${notification.link}" 
                     style="background: #18181b; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block;">
                    View Details
                  </a>
                </div>
              ` : ''}
            </div>
            <div style="padding: 20px; text-align: center; color: #71717a; font-size: 12px; background: #fafafa;">
              <p>EstWest Condominiums | Your Luxury Living Experience</p>
            </div>
          </div>
        `
      });
    } catch (error) {
      console.error('Failed to send email notification:', error);
      // Don't throw - notification is still created in-app
    }
  }

  return notif;
}

/**
 * Notify resident about package arrival
 */
export async function notifyPackageArrival(packageData, residentEmail) {
  return createNotification({
    title: 'Package Arrived',
    message: `A package from ${packageData.carrier} has arrived. Pick it up at the front desk.`,
    type: 'package',
    target_unit: packageData.unit_number,
    link: 'packages'
  }, {
    sendEmail: true,
    recipientEmail: residentEmail
  });
}

/**
 * Notify management about new maintenance request
 */
export async function notifyMaintenanceRequest(ticket, managementEmails) {
  const notif = await createNotification({
    title: 'New Maintenance Request',
    message: `${ticket.priority.toUpperCase()} priority: ${ticket.title} (${ticket.type})`,
    type: 'maintenance',
    target_role: 'property_management',
    link: 'ManagementMaintenance'
  });

  // Send email to all management staff
  if (managementEmails && managementEmails.length > 0) {
    for (const email of managementEmails) {
      try {
        await base44.integrations.Core.SendEmail({
          to: email,
          subject: `EstWest: New Maintenance Request - ${ticket.priority.toUpperCase()}`,
          body: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: #dc2626; padding: 30px; text-align: center;">
                <h1 style="color: white; margin: 0;">Maintenance Request</h1>
              </div>
              <div style="padding: 30px; background: #ffffff;">
                <h2 style="color: #18181b;">${ticket.title}</h2>
                <p style="margin: 10px 0;"><strong>Priority:</strong> <span style="color: ${ticket.priority === 'high' ? '#dc2626' : ticket.priority === 'medium' ? '#ea580c' : '#71717a'}">${ticket.priority.toUpperCase()}</span></p>
                <p style="margin: 10px 0;"><strong>Type:</strong> ${ticket.type.replace('_', ' ')}</p>
                <p style="margin: 10px 0;"><strong>Location:</strong> ${ticket.location || 'Not specified'}</p>
                <p style="color: #52525b; margin-top: 20px;">${ticket.description}</p>
              </div>
            </div>
          `
        });
      } catch (error) {
        console.error('Failed to email management:', error);
      }
    }
  }

  return notif;
}

/**
 * Notify resident about maintenance update
 */
export async function notifyMaintenanceUpdate(ticket, newStatus, residentEmail) {
  return createNotification({
    title: 'Maintenance Update',
    message: `Your maintenance request "${ticket.title}" is now ${newStatus}.`,
    type: 'maintenance',
    target_unit: ticket.location || '',
    link: 'Maintenance'
  }, {
    sendEmail: true,
    recipientEmail: residentEmail
  });
}

/**
 * Notify resident about amenity booking confirmation
 */
export async function notifyAmenityConfirmation(reservation, residentEmail, approved = true) {
  return createNotification({
    title: approved ? 'Reservation Approved' : 'Reservation Status Update',
    message: approved 
      ? `Your ${reservation.room_type} reservation for ${reservation.date} at ${reservation.start_time} has been approved!`
      : `Your ${reservation.room_type} reservation status has changed to: ${reservation.status}`,
    type: 'amenity',
    target_unit: reservation.resident_unit,
    link: 'Speakeasy'
  }, {
    sendEmail: true,
    recipientEmail: residentEmail
  });
}

/**
 * Notify security about incident
 */
export async function notifySecurityIncident(report, securityEmails) {
  const notif = await createNotification({
    title: `Security Report: ${report.type.toUpperCase()}`,
    message: `${report.location}: ${report.description}`,
    type: 'security',
    target_role: 'security',
    link: 'SecurityReportsList'
  });

  if (securityEmails && securityEmails.length > 0) {
    for (const email of securityEmails) {
      try {
        await base44.integrations.Core.SendEmail({
          to: email,
          subject: `EstWest Security Alert: ${report.type.toUpperCase()}`,
          body: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: #dc2626; padding: 30px; text-align: center;">
                <h1 style="color: white; margin: 0;">⚠️ Security Report</h1>
              </div>
              <div style="padding: 30px; background: #ffffff;">
                <p style="margin: 10px 0;"><strong>Type:</strong> ${report.type.toUpperCase()}</p>
                <p style="margin: 10px 0;"><strong>Location:</strong> ${report.location}</p>
                <p style="color: #52525b; margin-top: 20px;">${report.description}</p>
              </div>
            </div>
          `
        });
      } catch (error) {
        console.error('Failed to email security:', error);
      }
    }
  }

  return notif;
}

/**
 * Get all user emails by role
 */
export async function getUserEmailsByRole(role) {
  try {
    const users = await base44.entities.User.list();
    return users
      .filter(u => (u.management_role === role || u.app_role === role) && u.email)
      .map(u => u.email);
  } catch (error) {
    console.error('Failed to fetch users by role:', error);
    return [];
  }
}