function formatValue(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(formatValue).filter(Boolean).join('; ');
  if (value && typeof value === 'object') {
    const objectValue = value;
    if (Array.isArray(objectValue.loc) && typeof objectValue.msg === 'string') {
      const location = objectValue.loc.filter((part) => part !== 'body').join('.');
      return location ? `${location}: ${objectValue.msg}` : objectValue.msg;
    }
    for (const key of ['detail', 'message', 'msg', 'reason']) {
      if (objectValue[key] !== undefined) return formatValue(objectValue[key]);
    }
    try { return JSON.stringify(value); } catch { return 'The server returned an unreadable error.'; }
  }
  return value === undefined || value === null ? '' : String(value);
}

export function formatApiError(payload) {
  return formatValue(payload?.error?.message ?? payload?.detail ?? payload?.message ?? payload);
}
