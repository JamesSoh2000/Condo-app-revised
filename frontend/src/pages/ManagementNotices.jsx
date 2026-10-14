import React, { useState, useEffect, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import {
  ChevronLeft, ChevronRight, Plus, RefreshCw, CheckCircle2,
  CalendarDays
} from 'lucide-react';
import {
  format, startOfWeek, endOfWeek, startOfMonth, endOfMonth,
  eachDayOfInterval, isSameDay, addWeeks, subWeeks, addMonths, subMonths,
  parseISO, isBefore, isAfter
} from 'date-fns';
import AgendaCard from '@/components/calendar/AgendaCard';
import CreateTaskModal from '@/components/calendar/CreateTaskModal';
import CreateEventModal from '@/components/calendar/CreateEventModal';
import EventDetailModal from '@/components/calendar/EventDetailModal';
import EventSyncPrompt from '@/components/calendar/EventSyncPrompt';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

function buildNoticeFromEvent(event) {
  const dateStr = event.end_date && event.end_date !== event.start_date
    ? `${format(parseISO(event.start_date), 'MMM d')}–${format(parseISO(event.end_date), 'MMM d, yyyy')}`
    : format(parseISO(event.start_date), 'MMMM d, yyyy');

  const timeStr = event.all_day
    ? 'All Day'
    : event.start_time
      ? (event.end_time ? `${event.start_time}–${event.end_time}` : event.start_time)
      : null;

  const parts = [dateStr];
  if (timeStr) parts.push(timeStr);
  if (event.location) parts.push(event.location);

  const CATEGORY_MAP = {
    building_event: 'general',
    maintenance_event: 'maintenance',
    community_event: 'general',
    inspection: 'maintenance',
    shutdown: 'maintenance',
    general_notice: 'general'
  };

  return {
    title: `Building Event: ${event.title}`,
    message: `${parts.join(' · ')}${event.description ? '\n\n' + event.description : ''}`,
    type: CATEGORY_MAP[event.category] || 'general',
    startTime: event.start_date ? new Date(event.start_date + 'T00:00:00').toISOString() : undefined,
    endTime: event.end_date ? new Date(event.end_date + 'T23:59:00').toISOString() : undefined,
    location: event.location,
    isActive: true
  };
}

export default function ManagementNotices() {
  const [user, setUser] = useState(null);
  const [viewMode, setViewMode] = useState('week');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [activeFilter, setActiveFilter] = useState('all');
  const [createTaskOpen, setCreateTaskOpen] = useState(false);
  const [createEventOpen, setCreateEventOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState(null);
  const [viewingEvent, setViewingEvent] = useState(null);
  const [selectedAgendaItem, setSelectedAgendaItem] = useState(null);
  const [syncPrompt, setSyncPrompt] = useState(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    base44.auth.me().then(setUser);
  }, []);

  const { data: moveRequests } = useQuery({
    queryKey: ['move-requests-calendar'],
    queryFn: () => base44.entities.MoveRequest.list('-date', 100),
    refetchInterval: 30000
  });

  const { data: buildingUpdates } = useQuery({
    queryKey: ['building-updates-calendar'],
    queryFn: () => base44.entities.BuildingUpdate.list('-created_date', 100),
    refetchInterval: 30000
  });

  const { data: securityReports } = useQuery({
    queryKey: ['security-reports-calendar'],
    queryFn: () => base44.entities.Report.filter({ type: 'incident', isDeleted: false }, '-created_date', 100),
    refetchInterval: 30000
  });

  const { data: securityTasks } = useQuery({
    queryKey: ['security-tasks-calendar'],
    queryFn: () => base44.entities.SecurityTask.list('-date', 100),
    refetchInterval: 10000
  });

  const { data: calendarEvents } = useQuery({
    queryKey: ['calendar-events'],
    queryFn: () => base44.entities.CalendarEvent.list('-start_date', 200),
    refetchInterval: 15000
  });

  const { data: speakeasyReservations } = useQuery({
    queryKey: ['speakeasy-reservations-calendar'],
    queryFn: () => base44.entities.SpeakeasyReservation.filter({ status: 'approved' }, '-date', 100),
    refetchInterval: 30000
  });

  const createTaskMutation = useMutation({
    mutationFn: async (data) => base44.entities.SecurityTask.create({
      ...data, createdByUserId: user.id, createdByName: user.full_name, status: 'open'
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['security-tasks-calendar'] });
      toast.success('Task created');
      setCreateTaskOpen(false);
    }
  });

  const createCalendarEventMutation = useMutation({
    mutationFn: async (data) => {
      const eventData = {
        ...data,
        created_by_user_id: user.id,
        created_by_name: user.full_name,
        status: 'active'
      };
      const created = await base44.entities.CalendarEvent.create(eventData);
      if (data.send_to_residents) {
        const notice = await base44.entities.BuildingUpdate.create({
          ...buildNoticeFromEvent(data),
          postedByUserId: user.id,
          postedByName: user.full_name,
          postedByRole: 'management'
        });
        await base44.entities.CalendarEvent.update(created.id, { linked_notice_id: notice.id });
      }
      return created;
    },
    onSuccess: (_, data) => {
      queryClient.invalidateQueries({ queryKey: ['calendar-events'] });
      queryClient.invalidateQueries({ queryKey: ['building-updates-calendar'] });
      toast.success(data.send_to_residents ? 'Event created and posted to resident Updates & Alerts' : 'Event created');
      setCreateEventOpen(false);
    }
  });

  const updateCalendarEventMutation = useMutation({
    mutationFn: async ({ id, data, updateNotice, linkedNoticeId }) => {
      await base44.entities.CalendarEvent.update(id, data);
      if (updateNotice && linkedNoticeId) {
        await base44.entities.BuildingUpdate.update(linkedNoticeId, {
          ...buildNoticeFromEvent(data),
          postedByUserId: user.id,
          postedByName: user.full_name
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendar-events'] });
      queryClient.invalidateQueries({ queryKey: ['building-updates-calendar'] });
      toast.success('Event updated');
      setEditingEvent(null);
      setCreateEventOpen(false);
      setSyncPrompt(null);
    }
  });

  const deleteCalendarEventMutation = useMutation({
    mutationFn: async ({ id, noticeId }) => {
      await base44.entities.CalendarEvent.delete(id);
      if (noticeId) await base44.entities.BuildingUpdate.delete(noticeId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendar-events'] });
      queryClient.invalidateQueries({ queryKey: ['building-updates-calendar'] });
      toast.success('Event deleted');
      setViewingEvent(null);
    }
  });

  const completeCalendarEventMutation = useMutation({
    mutationFn: async (event) => base44.entities.CalendarEvent.update(event.id, { status: 'completed' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendar-events'] });
      toast.success('Event marked complete');
      setViewingEvent(null);
    }
  });

  const completeItemMutation = useMutation({
    mutationFn: async (item) => {
      if (item.itemType === 'task') return base44.entities.SecurityTask.update(item.rawData.id, { status: 'completed', completedAt: new Date().toISOString(), completedByUserId: user.id });
      if (item.itemType === 'move') return base44.entities.MoveRequest.update(item.rawData.id, { status: 'completed' });
      if (item.itemType === 'event') return base44.entities.BuildingUpdate.update(item.rawData.id, { isActive: false });
      if (item.itemType === 'incident') return base44.entities.Report.update(item.rawData.id, { status: 'reviewed' });
    },
    onSuccess: (_, item) => {
      const keyMap = { task: 'security-tasks-calendar', move: 'move-requests-calendar', event: 'building-updates-calendar', incident: 'security-reports-calendar' };
      queryClient.invalidateQueries({ queryKey: [keyMap[item.itemType]] });
      toast.success('Item marked as completed');
      setSelectedAgendaItem(null);
    }
  });

  const handleEventSubmit = async (data) => {
    if (editingEvent) {
      if (editingEvent.send_to_residents && editingEvent.linked_notice_id) {
        setSyncPrompt({ event: editingEvent, updatedData: data });
        setCreateEventOpen(false);
      } else {
        await updateCalendarEventMutation.mutateAsync({ id: editingEvent.id, data, updateNotice: false });
      }
    } else {
      await createCalendarEventMutation.mutateAsync(data);
    }
  };

  const handleSyncPromptUpdate = async (updateNotice) => {
    await updateCalendarEventMutation.mutateAsync({
      id: syncPrompt.event.id,
      data: syncPrompt.updatedData,
      updateNotice,
      linkedNoticeId: syncPrompt.event.linked_notice_id
    });
  };

  const allAgendaItems = useMemo(() => {
    const items = [];
    (speakeasyReservations || []).forEach(res => {
      if (!res.date) return;
      items.push({
        id: `speakeasy-${res.id}`,
        itemType: 'speakeasy',
        title: `Speakeasy: ${res.room_type}`,
        date: res.date,
        timeWindow: `${res.start_time} – ${res.end_time}`,
        sortTime: res.start_time || '99:99',
        notes: `${res.resident_name || ''} · Unit ${res.resident_unit || ''}`,
        status: 'active',
        rawData: res
      });
    });
    (moveRequests || []).forEach(req => {
      items.push({
        id: `move-${req.id}`,
        itemType: 'move',
        title: `${req.requestType === 'move_in' ? 'Move In' : 'Move Out'} – Unit ${req.unitNumber} ${req.tower}`,
        date: req.date,
        timeWindow: `${req.startTime} – ${req.endTime}`,
        sortTime: req.startTime || '99:99',
        statusBadge: req.status === 'approved' ? 'Approved' : req.status === 'pending' ? 'Pending' : 'Declined',
        status: req.status,
        notes: req.notes,
        rawData: req
      });
    });
    (buildingUpdates || []).filter(u => u.startTime).forEach(event => {
      items.push({
        id: `event-${event.id}`,
        itemType: 'event',
        title: event.title,
        date: event.startTime.split('T')[0],
        timeWindow: event.endTime
          ? `${format(parseISO(event.startTime), 'HH:mm')} – ${format(parseISO(event.endTime), 'HH:mm')}`
          : format(parseISO(event.startTime), 'HH:mm'),
        sortTime: format(parseISO(event.startTime), 'HH:mm'),
        location: event.location,
        notes: event.message,
        status: event.isActive === false ? 'completed' : 'active',
        rawData: event
      });
    });
    (securityReports || []).forEach(report => {
      items.push({
        id: `incident-${report.id}`,
        itemType: 'incident',
        title: report.subject,
        date: report.created_date.split('T')[0],
        sortTime: report.created_date ? format(parseISO(report.created_date), 'HH:mm') : '99:99',
        location: report.location,
        notes: report.description,
        status: report.status === 'reviewed' ? 'completed' : 'active',
        statusBadge: report.status === 'reviewed' ? 'Reviewed' : 'New',
        rawData: report
      });
    });
    (securityTasks || []).forEach(task => {
      items.push({
        id: `task-${task.id}`,
        itemType: 'task',
        title: task.title,
        date: task.date,
        timeWindow: task.endTime ? `${task.startTime} – ${task.endTime}` : task.startTime,
        sortTime: task.startTime || '99:99',
        notes: task.notes,
        status: task.status,
        canComplete: user && task.createdByUserId === user.id,
        rawData: task
      });
    });
    return items;
  }, [moveRequests, buildingUpdates, securityReports, securityTasks, speakeasyReservations, user]);

  const getCalendarEventsForDay = (day) => {
    if (!calendarEvents) return [];
    return calendarEvents.filter(ev => {
      if (!ev.start_date) return false;
      const start = parseISO(ev.start_date);
      const end = ev.end_date ? parseISO(ev.end_date) : start;
      return !isBefore(day, start) && !isAfter(day, end);
    });
  };

  const { activeItems, completedItems } = useMemo(() => {
    let filtered = allAgendaItems.filter(item => isSameDay(parseISO(item.date), selectedDate));
    if (activeFilter === 'events') return { activeItems: [], completedItems: [] };
    if (activeFilter !== 'all') {
      const filterMap = { move: 'move', tasks: 'task', incidents: 'incident', speakeasy: 'speakeasy' };
      filtered = filtered.filter(item => item.itemType === filterMap[activeFilter]);
    }
    const getSortTime = (item) => {
      if (item.sortTime) return item.sortTime;
      if (item.timeWindow) return item.timeWindow.split('–')[0].trim();
      return '99:99';
    };
    const active = filtered.filter(i => i.status !== 'completed').sort((a, b) => getSortTime(a).localeCompare(getSortTime(b)));
    const completed = filtered.filter(i => i.status === 'completed').sort((a, b) => getSortTime(a).localeCompare(getSortTime(b)));
    return { activeItems: active, completedItems: completed };
  }, [allAgendaItems, selectedDate, activeFilter]);

  const calendarEventsForSelected = useMemo(() => {
    if (activeFilter !== 'all' && activeFilter !== 'events') return [];
    return getCalendarEventsForDay(selectedDate);
  }, [calendarEvents, selectedDate, activeFilter]);

  const calendarDays = useMemo(() => {
    const start = viewMode === 'week' ? startOfWeek(currentDate, { weekStartsOn: 0 }) : startOfMonth(currentDate);
    const end = viewMode === 'week' ? endOfWeek(currentDate, { weekStartsOn: 0 }) : endOfMonth(currentDate);
    return eachDayOfInterval({ start, end });
  }, [currentDate, viewMode]);

  const getDayMarkers = (day) => {
    const legacy = allAgendaItems.filter(item => isSameDay(parseISO(item.date), day));
    const types = new Set(legacy.map(i => i.itemType));
    if (getCalendarEventsForDay(day).length > 0) types.add('cal_event');
    return Array.from(types);
  };

  const markerColors = { move: 'bg-blue-500', event: 'bg-orange-400', cal_event: 'bg-orange-600', task: 'bg-purple-500', incident: 'bg-red-500', speakeasy: 'bg-green-500' };

  const navigate = (dir) => {
    if (viewMode === 'week') setCurrentDate(dir === 'next' ? addWeeks(currentDate, 1) : subWeeks(currentDate, 1));
    else setCurrentDate(dir === 'next' ? addMonths(currentDate, 1) : subMonths(currentDate, 1));
  };

  if (!user) return null;

  const isSecurity = user.management_role === 'security' || user.app_role === 'security';
  const isPropertyManagement = user.management_role === 'property_management' || user.app_role === 'property_management';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold">Daily Notices</h1>
          <p className="text-zinc-500 mt-1">Building event calendar and operational view</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {(isSecurity || isPropertyManagement) && (
            <Button onClick={() => { setEditingEvent(null); setCreateEventOpen(true); }} className="bg-orange-600 hover:bg-orange-700">
              <CalendarDays className="w-4 h-4 mr-2" />
              Add Building Event
            </Button>
          )}
          {(isSecurity || isPropertyManagement) && (
            <Button variant="outline" onClick={() => setCreateTaskOpen(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Add Task
            </Button>
          )}
          <Button variant="outline" size="icon" onClick={() => {
            ['calendar-events', 'move-requests-calendar', 'building-updates-calendar', 'security-reports-calendar', 'security-tasks-calendar']
              .forEach(k => queryClient.invalidateQueries({ queryKey: [k] }));
          }}>
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Calendar */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="icon" onClick={() => navigate('prev')}><ChevronLeft className="w-4 h-4" /></Button>
                  <h3 className="font-semibold text-sm">
                    {viewMode === 'week'
                      ? `Week of ${format(startOfWeek(currentDate, { weekStartsOn: 0 }), 'MMM d, yyyy')}`
                      : format(currentDate, 'MMMM yyyy')}
                  </h3>
                  <Button variant="outline" size="icon" onClick={() => navigate('next')}><ChevronRight className="w-4 h-4" /></Button>
                </div>
                <div className="flex gap-2">
                  <Button variant={viewMode === 'week' ? 'default' : 'outline'} size="sm" onClick={() => setViewMode('week')}>Week</Button>
                  <Button variant={viewMode === 'month' ? 'default' : 'outline'} size="sm" onClick={() => setViewMode('month')}>Month</Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-7 gap-1 mb-1">
                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
                  <div key={d} className="text-center text-xs font-semibold text-zinc-400 py-1">{d}</div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1">
                {calendarDays.map(day => {
                  const dayCalEvents = getCalendarEventsForDay(day);
                  const markers = getDayMarkers(day);
                  const isSelected = isSameDay(day, selectedDate);
                  const isToday = isSameDay(day, new Date());
                  return (
                    <button
                      key={day.toISOString()}
                      onClick={() => {
                        setSelectedDate(day);
                      }}
                      onDoubleClick={() => {
                        setSelectedDate(day);
                        setEditingEvent(null);
                        setCreateEventOpen(true);
                      }}
                      className={`min-h-[60px] p-1.5 rounded-lg border-2 transition-all text-left w-full
                        ${isSelected ? 'border-zinc-900 bg-zinc-100' : 'border-zinc-100 hover:border-zinc-300 bg-white'}
                        ${isToday && !isSelected ? 'bg-blue-50 border-blue-200' : ''}`}
                    >
                      <div className={`text-sm font-semibold mb-1 ${isToday ? 'text-blue-600' : 'text-zinc-700'}`}>{format(day, 'd')}</div>
                      {dayCalEvents.slice(0, 2).map(ev => (
                        <div
                          key={ev.id}
                          className="text-[10px] font-medium bg-orange-500 text-white rounded px-1 py-0.5 mb-0.5 truncate leading-tight cursor-pointer hover:bg-orange-600"
                          onClick={(e) => { e.stopPropagation(); setSelectedDate(day); setViewingEvent(ev); }}
                          title={ev.title}
                        >
                          {ev.title}
                        </div>
                      ))}
                      {dayCalEvents.length > 2 && <div className="text-[10px] text-zinc-400">+{dayCalEvents.length - 2} more</div>}
                      {markers.filter(m => m !== 'cal_event').length > 0 && (
                        <div className="flex gap-0.5 mt-1">
                          {markers.filter(m => m !== 'cal_event').slice(0, 3).map(type => (
                            <div key={type} className={`w-1.5 h-1.5 rounded-full ${markerColors[type]}`} />
                          ))}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap gap-3 mt-4 pt-3 border-t border-zinc-100">
                <span className="flex items-center gap-1 text-xs text-zinc-500"><span className="w-3 h-3 rounded bg-orange-500 inline-block" /> Building Events</span>
                <span className="flex items-center gap-1 text-xs text-zinc-500"><span className="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block" /> Moves</span>
                <span className="flex items-center gap-1 text-xs text-zinc-500"><span className="w-1.5 h-1.5 rounded-full bg-purple-500 inline-block" /> Tasks</span>
                <span className="flex items-center gap-1 text-xs text-zinc-500"><span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block" /> Incidents</span>
                <span className="flex items-center gap-1 text-xs text-zinc-500"><span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" /> Speakeasy</span>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Agenda Panel */}
        <div className="lg:col-span-1">
          <Card className="sticky top-4">
            <CardHeader>
              <CardTitle>
                Agenda
                <div className="text-sm font-normal text-zinc-500 mt-1">{format(selectedDate, 'EEEE – MMM d')}</div>
              </CardTitle>
              <div className="flex flex-wrap gap-1 mt-2">
                {[['all', 'All'], ['events', 'Events'], ['move', 'Moves'], ['tasks', 'Tasks'], ['incidents', 'Incidents'], ['speakeasy', 'Speakeasy']].map(([f, label]) => (
                  <Button key={f} variant={activeFilter === f ? 'default' : 'outline'} size="sm" onClick={() => setActiveFilter(f)} className="text-xs h-7 px-2">
                    {label}
                  </Button>
                ))}
              </div>
            </CardHeader>
            <CardContent className="space-y-3 overflow-y-auto" style={{ maxHeight: '520px' }}>
              {calendarEventsForSelected.map(ev => {
                const isMulti = ev.end_date && ev.end_date !== ev.start_date;
                const timeStr = ev.all_day ? 'All Day' : ev.start_time ? (ev.end_time ? `${ev.start_time}–${ev.end_time}` : ev.start_time) : null;
                return (
                  <div
                    key={ev.id}
                    className={`p-3 rounded-xl border-2 cursor-pointer transition-all hover:shadow-md
                      ${ev.status === 'completed' ? 'bg-zinc-50 border-zinc-200 opacity-60' : 'bg-orange-50 border-orange-300'}`}
                    onClick={() => setViewingEvent(ev)}
                  >
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <Badge className="bg-orange-600 text-white text-xs px-2">{isMulti ? 'MULTI-DAY' : 'EVENT'}</Badge>
                      {ev.send_to_residents && <Badge className="bg-green-100 text-green-700 text-xs px-1.5">Sent to Residents</Badge>}
                      {ev.status === 'completed' && <Badge className="bg-green-600 text-white text-xs">Done</Badge>}
                    </div>
                    <p className={`font-semibold text-sm ${ev.status === 'completed' ? 'line-through text-zinc-400' : ''}`}>{ev.title}</p>
                    {timeStr && <p className="text-xs text-zinc-500 mt-0.5">{timeStr}</p>}
                    {ev.location && <p className="text-xs text-zinc-400 mt-0.5">{ev.location}</p>}
                    {isMulti && <p className="text-xs text-orange-600 mt-1 font-medium">{format(parseISO(ev.start_date), 'MMM d')} – {format(parseISO(ev.end_date), 'MMM d')}</p>}
                  </div>
                );
              })}

              {activeItems.length === 0 && completedItems.length === 0 && calendarEventsForSelected.length === 0 ? (
                <p className="text-center text-zinc-400 py-8 text-sm">No items for this day</p>
              ) : (
                <>
                  {activeItems.map(item => (
                    <AgendaCard key={item.id} item={item} onCardClick={setSelectedAgendaItem} onMarkComplete={(i) => completeItemMutation.mutate(i)} />
                  ))}
                  {completedItems.length > 0 && (
                    <div className="mt-4">
                      <div className="flex items-center gap-2 mb-2 pb-1 border-b border-zinc-200">
                        <CheckCircle2 className="w-4 h-4 text-green-600" />
                        <span className="text-xs font-semibold text-zinc-500">Completed ({completedItems.length})</span>
                      </div>
                      {completedItems.map(item => (
                        <AgendaCard key={item.id} item={item} onCardClick={setSelectedAgendaItem} onMarkComplete={(i) => completeItemMutation.mutate(i)} />
                      ))}
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <CreateTaskModal
        open={createTaskOpen}
        onClose={() => setCreateTaskOpen(false)}
        onSubmit={(data) => createTaskMutation.mutate(data)}
        defaultDate={format(selectedDate, 'yyyy-MM-dd')}
      />

      <CreateEventModal
        open={createEventOpen}
        onClose={() => { setCreateEventOpen(false); setEditingEvent(null); }}
        onSubmit={handleEventSubmit}
        defaultDate={format(selectedDate, 'yyyy-MM-dd')}
        editEvent={editingEvent}
        showResidentToggle={isSecurity || isPropertyManagement}
      />

      {viewingEvent && (
        <EventDetailModal
          event={viewingEvent}
          onClose={() => setViewingEvent(null)}
          onEdit={(isSecurity || isPropertyManagement) ? (ev) => { setEditingEvent(ev); setViewingEvent(null); setCreateEventOpen(true); } : null}
          onDelete={(isSecurity || isPropertyManagement) ? (ev, noticeId) => deleteCalendarEventMutation.mutate({ id: ev.id, noticeId }) : null}
          onComplete={(isSecurity || isPropertyManagement) ? (ev) => completeCalendarEventMutation.mutate(ev) : null}
        />
      )}

      {syncPrompt && (
        <EventSyncPrompt
          open={!!syncPrompt}
          onClose={() => setSyncPrompt(null)}
          onUpdateNotice={() => handleSyncPromptUpdate(true)}
          onSkip={() => handleSyncPromptUpdate(false)}
        />
      )}

      {selectedAgendaItem && (
        <Dialog open={!!selectedAgendaItem} onOpenChange={() => setSelectedAgendaItem(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Badge className={
                  selectedAgendaItem.itemType === 'move' ? 'bg-blue-600' :
                  selectedAgendaItem.itemType === 'event' ? 'bg-orange-600' :
                  selectedAgendaItem.itemType === 'task' ? 'bg-purple-600' : 'bg-red-600'
                }>
                  {selectedAgendaItem.itemType.toUpperCase()}
                </Badge>
                <span className={selectedAgendaItem.status === 'completed' ? 'line-through text-zinc-500' : ''}>{selectedAgendaItem.title}</span>
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              {selectedAgendaItem.timeWindow && <div><p className="text-xs font-medium text-zinc-500">Time</p><p className="text-sm">{selectedAgendaItem.timeWindow}</p></div>}
              {selectedAgendaItem.location && <div><p className="text-xs font-medium text-zinc-500">Location</p><p className="text-sm">{selectedAgendaItem.location}</p></div>}
              {selectedAgendaItem.notes && <div><p className="text-xs font-medium text-zinc-500">Details</p><p className="text-sm text-zinc-700 whitespace-pre-wrap">{selectedAgendaItem.notes}</p></div>}
              {selectedAgendaItem.status !== 'completed' && (
                <Button onClick={() => completeItemMutation.mutate(selectedAgendaItem)} className="w-full">
                  <CheckCircle2 className="w-4 h-4 mr-2" /> Mark as Complete
                </Button>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}