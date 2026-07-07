/**
 * Inject a <style> element into document.head, idempotent by id.
 * Returns true if the style was newly created, false if it already existed.
 */
export function injectStyle(id: string, css: string): boolean {
  if (document.getElementById(id)) return false;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
  return true;
}
