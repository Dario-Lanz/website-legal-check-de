// Date and time in Europe/Berlin as the reports show them (TT.MM.JJJJ, HH:MM).

const FORMAT = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** @param {string|number|Date} when ISO timestamp, epoch ms or Date. @returns {{date: string, time: string}|null} null if unparsable. */
export function berlinDateTime(when) {
  if (when === null || when === undefined || when === '') return null;
  const d = new Date(when);
  if (Number.isNaN(d.getTime())) return null;
  const p = Object.fromEntries(FORMAT.formatToParts(d).map((part) => [part.type, part.value]));
  return { date: `${p.day}.${p.month}.${p.year}`, time: `${p.hour}:${p.minute}` };
}
