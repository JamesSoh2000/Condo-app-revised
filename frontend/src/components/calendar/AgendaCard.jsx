import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Truck, Calendar, AlertCircle, CheckCircle2, Clock, Wine } from 'lucide-react';

export default function AgendaCard({ item, onMarkComplete, onCardClick }) {
  const getConfig = () => {
    switch (item.itemType) {
      case 'move':
        return { bg: '#dbeafe', border: '#93c5fd', label: 'MOVE', labelClass: 'bg-blue-600 text-white', icon: Truck };
      case 'event':
        return { bg: '#ffedd5', border: '#fdba74', label: 'EVENT', labelClass: 'bg-orange-600 text-white', icon: Calendar };
      case 'task':
        return { bg: '#f3e8ff', border: '#c084fc', label: 'TASK', labelClass: 'bg-purple-600 text-white', icon: CheckCircle2 };
      case 'incident':
        return { bg: '#fee2e2', border: '#fca5a5', label: 'INCIDENT', labelClass: 'bg-red-600 text-white', icon: AlertCircle };
      case 'speakeasy':
        return { bg: '#dcfce7', border: '#4ade80', label: 'SPEAKEASY', labelClass: 'bg-green-600 text-white', icon: Wine };
      default:
        return { bg: '#f4f4f5', border: '#d4d4d8', label: 'OTHER', labelClass: 'bg-zinc-600 text-white', icon: Calendar };
    }
  };

  const config = getConfig();
  const Icon = config.icon;
  const isCompleted = item.status === 'completed';

  return (
    <Card
      className={`border-2 hover:shadow-md transition-all ${isCompleted ? 'opacity-60' : ''} ${item.itemType === 'task' && item.canComplete && !isCompleted ? '' : 'cursor-pointer'}`}
      style={{ backgroundColor: config.bg, borderColor: config.border }}
      onClick={() => !item.canComplete && onCardClick && onCardClick(item)}
    >
      <CardContent className="p-3">
        <div className="flex items-start gap-2 mb-2">
          <Badge className={`${config.labelClass} text-xs px-2 py-0.5`}>
            {config.label}
          </Badge>
          {item.statusBadge && (
            <Badge variant="outline" className="text-xs">
              {item.statusBadge}
            </Badge>
          )}
          {isCompleted && (
            <Badge className="bg-green-100 text-green-700 text-xs ml-auto">
              Completed
            </Badge>
          )}
        </div>

        <div className="flex items-start gap-2">
          <Icon className="w-4 h-4 flex-shrink-0 mt-0.5 text-zinc-600" />
          <div className="flex-1">
            <h4 className={`font-semibold text-sm ${isCompleted ? 'line-through text-zinc-500' : ''}`}>
              {item.title}
            </h4>
            
            {item.timeWindow && (
              <div className="flex items-center gap-1 text-xs text-zinc-600 mt-1">
                <Clock className="w-3 h-3" />
                {item.timeWindow}
              </div>
            )}

            {item.location && (
              <p className="text-xs text-zinc-500 mt-1">{item.location}</p>
            )}

            {item.notes && (
              <p className="text-xs text-zinc-600 mt-1 line-clamp-2">{item.notes}</p>
            )}
          </div>

          {item.itemType === 'task' && item.canComplete && !isCompleted && (
            <div onClick={(e) => e.stopPropagation()}>
              <Checkbox
                checked={false}
                onCheckedChange={() => onMarkComplete && onMarkComplete(item)}
                className="mt-1"
              />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}