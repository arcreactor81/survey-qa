// HTML escaping, in its own module so the view renderers can share it without
// importing each other. Every string that came from a record goes through this:
// DOM excerpts and questionnaire quotes render as inert text, never as markup.

export function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
