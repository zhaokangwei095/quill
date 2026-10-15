/**
 * Display formatting for the workbench.
 *
 * Kept separate from the core package because the core has no opinion about
 * presentation and must stay usable in the service worker, where `Intl` for
 * relative time is unnecessary weight.
 */

export function relativeTime(at: number, now = Date.now()): string {
  const diff = now - at;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return formatDate(at);
}

export function formatDate(at: number | undefined): string {
  if (!at) return "";
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatDateTime(at: number | undefined): string {
  if (!at) return "";
  const date = new Date(at);
  return `${formatDate(at)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** "5" -> "5 天" / "今天" / "已过期 3 天" */
export function deadlineLabel(at: number, now = Date.now()): string {
  const days = Math.ceil((at - now) / (24 * 60 * 60 * 1000));
  if (days < 0) return `已过期 ${Math.abs(days)} 天`;
  if (days === 0) return "今天";
  if (days === 1) return "明天";
  return `${days} 天后`;
}

/** A percentage with no false precision. */
export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Trim a long string for a preview line. */
export function excerpt(text: string, limit = 120): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

/**
 * Copy text, with a fallback for contexts where the async clipboard API is
 * unavailable (some extension pages without a user-gesture chain).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Download a string as a file, cleaning up the object URL afterwards. */
export function downloadFile(filename: string, content: string, mime = "text/plain;charset=utf-8"): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
