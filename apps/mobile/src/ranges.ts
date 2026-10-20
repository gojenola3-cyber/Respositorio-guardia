export type View3 = 'day' | 'week' | 'month';

/** Rango [inicio, fin) de la vista diaria, semanal (lunes) o mensual. */
export function viewRange(view: View3, anchor: Date) {
  const start = new Date(anchor);
  start.setHours(0, 0, 0, 0);
  if (view === 'week') start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  if (view === 'month') start.setDate(1);
  const end = new Date(start);
  if (view === 'day') end.setDate(end.getDate() + 1);
  if (view === 'week') end.setDate(end.getDate() + 7);
  if (view === 'month') end.setMonth(end.getMonth() + 1);
  return { start, end };
}

export function shift(view: View3, anchor: Date, dir: number) {
  const a = new Date(anchor);
  if (view === 'day') a.setDate(a.getDate() + dir);
  if (view === 'week') a.setDate(a.getDate() + 7 * dir);
  if (view === 'month') a.setMonth(a.getMonth() + dir);
  return a;
}
