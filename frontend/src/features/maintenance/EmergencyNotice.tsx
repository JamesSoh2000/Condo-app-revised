// A number and nothing else: digits with an optional leading `+`, and the spaces, brackets, dots and dashes people
// write between them. The phone is free text (P6-03e, at most 32 printable characters), so an extension (";ext=123",
// "x123", "#2") or words would change the number a link dials (review round 1 F1): those are shown as text only.
const DIALLABLE = /^\+?[\d\s().-]*\d[\d\s().-]*$/;

function Phone({ phone }: { phone: string }) {
  if (!DIALLABLE.test(phone.trim())) return <span className="font-semibold">{phone}</span>;
  return (
    <a href={`tel:${phone.replace(/[^+\d]/g, '')}`} className="font-semibold underline">
      {phone}
    </a>
  );
}

/**
 * The emergency category's safety text (P6-04b criterion 6; P6-03b criterion 7). Filing a request alerts no one, so
 * the text only ever says to call, and never that anyone was told. Before submit there is no phone to give (the API
 * returns it only on the emergency request it created); after the 201, `phone` is the response's `emergency_phone`,
 * null when the building has none. P6-04c reuses it on the request view.
 */
export function EmergencyNotice({ submitted = false, phone = null }: { submitted?: boolean; phone?: string | null }) {
  let text;
  if (!submitted) text = 'This request alerts no one. If this is an emergency, call the emergency services or building staff now.';
  else if (phone === null) {
    text = 'Your request was submitted, but it alerts no one. If this is an emergency, call the emergency services and building staff directly, now.';
  } else {
    text = (
      <>
        Your request was submitted, but it alerts no one. If this is an emergency, call the emergency services, or building
        staff at <Phone phone={phone} />, now.
      </>
    );
  }
  return (
    <p data-testid="emergency-notice" className="rounded border border-red-300 bg-red-50 p-3 text-sm font-medium text-red-900">
      {text}
    </p>
  );
}
