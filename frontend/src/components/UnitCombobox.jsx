import React, { useState, useMemo } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export default function UnitCombobox({ units, value, onChange, placeholder = "Select unit...", disabled = false }) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const filteredAndSortedUnits = useMemo(() => {
    if (!searchQuery) {
      return units.sort((a, b) => {
        if (a.floor !== b.floor) return a.floor - b.floor;
        return parseInt(a.unit_number) - parseInt(b.unit_number);
      });
    }

    const query = searchQuery.toLowerCase().trim();
    const numericQuery = parseInt(query);

    // Filter units that match
    const matches = units.filter(unit => {
      const unitNum = unit.unit_number.toString();
      const display = unit.display_unit.toLowerCase();
      return unitNum.includes(query) || display.includes(query);
    });

    // Sort by numeric closeness
    return matches.sort((a, b) => {
      const aNum = parseInt(a.unit_number);
      const bNum = parseInt(b.unit_number);

      // If query is numeric, prioritize exact prefix matches, then numeric closeness
      if (!isNaN(numericQuery)) {
        const aStr = a.unit_number.toString();
        const bStr = b.unit_number.toString();
        
        // Exact prefix match gets highest priority
        const aStartsWith = aStr.startsWith(query);
        const bStartsWith = bStr.startsWith(query);
        
        if (aStartsWith && !bStartsWith) return -1;
        if (!aStartsWith && bStartsWith) return 1;
        
        // Then sort by numeric distance
        const aDist = Math.abs(aNum - numericQuery);
        const bDist = Math.abs(bNum - numericQuery);
        
        if (aDist !== bDist) return aDist - bDist;
      }

      // Default: sort by floor then unit number
      if (a.floor !== b.floor) return a.floor - b.floor;
      return aNum - bNum;
    });
  }, [units, searchQuery]);

  const selectedUnit = units.find(u => u.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-12 w-full justify-between"
          disabled={disabled}
        >
          {selectedUnit ? selectedUnit.display_unit : placeholder}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-full p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput 
            placeholder="Type to search (e.g., 1314)..." 
            value={searchQuery}
            onValueChange={setSearchQuery}
          />
          <CommandEmpty>No units found.</CommandEmpty>
          <CommandGroup className="max-h-[300px] overflow-auto">
            {filteredAndSortedUnits.slice(0, 50).map((unit) => (
              <CommandItem
                key={unit.id}
                value={unit.id}
                onSelect={() => {
                  onChange(unit.id);
                  setOpen(false);
                  setSearchQuery('');
                }}
              >
                <Check
                  className={cn(
                    "mr-2 h-4 w-4",
                    value === unit.id ? "opacity-100" : "opacity-0"
                  )}
                />
                {unit.display_unit}
              </CommandItem>
            ))}
          </CommandGroup>
        </Command>
      </PopoverContent>
    </Popover>
  );
}