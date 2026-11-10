import 'server-only';
import { formatDate, formatDateTime, getConfig, localDateString, localDateTimeInput } from '@bluven/core';

const tz = () => getConfig().timeZone;

/** "9 Nov 2026" in the business time zone. */
export const fmtDate = (d: Date | null | undefined) => formatDate(d, tz());
/** "9 Nov 2026, 2:05 pm" in the business time zone. */
export const fmtDateTime = (d: Date | null | undefined) => formatDateTime(d, tz());
/** Value for <input type="datetime-local">. */
export const inputDateTime = (d: Date) => localDateTimeInput(d, tz());
/** Value for <input type="date"> of an instant. */
export const inputDate = (d: Date) => localDateString(d, tz());
