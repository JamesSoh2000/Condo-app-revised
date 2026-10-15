import React, { useState, useRef, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Bot, Send, Sparkles, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { useLanguage } from '@/lib/LanguageContext';

export default function Concierge() {
  const { t } = useLanguage();
  const [messages, setMessages] = useState([
    { role: 'assistant', content: "Hello! I'm your AI Concierge. I can help with building procedures, maintenance requests, or amenities. How can I assist you today?" }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim()) return;

    const userMsg = { role: 'user', content: input };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);

    try {
        // Simulated AI response logic (In production use InvokeLLM)
        const res = await base44.integrations.Core.InvokeLLM({
            prompt: `You are a helpful concierge for a luxury condo called EstWest.
            User query: "${input}".

            CORE INSTRUCTIONS:
            - Be polite, elegant, and concise.
            - Answer based on the Building Regulations below.
            - If the answer is not in the regulations, provide general helpful advice or suggest contacting management.
            - If it's about parking/noise violations, suggest reporting to Security via the app.
            - If it's about maintenance issues, suggest submitting a Maintenance Request via the app.
            - If it's about amenities, mention the Gameroom or Speakeasy sections of the app.
            - Keep responses helpful but concise (under 3-4 sentences unless detailed explanation is needed).

            BUILDING REGULATIONS SUMMARY:
            Rules Concerning Private Areas (Condos):
            1. Short-term rentals (< 6 months) are strictly forbidden.
            2. Excessive noise disturbing neighbors is prohibited.
            3. Shut off main water valve if away for > 1 week.
            4. Close windows/doors when away.
            5. Maintain min temp of 16°C (61°F).
            6. Only domestic pets allowed; nuisance animals prohibited.
            7. Pets must be leashed in common areas; clean up waste immediately.
            8. Residents liable for damage to common areas.
            9. Do not hang anything from sprinkler heads.
            10. Smoking inside depends on owner, but air purifier is mandatory. No smoking in common areas. Cigarette butts must be disposed of safely.
            11. Residents responsible for guests' compliance.
            12. Hazardous/flammable substances prohibited.
            13. Cannabis consumption/cultivation prohibited everywhere.
            14. Propane tanks prohibited (except transport).
            15. Appliances (washers/dishwashers) must be installed by certified plumbers; notify Syndicate.
            16. Report/fix leaks immediately.
            17. "Drano" and chemical drain cleaners prohibited.
            18. Leaks must be resolved immediately.
            19. Liability insurance ($2M) mandatory for owners and tenants.

            Rules Concerning Common Areas:
            1. Liable for damages by self/guests.
            2. Do not obstruct hallways/landings. No storage in common areas.
            3. No pets left in common areas.
            4. Comply with all regulations.
            5. Smoking/vaping strictly prohibited in all common areas (interior/exterior), including balconies/terraces.
            6. Responsible for misuse damage.
            7. The exterior of any private unit, including its front door, may not be decorated in any way.
            8. Garbage must be sealed and placed in bins (not on floor). No large items in chutes.
            9. Deliveries: Announce to security 24h in advance (Mon-Sat 8am-9pm).
            10. Moves: Announce 7 days in advance ($50 fee + $500 deposit).
            11. Information form required for registry/intercom.
            12. Respect others in recreational facilities.
            13. Park only in your designated spot. No charging at others' stations.
            14. Residents responsible for guests in common areas.
            15. GUEST LIMIT: Maximum 3 visitors per unit allowed in all common areas (pool, lounges, gameroom, etc.).
            16. NO ALCOHOL: Alcohol is strictly prohibited in ALL common areas including pool, lounges, and gameroom.
            17. NO FILMING: Filming, recording, or photography is strictly prohibited in all common areas.
            18. NO GLASS: Glass containers are strictly prohibited in all common areas.
            19. NO EATING BY POOLS: Eating is strictly prohibited in both pool areas (indoor and outdoor).
            20. NO EATING IN GAMEROOM: Eating is strictly prohibited in the gameroom. Residents must eat in the table areas in the lounges or inside their units.
            21. INDOOR POOL FOOTWEAR: Residents must remove shoes and boots in the locker room before entering the indoor pool area.

            IMPORTANT: When informing residents about rules, always remind them that failure to follow building rules can result in fines (see FINES & PENALTIES section below).

            Rules for Balconies, Loggias, and Terraces:
            1. Railings must be kept free (no flowerpots).
            2. No clotheslines or drying racks.
            3. Only patio furniture and compliant BBQs allowed.
            4. Charcoal BBQs prohibited.
            5. Water plants/clean carefully to avoid runoff below.
            6. No trash/recycling on balconies.
            7. Pets not allowed unattended or to relieve themselves on balconies.
            8. Throwing objects/liquids off balconies strictly prohibited.

            IMPORTANT CONTACTS:
            - Security: (438) 543-5998 (available 24/7)
            - Building Management: Richard Dubé, 514-987-6000, administration@estwest.ca (Mon-Fri, 8am-4pm)
            - Emergency (e.g., water damage, fire) outside regular hours: Richard Dubé at 514-987-6000. Note: Service fees apply if not a true emergency.

            FINES & PENALTIES:
            - Violation of building rules: 1st offense $250, 2nd $500, Subsequent $750.
            - Short-term rentals (<6 months): 1st offense $1,000, Subsequent $1,500.

            BUILDING LAYOUT:
            - Gameroom is located in the EST Tower on the 3rd floor
            - EST Tower Lounge: 29th floor
            - WEST Tower Lounge: 30th floor
            - All reservation rooms (Speakeasy, TV Rooms, Living/Dining Room) are in the WEST Tower

            AMENITY RENTAL RATES & RULES:
            - RENTABLE ROOMS: Speakeasy, TV Room (2nd floor), TV Room (3rd floor), and Living/Dining Room (3rd floor) ONLY. All other rooms are common areas and not for rent.
            - RATES:
              * Speakeasy (2nd floor): $250 ($150 for owners)/4 hours, security deposit $1000, max 20 people.
              * TV Room (2nd floor): $50/4 hours, security deposit $500, max 10 people.
              * TV Room (3rd floor): $50/4 hours, security deposit $500, max 10 people.
              * Living and Dining Room (3rd floor): $50/4 hours, security deposit $500, max 10 people.

            RENTAL REGULATIONS:
            - Duration: Stated price is for max 4 hours. Additional hours: $50/hour.
            - Curfew: ALL AMENITIES CLOSE AT 11:00 PM SHARP (23:00). All residents must be OUT of amenity areas by 11pm. No extensions.
            - Payment: Security deposit payable via Debit (Interac) at security. Returned within 7 days after inspection.
            - Cleaning: Room must be returned clean and in original condition. Cleaning costs deducted from deposit if needed.
            - Inspection: Pre-inspection with photos required with renter present.
            - Guests:
              * Must whisper in hallways (2nd/3rd floors).
              * Max capacity strict. Extra person fee: $20/person.
              * Guests restricted to rented room only. Walking around/common areas off-limits. Fine: $250.
            - Prohibitions:
              * Smoking/Vaping (cigarettes/marijuana) prohibited. Fine: $1000.
              * Excessively loud music, DJs, or bands prohibited.
              * Commercial activities prohibited.
            - Security has authority to inspect at any time and end non-compliant events.`,
        });

        setMessages(prev => [...prev, { role: 'assistant', content: res }]);
    } catch (e) {
        setMessages(prev => [...prev, { role: 'assistant', content: "I'm having trouble connecting right now. Please try again later." }]);
    } finally {
        setIsLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto h-[calc(100vh-120px)] flex flex-col">
      <div className="text-center mb-6">
        <div className="w-12 h-12 bg-gradient-to-tr from-zinc-900 to-zinc-700 rounded-2xl flex items-center justify-center mx-auto mb-3 shadow-lg">
            <Sparkles className="w-6 h-6 text-white" />
        </div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-black">{t('AI Concierge')}</h1>
        <p className="text-zinc-500 dark:text-zinc-400 text-sm">{t('Your AI-powered building concierge')}</p>
      </div>

      <Card className="flex-1 flex flex-col overflow-hidden border-zinc-200 dark:border-zinc-700 shadow-2xl bg-white/80 dark:bg-zinc-900/90 backdrop-blur-sm">
        <ScrollArea className="flex-1 p-4" ref={scrollRef}>
            <div className="space-y-4">
                {messages.map((m, i) => (
                    <motion.div
                        key={i}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className={`flex gap-3 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                        {m.role === 'assistant' && (
                            <div className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center border border-zinc-200 dark:border-zinc-700 flex-shrink-0">
                                 <Bot className="w-4 h-4 text-zinc-600 dark:text-zinc-400" />
                             </div>
                            )}
                            <div className={`max-w-[80%] px-4 py-3 rounded-2xl text-sm leading-relaxed shadow-sm ${
                             m.role === 'user'
                             ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-br-none'
                             : 'bg-white dark:bg-zinc-800 border border-zinc-100 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 rounded-bl-none'
                            }`}>
                            {m.content}
                        </div>
                    </motion.div>
                ))}
                {isLoading && (
                    <div className="flex gap-3">
                         <div className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center border border-zinc-200 dark:border-zinc-700">
                                <Bot className="w-4 h-4 text-zinc-600 dark:text-zinc-400" />
                             </div>
                             <div className="bg-white dark:bg-zinc-800 border border-zinc-100 dark:border-zinc-700 px-4 py-3 rounded-2xl rounded-bl-none shadow-sm">
                            <Loader2 className="w-4 h-4 animate-spin text-zinc-400" />
                        </div>
                    </div>
                )}
            </div>
        </ScrollArea>

        <div className="p-4 bg-zinc-50 dark:bg-zinc-800/50 border-t border-zinc-100 dark:border-zinc-700">
            <form
                onSubmit={(e) => { e.preventDefault(); handleSend(); }}
                className="flex gap-2"
            >
                <Input
                    placeholder={t('Type your message...')}
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    className="bg-white dark:bg-zinc-800 dark:border-zinc-600 dark:text-zinc-100 dark:placeholder-zinc-500 border-zinc-200 focus-visible:ring-zinc-400"
                />
                <Button type="submit" className="bg-zinc-900 hover:bg-zinc-800" disabled={!input.trim() || isLoading}>
                    <Send className="w-4 h-4" />
                </Button>
            </form>
        </div>
      </Card>
    </div>
  );
}
