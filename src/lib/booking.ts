// Booking.com has no public API; we link to its search, pre-filled with the place and dates.
export function bookingSearchUrl(query: string, checkin?: string, nights = 1): string {
  const url = new URL('https://www.booking.com/searchresults.fr.html');
  url.searchParams.set('ss', query);
  if (checkin) {
    const out = new Date(`${checkin}T12:00:00Z`);
    out.setUTCDate(out.getUTCDate() + nights);
    url.searchParams.set('checkin', checkin);
    url.searchParams.set('checkout', out.toISOString().slice(0, 10));
  }
  url.searchParams.set('group_adults', '2');
  url.searchParams.set('no_rooms', '1');
  url.searchParams.set('group_children', '0');
  return url.toString();
}
