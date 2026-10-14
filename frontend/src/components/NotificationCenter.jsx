import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';

export default function NotificationCenter({ user }) {
    const [isOpen, setIsOpen] = useState(false);
    const navigate = useNavigate();
    const queryClient = useQueryClient();

    const { data: notifications = [] } = useQuery({
        queryKey: ['notifications', user?.id],
        queryFn: async () => {
            if (!user) return [];
            
            // Fetch notifications targeted to this specific user
            // 1. Announcements (global - type: 'announcement')
            // 2. Notifications with target_user_id matching this user
            // 3. Notifications with target_role matching user's role
            
            const allNotifications = await base44.entities.Notification.list('-created_date', 100);
            
            const userRole = user.management_role || user.app_role;
            
            return allNotifications.filter(n => {
                // Global announcements
                if (n.type === 'announcement') return true;
                
                // Directly targeted to this user
                if (n.target_user_id && n.target_user_id === user.id) return true;
                
                // Targeted to user's role (for management/security workers)
                if (n.target_role && n.target_role === userRole) return true;
                
                return false;
            });
        },
        refetchInterval: 30000, // Poll every 30s
        enabled: !!user
    });

    const markReadMutation = useMutation({
        mutationFn: (id) => base44.entities.Notification.update(id, { is_read: true }),
        onSuccess: () => {
            queryClient.invalidateQueries(['notifications']);
        }
    });

    const unreadCount = notifications.filter(n => !n.is_read).length;

    const handleNotificationClick = (n) => {
        if (!n.is_read) {
            markReadMutation.mutate(n.id);
        }
        if (n.link) {
            navigate(createPageUrl(n.link));
            setIsOpen(false);
        }
    };

    return (
        <Popover open={isOpen} onOpenChange={setIsOpen}>
            <PopoverTrigger asChild>
                <Button variant="outline" className="relative rounded-full h-10 w-10 p-0">
                    <Bell className="w-4 h-4" />
                    {unreadCount > 0 && (
                        <Badge className="absolute -top-1 -right-1 h-5 w-5 flex items-center justify-center p-0 bg-red-500 text-white text-xs rounded-full">
                            {unreadCount}
                        </Badge>
                    )}
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80 p-0" align="end">
                <div className="p-4 border-b border-zinc-100">
                    <h4 className="font-semibold">Notifications</h4>
                </div>
                <ScrollArea className="h-[300px]">
                    {notifications.length === 0 ? (
                        <div className="p-4 text-center text-sm text-zinc-500">
                            No notifications
                        </div>
                    ) : (
                        <div className="divide-y divide-zinc-100">
                            {notifications.map(n => (
                                <div 
                                    key={n.id} 
                                    className={`p-4 cursor-pointer hover:bg-zinc-50 transition-colors ${!n.is_read ? 'bg-blue-50/50' : ''}`}
                                    onClick={() => handleNotificationClick(n)}
                                >
                                    <div className="flex justify-between items-start mb-1">
                                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${getTypeStyle(n.type)}`}>
                                            {n.type.replace('_', ' ')}
                                        </span>
                                        <span className="text-[10px] text-zinc-400">
                                            {format(new Date(n.created_date), 'MMM d, HH:mm')}
                                        </span>
                                    </div>
                                    <h5 className={`text-sm mb-1 ${!n.is_read ? 'font-semibold text-zinc-900' : 'font-medium text-zinc-700'}`}>
                                        {n.title}
                                    </h5>
                                    <p className="text-xs text-zinc-500 line-clamp-2">
                                        {n.message}
                                    </p>
                                </div>
                            ))}
                        </div>
                    )}
                </ScrollArea>
            </PopoverContent>
        </Popover>
    );
}

function getTypeStyle(type) {
    switch (type) {
        case 'package': return 'bg-blue-50 text-blue-700 border-blue-100';
        case 'security': return 'bg-red-50 text-red-700 border-red-100';
        case 'maintenance': return 'bg-amber-50 text-amber-700 border-amber-100';
        case 'amenity': return 'bg-purple-50 text-purple-700 border-purple-100';
        case 'announcement': return 'bg-zinc-100 text-zinc-700 border-zinc-200';
        default: return 'bg-zinc-50 text-zinc-600';
    }
}